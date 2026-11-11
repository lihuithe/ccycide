import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { SessionStatus } from '../src/db/repos/index.js';
import { silentLogger } from '../src/logger.js';
import { startSignalApp, type SignalApp } from '../src/runtime.js';
import { SignalClient, registerNew, type Identity } from '../tools/rterm-client.js';
import { onlineDevice, sleep, startStack, until, type Stack } from './helpers.js';

/*
 * 被控端“连接确认”无限期等待的新流程：connect.pending / connect.incoming(无票据) / connect.go / connect.cancel / connect.cancelled。
 * 这里测等待期间的各种结束方式，以及 Redis（Pub/Sub 不持久化）下消息丢失、实例退出时的兜底清理。
 */

const flush = () => sleep(120);

async function request(host: { identity: Identity; sig: SignalClient }, ctl: { sig: SignalClient }) {
  const incP = host.sig.waitIncoming();
  const h = ctl.sig.startConnect(host.identity.deviceCode, 0);
  const inc = await incP;
  return { h, inc };
}

describe('等待期间主控端取消', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  it('主控端 connect.cancel：被控端收到 connect.cancelled，session 记为 cancelled，之后被控端迟到的 accept 被忽略，主控端不会收到任何最终响应', async () => {
    const host = await onlineDevice(s);
    const ctl = await onlineDevice(s);
    const { h, inc } = await request(host, ctl);
    const cancelledP = host.sig.waitCancelled(inc.session_id);
    await h.cancel();
    await cancelledP;
    const row = (await s.repos.sessions.get(inc.session_id))!;
    expect(row).toMatchObject({ status: SessionStatus.Failed, failReason: 'cancelled' });
    expect(row.endedAt).not.toBeNull();
    host.sig.accept(inc.session_id);
    await flush();
    expect(ctl.sig.messages.some((m) => m.t === 'connect.ok' || m.t === 'connect.err')).toBe(false);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Failed);
    // 名额已释放：马上可以再发起
    const again = await request(host, ctl);
    host.sig.reject(again.inc.session_id);
    expect(await again.h.result).toMatchObject({ ok: false, code: 'REJECTED' });
  });

  it('只有发起请求的主控端本人能 cancel：被控端或第三方发 connect.cancel 被忽略', async () => {
    const host = await onlineDevice(s);
    const ctl = await onlineDevice(s);
    const other = await onlineDevice(s);
    const { h, inc } = await request(host, ctl);
    other.sig.cancel(inc.session_id);
    host.sig.cancel(inc.session_id);
    await flush();
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Pending);
    expect(host.sig.messages.some((m) => m.t === 'connect.cancelled')).toBe(false);
    // 仍然可以正常同意
    const goP = host.sig.acceptGo(inc.session_id);
    expect((await h.result).ok).toBe(true);
    await goP;
  });

  it('connect.cancel 缺少 session_id：返回 error，不断开；未知 session_id 被忽略', async () => {
    const ctl = await onlineDevice(s);
    expect((await ctl.sig.request('connect.cancel', {})).d.code).toBe('BAD_REQUEST');
    ctl.sig.cancel('01NOSUCHSESSION000000000000');
    await ctl.sig.ping();
  });
});

