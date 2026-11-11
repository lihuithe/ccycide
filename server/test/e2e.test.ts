import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionStatus } from '../src/db/repos/index.js';
import { RelayConn, SignalClient, registerNew } from '../tools/rterm-client.js';
import { freePort, onlineDevice, sleep, startStack, until } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('端到端：注册 → 认证 → 连接 → 中继互发 → 会话记录', () => {
  it('完整链路，sessions 表状态依次推进，字节数由中继回传写入，同时会话计数释放', async () => {
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      const goP = host.sig.acceptGo(inc.session_id);
      const res = await resP;
      if (!res.ok) throw new Error(res.code);

      const [hRelay, cRelay] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
      // 配对后状态为 2（由中继事件推进）
      await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Paired, 3000, '状态 2');

      const a = randomBytes(3000);
      const b = randomBytes(7000);
      await cRelay.send(a);
      await hRelay.send(b);
      await Promise.all([hRelay.waitCount(1), cRelay.waitCount(1)]);
      expect(hRelay.received[0]!.equals(a)).toBe(true);
      expect(cRelay.received[0]!.equals(b)).toBe(true);

      host.sig.report(inc.session_id, 'auth_ok');
      await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Authed, 3000, '状态 3');

      cRelay.close();
      expect(await hRelay.closed).toBe(4003);
      await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Ended, 3000, '状态 4');
      const row = (await s.repos.sessions.get(inc.session_id))!;
      expect(row.bytesC2h).toBe(3000);
      expect(row.bytesH2c).toBe(7000);
      expect(row.endedAt).not.toBeNull();
      expect(row.authedAt).not.toBeNull();
      await until(async () => (await s.stores.tracker.count(host.identity.deviceId)) === 0, 2000, '会话计数释放');
    } finally {
      await s.stop();
    }
  });

  it('连接成功但没有走完密码验证就断开：会话记为失败(closed_before_auth)，仍记录字节数', async () => {
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      const goP = host.sig.acceptGo(inc.session_id);
      const res = await resP;
      if (!res.ok) throw new Error(res.code);
      const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
      await c.send(randomBytes(100));
      await h.waitCount(1);
      h.close();
      await c.closed;
      await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Failed, 3000, '状态 5');
      expect(await s.repos.sessions.get(inc.session_id)).toMatchObject({ failReason: 'closed_before_auth', bytesC2h: 100 });
    } finally {
      await s.stop();
    }
  });

  it('只有主控端连上中继、被控端没来：配对超时，会话记为失败(pair_timeout)', async () => {
    const s = await startStack({ tunables: { pairTimeoutMs: 300 } });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      host.sig.accept(inc.session_id);
      const res = await resP;
      if (!res.ok) throw new Error(res.code);
      const c = await RelayConn.connect(res.data.relay_url, res.data.ticket);
      expect(await c.closed).toBe(4002);
      await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Failed, 3000, '状态 5');
      expect((await s.repos.sessions.get(inc.session_id))!.failReason).toBe('pair_timeout');
      const metrics = await (await fetch(`${s.relayUrl.replace('ws', 'http')}/metrics`)).text();
      expect(metrics).toMatch(/rterm_relay_pair_timeouts_total [1-9]/);
    } finally {
      await s.stop();
    }
  });

  it('被控端 5 次密码失败 -> 主控端收到 LOCKED，被控端自己的信令不受影响（演示 T30 全链路）', async () => {
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      for (let i = 0; i < 5; i++) {
        const incP = host.sig.waitIncoming();
        const resP = ctl.sig.connectRequest(host.identity.deviceCode);
        const inc = await incP;
        host.sig.accept(inc.session_id);
        await resP;
        host.sig.report(inc.session_id, 'auth_failed');
      }
      await until(async () => (await s.ctx.guard.getLock(host.identity.deviceCode)) !== null, 3000, '锁定');
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'LOCKED' });
      await host.sig.ping();
    } finally {
      await s.stop();
    }
  });
});

describe('dev:all 单进程联调模式（子进程实测）', () => {
  let child: ChildProcess | null = null;
  afterAll(() => {
    child?.kill();
  });

  it('npm run dev:all 等价的入口：STORE=memory 启动，healthz / config 可用，测试客户端 demo 跑通', async () => {
    const port = await freePort();
    const relayPort = await freePort();
    const logs: string[] = [];
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main-dev.ts'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), RELAY_PORT: String(relayPort), RELAY_PUBLIC_URL: `ws://127.0.0.1:${relayPort}`, HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => logs.push(String(d)));
    child.stderr!.on('data', (d) => logs.push(String(d)));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/v1/healthz`)).ok) break;
      } catch {
        /* 等待启动 */
      }
      if (Date.now() > deadline) throw new Error(`dev:all 没有启动：${logs.join('')}`);
      await sleep(100);
    }
    expect(await (await fetch(`http://127.0.0.1:${relayPort}/healthz`)).json()).toEqual({ ok: true });
    const cfg = (await (await fetch(`http://127.0.0.1:${port}/v1/config`)).json()) as { signal_url: string; adapters: unknown[] };
    expect(cfg.signal_url).toBe(`ws://127.0.0.1:${port}/v1/signal`);
    expect(cfg.adapters).toHaveLength(2);

    // 用命令行 demo 跑完整链路
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'tools/rterm-client.ts', 'demo', '--http', `http://127.0.0.1:${port}`, '--delay-sec', '1'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toContain('演示通过');
    expect(r.status).toBe(0);

    // 再用库直接验证：dev:all 里信令和中继共享存储，节点已在注册表登记
    const a = await registerNew(`http://127.0.0.1:${port}`);
    const b = await registerNew(`http://127.0.0.1:${port}`);
    const sa = await SignalClient.connect(`ws://127.0.0.1:${port}/v1/signal`, a.identity);
    const sb = await SignalClient.connect(`ws://127.0.0.1:${port}/v1/signal`, b.identity);
    const incP = sa.waitIncoming();
    const resP = sb.connectRequest(a.identity.deviceCode);
    sa.accept((await incP).session_id);
    const res = await resP;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.relay_url).toBe(`ws://127.0.0.1:${relayPort}`);
    sa.close();
    sb.close();
  }, 60_000);
});
