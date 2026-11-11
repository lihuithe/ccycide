import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '../src/crypto.js';
import { signTicket } from '../src/relay/ticket.js';
import { RelayConn } from '../tools/rterm-client.js';
import { freePort, sleep } from './helpers.js';

/*
 * T6 最后一条（必须做）：一端高速发送，另一端故意不读，中继进程内存必须稳定。
 * 中继放在独立子进程里，才能单独量它的内存（同进程测会把发送方的缓冲也算进去）。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'backpressure-test-secret-0123456789';

let child: ChildProcess;
let port = 0;
const logs: string[] = [];

async function rssMB(): Promise<number> {
  const t = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  const m = /^process_resident_memory_bytes (\d+)/m.exec(t);
  return Number(m![1]) / 1024 / 1024;
}

beforeAll(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['--import', 'tsx', 'src/main-relay.ts'], {
    cwd: root,
    env: {
      ...process.env,
      STORE: 'memory',
      PORT: String(port),
      HOST: '127.0.0.1',
      TICKET_SECRET: SECRET,
      RELAY_NODE_NAME: 'relay-bp',
      RELAY_PUBLIC_URL: `ws://127.0.0.1:${port}`,
      // 关闭带宽限速，单独验证背压
      SESSION_BYTES_PER_SEC: '4000000000',
      SESSION_BURST_BYTES: '4000000000',
      DAILY_QUOTA_BYTES: '1000000000000',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => logs.push(String(d)));
  child.stderr!.on('data', (d) => logs.push(String(d)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`中继子进程没有启动：${logs.join('')}`);
    await sleep(100);
  }
}, 30_000);

afterAll(() => {
  child?.kill();
});

describe('中继背压：一端高速发送，另一端不读', () => {
  it('中继内存稳定，发送方被 TCP 流控挡住；对端恢复读取后数据一个不丢、顺序不变', async () => {
    const sid = newUlid();
    const t = (role: 'c' | 'h') => signTicket({ sid, role, did: `bp-${role}`, node: 'relay-bp' }, SECRET, 30);
    const [c, h] = await Promise.all([RelayConn.connect(`ws://127.0.0.1:${port}`, t('c')), RelayConn.connect(`ws://127.0.0.1:${port}`, t('h'))]);

    // 接收方：记录收到的块序号，先暂停读取（模拟网络很慢 / 对端卡死）
    let nextSeq = 0;
    let receivedBytes = 0;
    let outOfOrder = false;
    h.ws.removeAllListeners('message');
    h.ws.on('message', (data: Buffer) => {
      const seq = data.readUInt32BE(0);
      if (seq !== nextSeq) outOfOrder = true;
      nextSeq = seq + 1;
      receivedBytes += data.length;
    });
    h.ws.pause();

    const baseline = await rssMB();
    const CHUNK = 64 * 1024;
    const ATTEMPT_TOTAL = 800 * 1024 * 1024; // 打算发 800MB
    let seq = 0;
    let completedBytes = 0;
    let stopped = false;
    const sender = (async () => {
      while (!stopped && seq * CHUNK < ATTEMPT_TOTAL) {
        const buf = Buffer.allocUnsafe(CHUNK);
        buf.writeUInt32BE(seq, 0);
        await new Promise<void>((resolve, reject) => c.ws.send(buf, { binary: true }, (e) => (e ? reject(e) : resolve())));
        seq++;
        completedBytes += CHUNK;
      }
    })().catch(() => {});

    // 前 3 秒让缓冲区填满，再观察 6 秒
    await sleep(3000);
    const sentAt3s = completedBytes;
    const rss3 = await rssMB();
    let maxRss = rss3;
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      maxRss = Math.max(maxRss, await rssMB());
    }
    const sentAt9s = completedBytes;
    const rss9 = await rssMB();
    console.log(
      `[背压] 中继 RSS：基线 ${baseline.toFixed(1)}MB，3s ${rss3.toFixed(1)}MB，9s ${rss9.toFixed(1)}MB，峰值 ${maxRss.toFixed(1)}MB；` +
        `发送方在 3s/9s 时累计写入 ${(sentAt3s / 1048576).toFixed(1)}MB / ${(sentAt9s / 1048576).toFixed(1)}MB（打算发 800MB）`,
    );

    // 1) 发送方被流控挡住：9 秒里只写进去很少一部分，远小于打算发的 800MB
    expect(sentAt9s).toBeLessThan(200 * 1024 * 1024);
    // 2) 后 6 秒几乎不再增长（已经堵死）
    expect(sentAt9s - sentAt3s).toBeLessThan(20 * 1024 * 1024);
    // 3) 中继内存不持续增长：峰值相对基线增长有限，且后半段不再上涨
    expect(maxRss - baseline).toBeLessThan(80);
    expect(rss9 - rss3).toBeLessThan(25);

    // 4) 对端恢复读取：积压的数据继续送达，且一个不丢、顺序不变
    h.ws.resume();
    const resumeFrom = receivedBytes;
    await sleep(1500);
    expect(receivedBytes).toBeGreaterThan(resumeFrom);
    stopped = true;
    // 等发送循环中最后一条完成，再等接收方收齐
    await Promise.race([sender, sleep(5000)]);
    const total = seq;
    const deadline = Date.now() + 20_000;
    while (nextSeq < total && Date.now() < deadline) await sleep(50);
    expect(outOfOrder).toBe(false);
    expect(nextSeq).toBe(total);
    expect(receivedBytes).toBe(total * CHUNK);

    c.close();
    h.close();
  }, 90_000);
});