describe('等待期间被控端断开 / 拒绝 / 上限', () => {
  it('被控端信令断开：主控端收到 connect.err UNAVAILABLE，session 记为 host_gone', async () => {
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const { h, inc } = await request(host, ctl);
      host.sig.ws.terminate();
      expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect(await s.repos.sessions.get(inc.session_id)).toMatchObject({ status: SessionStatus.Failed, failReason: 'host_gone' });
      await ctl.sig.ping(); // 主控连接不受影响
    } finally {
      await s.stop();
    }
  });

  it('被控端被同一设备的新连接顶替（旧连接被踢）：旧连接上的等待项以 UNAVAILABLE 结束', async () => {
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const { h } = await request(host, ctl);
      const again = await SignalClient.connect(s.ws, host.identity);
      expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      again.close();
    } finally {
      await s.stop();
    }
  });

  it('等待期间的主控连接不会被“45 秒无消息”断开；没有等待项的空闲连接照常被断开；等待结束后恢复按空闲计时', async () => {
    const s = await startStack({ tunables: { idleTimeoutMs: 300, idleSweepMs: 50 } });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const idle = await onlineDevice(s);
      // 被控端要持续心跳，否则它自己被当成空闲断开（等待确认的是主控端，被控端界面本来就在跑心跳）
      const keep = setInterval(() => host.sig.sendRaw({ t: 'ping', d: {} }), 100);
      const { h, inc } = await request(host, ctl);
      await sleep(1200); // 远超 idleTimeoutMs，主控端一条消息也没发
      expect(ctl.sig.ws.readyState).toBe(1);
      expect(await idle.sig.closed).toBe(4408);
      host.sig.reject(inc.session_id);
      await h.result;
      expect(await ctl.sig.closed).toBe(4408); // 等待结束后，闲着就会被断开
      clearInterval(keep);
    } finally {
      await s.stop();
    }
  });

  it('每台被控端同时挂起的请求数有上限（maxPendingPerHost）：超出返回 RATE_LIMITED + reason=host_pending_full，处理掉一个后恢复', async () => {
    const s = await startStack({ tunables: { maxPendingPerHost: 2 } });
    try {
      const host = await onlineDevice(s);
      const a = await onlineDevice(s);
      const b = await onlineDevice(s);
      const c = await onlineDevice(s);
      const r1 = await request(host, a);
      const r2 = await request(host, b);
      const third = await c.sig.connectRequest(host.identity.deviceCode);
      expect(third).toMatchObject({ ok: false, code: 'RATE_LIMITED', data: { reason: 'host_pending_full' } });
      await c.sig.ping();
      // 主控取消一个 -> 名额释放
      const cancelled = host.sig.waitCancelled(r1.inc.session_id);
      await r1.h.cancel();
      await cancelled;
      const r3 = await request(host, c);
      host.sig.reject(r3.inc.session_id);
      host.sig.reject(r2.inc.session_id);
      expect(await r3.h.result).toMatchObject({ ok: false, code: 'REJECTED' });
      expect(await r2.h.result).toMatchObject({ ok: false, code: 'REJECTED' });
    } finally {
      await s.stop();
    }
  });

  it('被控端同意后找不到可用中继：主控端 NO_RELAY，被控端撤掉弹窗', async () => {
    const s = await startStack({ noRelay: true });
    try {
      const rep = (status: 'up' | 'draining') =>
        s.stores.registry.report({ name: 'relay-test', region: 'dev', publicUrl: 'ws://x', sessions: 0, capacity: 10, bandwidth: 0, status, ts: Date.now() }, 60_000);
      await rep('up');
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const { h, inc } = await request(host, ctl);
      await rep('draining'); // 等待期间节点被排空
      const cancelled = host.sig.waitCancelled(inc.session_id);
      host.sig.accept(inc.session_id);
      expect(await h.result).toMatchObject({ ok: false, code: 'NO_RELAY' });
      await cancelled;
    } finally {
      await s.stop();
    }
  });

  it('同意时重新选择中继节点，sessions.relay_node 写回实际使用的节点', async () => {
    const s = await startStack({ noRelay: true });
    try {
      const rep = (name: string) =>
        s.stores.registry.report({ name, region: 'dev', publicUrl: `ws://${name}`, sessions: 0, capacity: 10, bandwidth: 0, status: 'up', ts: Date.now() }, 60_000);
      await rep('node-a');
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const { h, inc } = await request(host, ctl);
      expect((await s.repos.sessions.get(inc.session_id))!.relayNode).toBe('node-a');
      await s.stores.registry.remove('node-a');
      await rep('node-b');
      const goP = host.sig.acceptGo(inc.session_id);
      const res = await h.result;
      expect(res.ok && res.data.relay_url).toBe('ws://node-b');
      expect((await goP).relay_url).toBe('ws://node-b');
      expect((await s.repos.sessions.get(inc.session_id))!.relayNode).toBe('node-b');
    } finally {
      await s.stop();
    }
  });
});

