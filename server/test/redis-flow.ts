import { createContext, createRelayContext, closeCtx } from '../src/context.js';
import { silentLogger } from '../src/logger.js';
import { SessionStatus, type Repos } from '../src/db/repos/index.js';
import { startRelayApp, startSignalApp } from '../src/runtime.js';
import type { Stores } from '../src/store/index.js';
import { expect } from 'vitest';
import { RelayConn, SignalClient, registerNew } from '../tools/rterm-client.js';
import { onlineDevice, startStack, testConfig, until } from './helpers.js';

/**
 * 两个信令实例 + 一个中继的完整 connect 流程，对 Redis 实现（ioredis-mock 或真实 Redis）通用。
 * 每个信令实例、中继各自拥有独立的 Stores（独立的 Redis 连接和订阅连接），和多进程部署一致。
 */
export async function crossInstanceFlow(opts: { makeStores: () => Promise<Stores> | Stores; repos?: Repos }): Promise<void> {
  const cfg = testConfig();
  const stores = await opts.makeStores();
  const relayStores = await opts.makeStores();
  const s = await startStack({ stores, relayStores, repos: opts.repos });
  // 第二个信令实例：独立的 Redis 连接（独立的总线），共享同一份 Redis 数据和仓储
  const stores2 = await opts.makeStores();
  const ctx2 = await createContext(s.cfg, silentLogger(), { stores: stores2, repos: s.repos });
  const app2 = await startSignalApp(ctx2, 0, '127.0.0.1');
  const ws2 = `ws://127.0.0.1:${app2.port}/v1/signal`;
  try {
    expect(s.stores.isRedis).toBe(true);
    // 主控在实例 A，被控在实例 B
    const ctl = await onlineDevice(s);
    const { identity: hostId } = await registerNew(s.http);
    const host = await SignalClient.connect(ws2, hostId);
    const p = await stores.presence.get(hostId.deviceCode);
    expect(p!.instanceId).toBe(app2.signal.instanceId);
    expect(p!.instanceId).not.toBe(s.signal.signal.instanceId);

    const incP = host.waitIncoming();
    const resP = ctl.sig.connectRequest(hostId.deviceCode);
    const inc = await incP; // connect.incoming 经 Redis 总线跨实例投递
    const goP = host.acceptGo(inc.session_id);
    const res = await resP; // 答复经总线回到实例 A
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 中继节点选择：中继经 Redis 注册表上报，信令从注册表里挑
    expect(res.data.relay_url).toBe(s.relayUrl);
    expect((await goP).relay_url).toBe(s.relayUrl);

    // 中继：票据一次性标记存在 Redis 里
    const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
    await c.send(Buffer.from('hello'));
    await h.waitCount(1);
    expect(h.received[0]!.toString()).toBe('hello');
    await h.send(Buffer.from('world!!'));
    await c.waitCount(1);
    expect(await stores.kv.get(`ticket:used:${inc.session_id}:c`)).toBe('1');
    expect(await stores.kv.get(`ticket:used:${inc.session_id}:h`)).toBe('1');
    const replay = await RelayConn.connect(res.data.relay_url, res.data.ticket);
    expect(await replay.closed).toBe(4001);
    // 配对事件经 Redis 列表回传，由信令消费后推进状态
    await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Paired, 4000, '状态 2');
    host.report(inc.session_id, 'auth_ok');
    await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Authed, 4000, '状态 3');
    c.close();
    await h.closed;
    await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Ended, 4000, '状态 4');
    // 字节数经 Redis 列表回传后落库
    expect(await s.repos.sessions.get(inc.session_id)).toMatchObject({ bytesC2h: 5, bytesH2c: 7 });
    // 同时会话计数（Redis ZSet）释放
    await until(async () => (await stores.tracker.count(hostId.deviceId)) === 0, 3000, '会话计数');

    // 同一设备在另一个实例登录：A 上的旧连接被踢
    const again = await SignalClient.connect(ws2, ctl.identity);
    expect(await ctl.sig.closed).toBe(4409);
    again.close();

    // 5 次密码失败 -> Redis 里出现锁定标记 -> LOCKED
    const ctl2 = await onlineDevice(s);
    for (let i = 0; i < 5; i++) {
      const ip = host.waitIncoming();
      const r = ctl2.sig.connectRequest(hostId.deviceCode);
      const x = await ip;
      host.accept(x.session_id);
      await r;
      host.report(x.session_id, 'auth_failed');
    }
    await until(async () => (await stores.kv.get(`lock:host:${hostId.deviceCode}`)) !== null, 3000, '锁定标记');
    expect(await ctl2.sig.connectRequest(hostId.deviceCode)).toMatchObject({ ok: false, code: 'LOCKED' });

    host.close();
  } finally {
    await app2.stop();
    await closeCtx(ctx2).catch(() => {});
    await s.stop();
    await stores.close().catch(() => {});
  }
}

/** 一个独立的中继进程（自己的 Stores，自己的节点名），用于测试多中继节点选择 */
export async function startExtraRelay(makeStores: () => Promise<Stores> | Stores, name: string, over: { region?: string; capacity?: number } = {}) {
  const { freePort } = await import('./helpers.js');
  const port = await freePort();
  const cfg = testConfig({ relay: { nodeName: name, publicUrl: `ws://127.0.0.1:${port}`, region: over.region ?? 'dev', capacity: over.capacity ?? 100 } });
  const stores = await makeStores();
  const ctx = await createRelayContext(cfg, silentLogger(), stores);
  const app = await startRelayApp(ctx, port, '127.0.0.1');
  return {
    name,
    port,
    url: `ws://127.0.0.1:${port}`,
    app,
    async stop() {
      await app.stop().catch(() => {});
      await closeCtx(ctx).catch(() => {});
    },
  };
}
