import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { newUlid } from '../src/crypto.js';
import { signTicket, type Ticket } from '../src/relay/ticket.js';
import { RelayConn } from '../tools/rterm-client.js';
import { sleep, startStack, until, type Stack } from './helpers.js';

function tk(s: Stack, over: Partial<Omit<Ticket, 'exp'>> & { sid: string; secret?: string; ttl?: number; now?: number }): string {
  return signTicket(
    { sid: over.sid, role: over.role ?? 'c', did: over.did ?? `dev-${over.role ?? 'c'}`, node: over.node ?? 'relay-test' },
    over.secret ?? s.cfg.ticketSecret,
    over.ttl ?? 30,
    over.now,
  );
}

async function pairUp(s: Stack, sid = newUlid(), dids: { c?: string; h?: string } = {}) {
  const [c, h] = await Promise.all([
    RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'c', did: dids.c ?? `c-${sid}` })),
    RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'h', did: dids.h ?? `h-${sid}` })),
  ]);
  return { sid, c, h };
}

const rndMsg = (min: number, max: number): Buffer => randomBytes(min + Math.floor(Math.random() * (max - min + 1)));

describe('中继：票据、配对、转发（T6）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ tunables: { sessionBytesPerSec: 500 * 1024 * 1024, sessionBurstBytes: 500 * 1024 * 1024 } });
  });
  afterAll(() => s.stop());

  it('两端用合法票据连上：一端发二进制消息，另一端原样收到，顺序不变', async () => {
    const { c, h } = await pairUp(s);
    for (let i = 0; i < 50; i++) await c.send(Buffer.from([i, i + 1, i + 2]));
    await h.waitCount(50);
    h.received.forEach((m, i) => expect([...m]).toEqual([i, i + 1, i + 2]));
    await h.send(Buffer.from('反向'));
    await c.waitCount(1);
    expect(c.received[0]!.toString()).toBe('反向');
    c.close();
    h.close();
  });

  it('发 1000 条随机内容、随机长度（1 字节到 64KB）的消息：全部收到，逐字节相同，顺序不变', async () => {
    const { c, h } = await pairUp(s);
    const sent: Buffer[] = [];
    const sentBack: Buffer[] = [];
    for (let i = 0; i < 1000; i++) {
      const m = rndMsg(1, 64 * 1024);
      sent.push(m);
      void c.send(m);
      if (i % 5 === 0) {
        const b = rndMsg(1, 64 * 1024);
        sentBack.push(b);
        void h.send(b);
      }
    }
    await h.waitCount(1000, 30_000);
    await c.waitCount(sentBack.length, 30_000);
    expect(h.received).toHaveLength(1000);
    for (let i = 0; i < 1000; i++) expect(h.received[i]!.equals(sent[i]!)).toBe(true);
    for (let i = 0; i < sentBack.length; i++) expect(c.received[i]!.equals(sentBack[i]!)).toBe(true);
    c.close();
    h.close();
  }, 60_000);

  it('边界：恰好 128KB 的消息可以转发；1 字节的消息可以转发', async () => {
    const { c, h } = await pairUp(s);
    const big = randomBytes(128 * 1024);
    await c.send(big);
    await c.send(Buffer.from([7]));
    await h.waitCount(2);
    expect(h.received[0]!.equals(big)).toBe(true);
    expect([...h.received[1]!]).toEqual([7]);
    c.close();
    h.close();
  });

  it('先到的一端提前发送的数据会被缓存，对端到达后按序送达', async () => {
    const sid = newUlid();
    const c = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'c' }));
    for (let i = 0; i < 5; i++) await c.send(Buffer.from([i]));
    await sleep(200);
    const h = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'h' }));
    await h.waitCount(5);
    expect(h.received.map((m) => m[0])).toEqual([0, 1, 2, 3, 4]);
    c.close();
    h.close();
  });

  it('只有一端连上：15 秒后被关闭，关闭码 4002（真实计时）', async () => {
    const t0 = Date.now();
    const c = await RelayConn.connect(s.relayUrl, tk(s, { sid: newUlid(), role: 'c' }));
    expect(await c.closed).toBe(4002);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(14_800);
    expect(dt).toBeLessThan(17_000);
  }, 25_000);

  it('票据被改动、过期、节点名不符、密钥不对、格式错误：关闭码 4001', async () => {
    const sid = newUlid();
    const good = tk(s, { sid, role: 'c' });
    const [p, sig] = good.split('.') as [string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ sid, role: 'h', did: 'x', node: 'relay-test', exp: Math.floor(Date.now() / 1000) + 30 })).toString('base64url');
    const cases: Record<string, string> = {
      payload被改动: `${forgedPayload}.${sig}`,
      签名被改动: `${p}.${sig.slice(0, -3)}AAA`,
      已过期: tk(s, { sid, role: 'c', now: Math.floor(Date.now() / 1000) - 100 }),
      节点名不符: tk(s, { sid, role: 'c', node: 'relay-other' }),
      密钥不对: tk(s, { sid, role: 'c', secret: 'another-secret-xxxxxxxx' }),
      乱码: 'not-a-ticket',
      空: '',
    };
    for (const [name, ticket] of Object.entries(cases)) {
      const c = await RelayConn.connect(s.relayUrl, ticket);
      expect(await c.closed, name).toBe(4001);
    }
    // 没有 ticket 参数
    const ws = new WebSocket(`${s.relayUrl}/v1/relay`);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4001);
  });

  it('同一张票据用两次：第二次被拒绝（4001），已建立的会话不受影响', async () => {
    const sid = newUlid();
    const ticketC = tk(s, { sid, role: 'c' });
    const c1 = await RelayConn.connect(s.relayUrl, ticketC);
    const c2 = await RelayConn.connect(s.relayUrl, ticketC);
    expect(await c2.closed).toBe(4001);
    const h = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'h' }));
    await c1.send(Buffer.from('still works'));
    await h.waitCount(1);
    // 会话结束之后再用同一张票据重放，同样拒绝
    c1.close();
    await h.closed;
    const replay = await RelayConn.connect(s.relayUrl, ticketC);
    expect(await replay.closed).toBe(4001);
  });

  it('同一会话同一角色用两张不同的票据：第二个被拒绝', async () => {
    const sid = newUlid();
    const c1 = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'c', did: 'a' }));
    // 第二张 role=c 的票据（新签发，内容不同）
    const c2 = await RelayConn.connect(s.relayUrl, signTicket({ sid, role: 'c', did: 'b', node: 'relay-test' }, s.cfg.ticketSecret, 30));
    expect(await c2.closed).toBe(4001);
    c1.close();
  });

  it('发文本消息：连接被关闭（4007），对端收到 4003', async () => {
    const { c, h } = await pairUp(s);
    c.ws.send('我是文本');
    expect(await c.closed).toBe(4007);
    expect(await h.closed).toBe(4003);
  });

  it('发超过 128KB 的消息：被关闭（4007），对端收到 4003；更大的帧也被关闭', async () => {
    const a = await pairUp(s);
    await a.c.send(randomBytes(128 * 1024 + 1));
    expect(await a.c.closed).toBe(4007);
    expect(await a.h.closed).toBe(4003);
    const b = await pairUp(s);
    b.c.ws.send(randomBytes(1024 * 1024), () => {});
    const code = await b.c.closed;
    expect([4007, 1009]).toContain(code);
    expect(await b.h.closed).toBe(4003);
  });

  it('一端断开：另一端收到关闭码 4003', async () => {
    const { c, h } = await pairUp(s);
    c.ws.terminate();
    expect(await h.closed).toBe(4003);
    const p = await pairUp(s);
    p.h.close(1000);
    expect(await p.c.closed).toBe(4003);
  });

  it('等待配对的一端在对端到达前自己离开：不会残留，之后配对表是干净的', async () => {
    const sid = newUlid();
    const c = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'c' }));
    c.close();
    await c.closed;
    await sleep(50);
    // 同一会话换新票据来的 h 不会和已离开的 c 配对，而是自己等待 -> 超时前主动离开
    const h = await RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'h' }));
    await sleep(100);
    expect(h.ws.readyState).toBe(WebSocket.OPEN);
    h.close();
  });

  it('非 /v1/relay 路径：404；/healthz 与 /metrics 可用', async () => {
    const ws = new WebSocket(`${s.relayUrl}/other`);
    const err = await new Promise<Error>((r) => ws.on('error', r));
    expect(err.message).toContain('404');
    const base = s.relayUrl.replace('ws', 'http');
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/metrics`)).text()).toContain('rterm_relay_bytes_total');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('中继向注册表上报自己的节点信息，配对期间会话计数 +1，结束后回落', async () => {
    const list = await s.stores.registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'relay-test', region: s.cfg.relay.region, publicUrl: s.cfg.relay.publicUrl, status: 'up' });
    const dids = { c: newUlid(), h: newUlid() };
    const { c, h } = await pairUp(s, newUlid(), dids);
    expect(s.relay.relay.sessionCount).toBe(1);
    await until(async () => (await s.stores.tracker.count(dids.c)) === 1 && (await s.stores.tracker.count(dids.h)) === 1, 2000, '会话计数');
    c.close();
    await h.closed;
    await until(async () => (await s.stores.tracker.count(dids.c)) === 0, 2000, '会话计数释放');
    expect(s.relay.relay.sessionCount).toBe(0);
  });

  it('并发 50 个会话同时转发，互不串线', async () => {
    const n = 50;
    const sessions = await Promise.all(Array.from({ length: n }, () => pairUp(s)));
    await Promise.all(
      sessions.map(async ({ c, h }, i) => {
        for (let k = 0; k < 20; k++) {
          await c.send(Buffer.from(`c${i}-${k}`));
          await h.send(Buffer.from(`h${i}-${k}`));
        }
      }),
    );
    for (const [i, { c, h }] of sessions.entries()) {
      await Promise.all([c.waitCount(20), h.waitCount(20)]);
      expect(h.received.map((m) => m.toString())).toEqual(Array.from({ length: 20 }, (_, k) => `c${i}-${k}`));
      expect(c.received.map((m) => m.toString())).toEqual(Array.from({ length: 20 }, (_, k) => `h${i}-${k}`));
      c.close();
      h.close();
    }
  }, 30_000);
});

describe('中继：流量配额、限速、心跳、优雅退出', () => {
  it('单设备日流量超限：关闭会话（4005），之后同一设备的新连接立刻 4005', async () => {
    const s = await startStack({ tunables: { dailyQuotaBytes: 100_000, sessionBytesPerSec: 500 * 1024 * 1024, sessionBurstBytes: 500 * 1024 * 1024 } });
    try {
      const sid = newUlid();
      const dev = { c: 'quota-dev-c', h: 'quota-dev-h' };
      const [c, h] = await Promise.all([
        RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'c', did: dev.c })),
        RelayConn.connect(s.relayUrl, tk(s, { sid, role: 'h', did: dev.h })),
      ]);
      for (let i = 0; i < 4; i++) await c.send(randomBytes(100_000 - 1));
      expect(await c.closed).toBe(4005);
      expect(await h.closed).toBe(4005);
      const again = await RelayConn.connect(s.relayUrl, tk(s, { sid: newUlid(), role: 'c', did: dev.c }));
      expect(await again.closed).toBe(4005);
      // 另一个设备不受影响
      const other = await pairUp(s);
      await other.c.send(Buffer.from('ok'));
      await other.h.waitCount(1);
    } finally {
      await s.stop();
    }
  });

  it('单会话限速：令牌不够时暂停读取而不是丢数据，全部送达且耗时符合速率', async () => {
    // 100KB/s，突发 100KB：发 400KB，至少需要约 3 秒
    const s = await startStack({ tunables: { sessionBytesPerSec: 100 * 1024, sessionBurstBytes: 100 * 1024 } });
    try {
      const { c, h } = await pairUp(s);
      const t0 = Date.now();
      const msgs = Array.from({ length: 40 }, () => randomBytes(10 * 1024));
      for (const m of msgs) await c.send(m);
      await h.waitCount(40, 20_000);
      const dt = Date.now() - t0;
      expect(dt).toBeGreaterThanOrEqual(2200);
      expect(dt).toBeLessThan(8000);
      msgs.forEach((m, i) => expect(h.received[i]!.equals(m)).toBe(true));
    } finally {
      await s.stop();
    }
  }, 30_000);

  it('协议层心跳：没有回 pong 的连接被清理（这里 ping 间隔缩短到 100ms）', async () => {
    const s = await startStack({ tunables: { relayPingMs: 100 } });
    try {
      // 正常客户端（自动回 pong）保持连接
      const good = await RelayConn.connect(s.relayUrl, tk(s, { sid: newUlid(), role: 'c' }));
      // 不回 pong 的客户端
      const ws = new WebSocket(`${s.relayUrl}/v1/relay?ticket=${tk(s, { sid: newUlid(), role: 'c' })}`, { autoPong: false });
      const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
      ws.on('error', () => {});
      const code = await closed;
      expect(code).toBe(1006);
      expect(good.ws.readyState).toBe(WebSocket.OPEN);
      good.close();
    } finally {
      await s.stop();
    }
  });

  it('SIGTERM 优雅退出：停止接受新连接，对现有连接发 4006，随后退出', async () => {
    const s = await startStack();
    const { c, h } = await pairUp(s);
    await s.relay.stop();
    expect(await c.closed).toBe(4006);
    expect(await h.closed).toBe(4006);
    // 注册表里已摘除本节点，信令不会再分配给它
    expect(await s.stores.registry.list()).toEqual([]);
    await expect(RelayConn.connect(s.relayUrl, tk(s, { sid: newUlid(), role: 'c' }))).rejects.toThrow();
    await s.signal.stop();
  });

  it('排空等待：drainWaitSec>0 时先等现有会话自然结束再退出', async () => {
    const s = await startStack({ relay: { drainWaitSec: 5 } });
    const { c, h } = await pairUp(s);
    const stopping = s.relay.stop();
    await sleep(300);
    // 排空期间会话仍然可用，注册表里标记为排空
    await c.send(Buffer.from('during drain'));
    await h.waitCount(1);
    expect((await s.stores.registry.list())[0]?.status).toBe('draining');
    expect(s.relay.relay.isDraining).toBe(true);
    c.close();
    await stopping;
    await s.signal.stop();
  });

  it('排空期间 /healthz 返回 503', async () => {
    const s = await startStack({ relay: { drainWaitSec: 3 } });
    const { c } = await pairUp(s);
    const stopping = s.relay.stop();
    await sleep(100);
    const base = s.relayUrl.replace('ws', 'http');
    // http.close() 之后新连接会被拒绝；已有的 keep-alive 连接可能还能访问，两种情况都接受
    const res = await fetch(`${base}/healthz`).catch(() => null);
    if (res) expect(res.status).toBe(503);
    c.close();
    await stopping;
    await s.signal.stop();
  });
});