describe('投递失败立即告诉主控端（不再靠 10 秒超时兜底）', () => {
  it('在线状态指向本实例上不存在的连接：立即 UNAVAILABLE + reason=deliver_failed，session 与计数被清理', async () => {
    const s = await startStack();
    try {
      const ctl = await onlineDevice(s);
      const host = await onlineDevice(s);
      const p = (await s.stores.presence.get(host.identity.deviceCode))!;
      await s.stores.presence.set(host.identity.deviceCode, { ...p, connId: 'ghost' });
      const t0 = Date.now();
      const res = await ctl.sig.connectRequest(host.identity.deviceCode);
      expect(res).toMatchObject({ ok: false, code: 'UNAVAILABLE', data: { reason: 'deliver_failed' } });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await s.stores.tracker.count(`hp:${host.identity.deviceId}`)).toBe(0);
      expect(await s.stores.tracker.count(ctl.identity.deviceId)).toBe(0);
    } finally {
      await s.stop();
    }
  });

  it('跨实例总线不可用（publish 抛错）：立即 UNAVAILABLE + deliver_failed', async () => {
    const s = await startStack();
    const ctx2 = await createContext(s.cfg, silentLogger(), { stores: s.stores, repos: s.repos });
    const app2 = await startSignalApp(ctx2, 0, '127.0.0.1');
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      await SignalClient.connect(`ws://127.0.0.1:${app2.port}/v1/signal`, identity);
      const orig = s.stores.bus.publish;
      s.stores.bus.publish = async () => {
        throw new Error('Redis 不可用');
      };
      const res = await ctl.sig.connectRequest(identity.deviceCode);
      s.stores.bus.publish = orig;
      expect(res).toMatchObject({ ok: false, code: 'UNAVAILABLE', data: { reason: 'deliver_failed' } });
      expect(await ctl.sig.request('ping', {})).toMatchObject({ t: 'pong' });
    } finally {
      await app2.stop();
      await s.stop();
    }
  });

  it('目标实例已经退出（没有订阅者收到消息）：立即 deliver_failed', async () => {
    const s = await startStack();
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      const row = (await s.repos.devices.findByUid(identity.deviceId))!;
      await s.stores.presence.set(identity.deviceCode, {
        instanceId: 'dead-instance', connId: 'x', deviceId: row.id, deviceUid: row.uid, deviceCode: row.code, accept: true,
        protoVer: 1, minProtoVer: 1, platform: 'windows', publicKey: row.publicKey.toString('base64'), appVersion: '', ip: '127.0.0.1', region: '',
      });
      expect(await ctl.sig.connectRequest(identity.deviceCode)).toMatchObject({ ok: false, code: 'UNAVAILABLE', data: { reason: 'deliver_failed' } });
    } finally {
      await s.stop();
    }
  });
});

describe('多实例：等待期间的取消、断开与消息丢失', () => {
  let s: Stack;
  let appB: SignalApp;
  let wsB: string;
  beforeAll(async () => {
    s = await startStack({ tunables: { pendingCheckMs: 100 } });
    const ctxB = await createContext(s.cfg, silentLogger(), { stores: s.stores, repos: s.repos });
    appB = await startSignalApp(ctxB, 0, '127.0.0.1');
    wsB = `ws://127.0.0.1:${appB.port}/v1/signal`;
  });
  afterAll(async () => {
    await appB.stop();
    await s.stop();
  });

  async function onB(): Promise<{ identity: Identity; sig: SignalClient }> {
    const { identity } = await registerNew(s.http);
    return { identity, sig: await SignalClient.connect(wsB, identity) };
  }

  /** 主控在 A、被控在 B，已挂起一个请求 */
  async function crossPending() {
    const ctl = await onlineDevice(s);
    const host = await onB();
    const { h, inc } = await request(host, ctl);
    return { ctl, host, h, inc };
  }

  it('被控端晚于 15 秒（缩短为 1.5 秒）才同意：connect.go 经总线送回被控端所在实例，两端都拿到票据', async () => {
    const { host, h, inc } = await crossPending();
    await sleep(1500);
    const goP = host.sig.acceptGo(inc.session_id);
    const res = await h.result;
    expect(res.ok).toBe(true);
    const go = await goP;
    expect(res.ok && res.data.session_id).toBe(go.session_id);
    expect(res.ok && res.data.ticket).not.toBe(go.ticket);
  });

  it('主控端取消 -> connect.cancelled 经总线到达被控端', async () => {
    const { host, h, inc } = await crossPending();
    const cancelled = host.sig.waitCancelled(inc.session_id);
    await h.cancel();
    await cancelled;
    expect((await s.repos.sessions.get(inc.session_id))!.failReason).toBe('cancelled');
  });

  it('主控端信令断开 -> 另一个实例上的被控端撤掉弹窗', async () => {
    const { ctl, host, inc } = await crossPending();
    const cancelled = host.sig.waitCancelled(inc.session_id);
    ctl.sig.ws.terminate();
    await cancelled;
  });

  it('被控端信令断开 -> 另一个实例上的主控端收到 UNAVAILABLE', async () => {
    const { host, h } = await crossPending();
    host.sig.ws.terminate();
    expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  });

  it('被控端所在实例优雅退出 -> 主控端收到 UNAVAILABLE', async () => {
    const ctxC = await createContext(s.cfg, silentLogger(), { stores: s.stores, repos: s.repos });
    const appC = await startSignalApp(ctxC, 0, '127.0.0.1');
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      const hostSig = await SignalClient.connect(`ws://127.0.0.1:${appC.port}/v1/signal`, identity);
      const { h } = await request({ identity, sig: hostSig }, ctl);
      await appC.stop();
      expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    } finally {
      await appC.stop().catch(() => {});
    }
  });

  it('主控端所在实例优雅退出 -> 另一个实例上的被控端撤掉弹窗', async () => {
    const ctxC = await createContext(s.cfg, silentLogger(), { stores: s.stores, repos: s.repos });
    const appC = await startSignalApp(ctxC, 0, '127.0.0.1');
    try {
      const { identity } = await registerNew(s.http);
      const ctlSig = await SignalClient.connect(`ws://127.0.0.1:${appC.port}/v1/signal`, identity);
      const host = await onB();
      const { inc } = await request(host, { sig: ctlSig });
      const cancelled = host.sig.waitCancelled(inc.session_id);
      await appC.stop();
      await cancelled;
    } finally {
      await appC.stop().catch(() => {});
    }
  });

  it('兜底：被控端断开时通知主控端的消息丢了（Redis 断开期间的 Pub/Sub），定期检查发现被控端不在线，主控端仍收到 UNAVAILABLE', async () => {
    const { host, h } = await crossPending();
    const orig = s.stores.bus.publish;
    s.stores.bus.publish = async () => {
      throw new Error('Redis 不可用');
    };
    host.sig.ws.terminate();
    await sleep(60);
    s.stores.bus.publish = orig; // 恢复后不会重发那条消息
    expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  });

  it('兜底：主控端断开时通知被控端的消息丢了，定期检查发现主控端不在线，被控端弹窗被撤掉', async () => {
    const { ctl, host, inc } = await crossPending();
    const orig = s.stores.bus.publish;
    s.stores.bus.publish = async () => {
      throw new Error('Redis 不可用');
    };
    const cancelled = host.sig.waitCancelled(inc.session_id);
    ctl.sig.ws.terminate();
    await sleep(60);
    s.stores.bus.publish = orig;
    await cancelled;
  });

  it('兜底：主控端取消的通知丢了、但主控端仍在线，被控端通过“主控端那边的等待是否还在”发现并撤掉弹窗', async () => {
    const { host, h, inc } = await crossPending();
    const orig = s.stores.bus.publish;
    s.stores.bus.publish = async () => {
      throw new Error('Redis 不可用');
    };
    const cancelled = host.sig.waitCancelled(inc.session_id);
    await h.cancel();
    await sleep(60);
    s.stores.bus.publish = orig;
    await cancelled;
  });

  it('兜底：被控端所在实例崩溃（没有任何清理），在线状态过期后主控端收到 UNAVAILABLE', async () => {
    const { host, h } = await crossPending();
    const p = (await s.stores.presence.get(host.identity.deviceCode))!;
    // 模拟 90 秒有效期到了：登记没了，而被控端那边的实例没机会通知任何人
    await s.stores.presence.remove(host.identity.deviceCode, p.connId);
    expect(await h.result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  });

  it('存储暂时不可用（presence 查询抛错）时定期检查不会误杀正在等待的请求', async () => {
    const { host, h, inc } = await crossPending();
    const orig = s.stores.presence.get;
    s.stores.presence.get = async () => {
      throw new Error('Redis 不可用');
    };
    await sleep(400); // 检查多轮
    s.stores.presence.get = orig;
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Pending);
    const goP = host.sig.acceptGo(inc.session_id);
    expect((await h.result).ok).toBe(true);
    await goP;
  });

  it('被控端同意时，答复发不到主控端所在实例（来源实例已退出）：被控端的弹窗被撤掉，不会一直等 connect.go', async () => {
    const { host, inc } = await crossPending();
    // 把来源实例的订阅摘掉，模拟它已经退出
    const orig = s.stores.bus.publish;
    s.stores.bus.publish = async () => 0;
    const cancelled = host.sig.waitCancelled(inc.session_id);
    host.sig.accept(inc.session_id);
    await cancelled;
    s.stores.bus.publish = orig;
  });

  it('等待期间 presence 状态变化不影响：被控端 presence.update accept=false 后，已挂起的请求仍可被同意', async () => {
    const { host, h, inc } = await crossPending();
    host.sig.setAccept(false);
    await until(async () => (await s.stores.presence.get(host.identity.deviceCode))!.accept === false, 2000, 'accept=false');
    await sleep(300);
    const goP = host.sig.acceptGo(inc.session_id);
    expect((await h.result).ok).toBe(true);
    await goP;
  });
});
