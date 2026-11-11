import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { authSignString } from '../src/crypto.js';
import { AuthError, SignalClient, loadPrivateKey, registerNew, signB64 } from '../tools/rterm-client.js';
import { onlineDevice, sleep, startStack, until, type Stack } from './helpers.js';

/** 原始 WebSocket：记录收到的所有文本消息和关闭码 */
function raw(url: string) {
  const ws = new WebSocket(url);
  const msgs: Array<{ t: string; id?: string; d: Record<string, any> }> = [];
  let closeCode: number | null = null;
  let closedAt = 0;
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  ws.on('close', (c) => {
    closeCode = c;
    closedAt = Date.now();
  });
  ws.on('error', () => {});
  const opened = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return {
    ws, msgs, opened,
    get closeCode() { return closeCode; },
    get closedAt() { return closedAt; },
    waitClose: async (ms = 8000) => { await until(() => closeCode !== null, ms, '连接关闭'); return closeCode!; },
    waitMsg: async (t: string, ms = 3000) => { await until(() => msgs.some((m) => m.t === t), ms, `消息 ${t}`); return msgs.find((m) => m.t === t)!; },
  };
}

describe('信令：连接、认证、心跳（T4）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ cfg: { minAppVersion: '1.0.0' } });
  });
  afterAll(() => s.stop());

  it('连上后立刻收到 hello：32 字节随机数的 base64 + 服务器时间', async () => {
    const c = raw(s.ws);
    await c.opened;
    const hello = await c.waitMsg('hello');
    expect(Buffer.from(hello.d.nonce, 'base64')).toHaveLength(32);
    expect(Math.abs(hello.d.server_time - Date.now() / 1000)).toBeLessThan(5);
    c.ws.close();
    // 每条连接的 nonce 不同
    const c2 = raw(s.ws);
    await c2.opened;
    expect((await c2.waitMsg('hello')).d.nonce).not.toBe(hello.d.nonce);
    c2.ws.close();
  });

  it('连上后什么都不发：5 秒后被断开（关闭码 4401）', async () => {
    const t0 = Date.now();
    const c = raw(s.ws);
    await c.opened;
    expect(await c.waitClose(9000)).toBe(4401);
    const dt = c.closedAt - t0;
    expect(dt).toBeGreaterThanOrEqual(4800);
    expect(dt).toBeLessThan(7000);
  }, 15_000);

  it('认证成功收到 auth.ok（带设备码和心跳间隔 20 秒）', async () => {
    const { identity } = await registerNew(s.http);
    const sig = await SignalClient.connect(s.ws, identity);
    expect(sig.deviceCode).toBe(identity.deviceCode);
    expect(sig.heartbeatSec).toBe(20);
    const ok = sig.messages.find((m) => m.t === 'auth.ok')!;
    expect(ok.d).toEqual({ device_code: identity.deviceCode, heartbeat_sec: 20 });
    // 登记了在线状态
    const p = await s.stores.presence.get(identity.deviceCode);
    expect(p).toMatchObject({ deviceUid: identity.deviceId, accept: true, platform: 'windows' });
    sig.close();
  });

  it('认证后 last_seen_at 被写入，之后的心跳不会频繁写库（5 分钟节流）', async () => {
    const { identity } = await registerNew(s.http);
    const sig = await SignalClient.connect(s.ws, identity);
    await until(async () => (await s.repos.devices.findByUid(identity.deviceId))!.lastSeenAt !== null, 2000, 'last_seen_at');
    const t1 = (await s.repos.devices.findByUid(identity.deviceId))!.lastSeenAt!.getTime();
    await sleep(30);
    await sig.ping();
    await sleep(30);
    expect((await s.repos.devices.findByUid(identity.deviceId))!.lastSeenAt!.getTime()).toBe(t1);
    sig.close();
  });

  it('认证失败的各种情形：返回 auth.err 并关闭连接', async () => {
    const { identity } = await registerNew(s.http);
    await expect(SignalClient.connect(s.ws, identity, { badSignature: true })).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    await expect(SignalClient.connect(s.ws, { ...identity, deviceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).rejects.toMatchObject({ code: 'UNKNOWN_DEVICE' });
    await expect(SignalClient.connect(s.ws, identity, { protoVer: 0 })).rejects.toBeInstanceOf(AuthError);

    const c = raw(s.ws);
    await c.opened;
    await c.waitMsg('hello');
    c.ws.send(JSON.stringify({ t: 'auth', id: '9', d: { device_id: 123 } }));
    const err = await c.waitMsg('auth.err');
    expect(err).toMatchObject({ id: '9', d: { code: 'BAD_REQUEST' } });
    expect(await c.waitClose()).toBe(4401);
  });

  it('重放别的连接的签名无效（签名绑定了本连接的 nonce）', async () => {
    const { identity } = await registerNew(s.http);
    const a = raw(s.ws);
    const b = raw(s.ws);
    await Promise.all([a.opened, b.opened]);
    const helloA = await a.waitMsg('hello');
    const helloB = await b.waitMsg('hello');
    const sigForA = signB64(loadPrivateKey(identity), authSignString(helloA.d.nonce, identity.deviceId));
    // 把给 A 的签名拿到 B 上用
    b.ws.send(JSON.stringify({ t: 'auth', d: { device_id: identity.deviceId, sig: sigForA, app_version: '1.0.0', proto_ver: 1 } }));
    expect((await b.waitMsg('auth.err')).d.code).toBe('BAD_SIGNATURE');
    // 同样的签名用在 A 上是对的
    a.ws.send(JSON.stringify({ t: 'auth', d: { device_id: identity.deviceId, sig: sigForA, app_version: '1.0.0', proto_ver: 1 } }));
    await a.waitMsg('auth.ok');
    void helloB;
    a.ws.close();
  });

  it('被封禁的设备认证时收到 BANNED', async () => {
    const { identity } = await registerNew(s.http);
    await s.repos.bans.add({ kind: 'device', value: identity.deviceId, reason: 't', source: 'manual', expiresAt: null, createdBy: 't' });
    await expect(SignalClient.connect(s.ws, identity)).rejects.toMatchObject({ code: 'BANNED' });
    // 封禁到期后可以认证
    await s.repos.bans.add({ kind: 'device', value: identity.deviceId, reason: 't', source: 'auto', expiresAt: new Date(Date.now() - 1000), createdBy: 't' });
    const sig = await SignalClient.connect(s.ws, identity);
    sig.close();
  });

  it('应用层心跳：ping 收到 pong，id 原样带回；连接保持', async () => {
    const { sig } = await onlineDevice(s);
    const r = await sig.request('ping', {});
    expect(r.t).toBe('pong');
    expect(r.id).toBeDefined();
    for (let i = 0; i < 5; i++) await sig.ping();
    expect(sig.ws.readyState).toBe(WebSocket.OPEN);
    sig.close();
  });

  it('同一设备开两条连接：第一条收到 kick(replaced) 后被断开，第二条正常，在线状态属于新连接', async () => {
    const { identity } = await registerNew(s.http);
    const first = await SignalClient.connect(s.ws, identity);
    const second = await SignalClient.connect(s.ws, identity);
    const kick = await first.waitFor((m) => m.t === 'kick', 2000).catch(() => first.messages.find((m) => m.t === 'kick')!);
    expect(kick.d).toEqual({ reason: 'replaced' });
    expect(await first.closed).toBe(4409);
    await sleep(50); // 旧连接的清理逻辑跑完
    const p = await s.stores.presence.get(identity.deviceCode);
    expect(p).not.toBeNull();
    await second.ping();
    // 旧连接关闭不会把新连接的在线状态删掉
    expect((await s.stores.presence.get(identity.deviceCode))!.connId).toBe(p!.connId);
    second.close();
    await second.closed;
    await until(async () => (await s.stores.presence.get(identity.deviceCode)) === null, 2000, '在线状态清理');
  });

  it('非法 JSON、二进制消息、非对象 JSON：连接被关闭，服务端不崩溃', async () => {
    for (const payload of ['not json', '[1,2]', '"str"', '{"d":{}}', Buffer.from([1, 2, 3])]) {
      const c = raw(s.ws);
      await c.opened;
      await c.waitMsg('hello');
      c.ws.send(payload);
      expect(await c.waitClose()).toBe(4400);
    }
    // 认证后同样
    const { sig } = await onlineDevice(s);
    sig.ws.send('{{{');
    expect(await sig.closed).toBe(4400);
    sig.ws.removeAllListeners();
    // 服务仍然可用
    const again = await onlineDevice(s);
    await again.sig.ping();
    again.sig.close();
  });

  it('超过 64KB 的消息被拒绝', async () => {
    const { sig } = await onlineDevice(s);
    sig.ws.send(JSON.stringify({ t: 'ping', d: { pad: 'x'.repeat(70_000) } }));
    expect(await sig.closed).toBe(1009);
  });

  it('未认证就发其他消息：关闭（4401）；认证后重复 auth / 未知类型：返回 error，不断开', async () => {
    const c = raw(s.ws);
    await c.opened;
    await c.waitMsg('hello');
    c.ws.send(JSON.stringify({ t: 'ping' }));
    expect(await c.waitClose()).toBe(4401);

    const { sig } = await onlineDevice(s);
    expect((await sig.request('auth', {})).d.code).toBe('ALREADY_AUTHED');
    const unk = await sig.request('nonsense.type', {});
    expect(unk.t).toBe('error');
    expect(unk.d.code).toBe('UNKNOWN_TYPE');
    await sig.ping();
    sig.close();
  });

  it('presence.update：accept 必须是布尔；改成 false 后在线状态里体现', async () => {
    const { identity, sig } = await onlineDevice(s);
    expect((await sig.request('presence.update', { accept: 'yes' })).d.code).toBe('BAD_REQUEST');
    sig.setAccept(false);
    await until(async () => (await s.stores.presence.get(identity.deviceCode))!.accept === false, 2000, 'accept=false');
    sig.setAccept(true);
    await until(async () => (await s.stores.presence.get(identity.deviceCode))!.accept === true, 2000, 'accept=true');
    sig.close();
  });

  it('auth 里可以直接声明 accept:false', async () => {
    const { identity } = await registerNew(s.http);
    const sig = await SignalClient.connect(s.ws, identity, { accept: false });
    expect((await s.stores.presence.get(identity.deviceCode))!.accept).toBe(false);
    sig.close();
  });

  it('强制升级：app_version 低于 min_app_version 时收到 notice(force_upgrade)', async () => {
    const { identity } = await registerNew(s.http);
    const old = await SignalClient.connect(s.ws, identity, { appVersion: '0.9.0' });
    const n = await old.waitFor((m) => m.t === 'notice', 2000).catch(() => old.messages.find((m) => m.t === 'notice')!);
    expect(n.d.level).toBe('force_upgrade');
    old.close();
    const { identity: id2 } = await registerNew(s.http);
    const ok = await SignalClient.connect(s.ws, id2, { appVersion: '1.0.0' });
    await sleep(100);
    expect(ok.messages.some((m) => m.t === 'notice')).toBe(false);
    ok.close();
  });

  it('连接关闭后在线状态被清理', async () => {
    const { identity, sig } = await onlineDevice(s);
    expect(await s.stores.presence.get(identity.deviceCode)).not.toBeNull();
    sig.ws.terminate();
    await until(async () => (await s.stores.presence.get(identity.deviceCode)) === null, 2000, '在线状态清理');
  });
});

describe('信令：可调参数下的行为（缩短计时）', () => {
  it('45 秒没有任何消息就断开（这里缩短到 400ms）；有 ping 的连接保持', async () => {
    const s = await startStack({ tunables: { idleTimeoutMs: 400, idleSweepMs: 50 } });
    try {
      const idle = await onlineDevice(s);
      const busy = await onlineDevice(s);
      const t0 = Date.now();
      while (Date.now() - t0 < 900) {
        await busy.sig.ping();
        await sleep(100);
      }
      expect(await idle.sig.closed).toBe(4408);
      expect(busy.sig.ws.readyState).toBe(WebSocket.OPEN);
      await until(async () => (await s.stores.presence.get(idle.identity.deviceCode)) === null, 2000, '清理在线状态');
      busy.sig.close();
    } finally {
      await s.stop();
    }
  });

  it('同一 IP 的并发连接数超限：新连接被拒绝（默认 50，这里设为 3）', async () => {
    const s = await startStack({ tunables: { maxSignalConnsPerIp: 3 } });
    try {
      const open = [raw(s.ws), raw(s.ws), raw(s.ws)];
      await Promise.all(open.map((c) => c.opened));
      const fourth = raw(s.ws);
      await expect(fourth.opened).rejects.toThrow();
      open[0]!.ws.close();
      await open[0]!.waitClose();
      await sleep(50);
      const fifth = raw(s.ws);
      await fifth.opened;
      for (const c of [...open, fifth]) c.ws.close();
    } finally {
      await s.stop();
    }
  });

  it('单连接消息洪水：超过速率上限被关闭（4429）', async () => {
    const s = await startStack({ tunables: { maxMsgsPer10s: 20 } });
    try {
      const { sig } = await onlineDevice(s);
      for (let i = 0; i < 40; i++) sig.sendRaw({ t: 'ping', d: {} });
      expect(await sig.closed).toBe(4429);
    } finally {
      await s.stop();
    }
  });

  it('客户端协议版本低于服务端要求：auth.err VERSION', async () => {
    const s = await startStack({ tunables: { minProtoVer: 2 } });
    try {
      const { identity } = await registerNew(s.http);
      await expect(SignalClient.connect(s.ws, identity, { protoVer: 1 })).rejects.toMatchObject({ code: 'VERSION' });
      const ok = await SignalClient.connect(s.ws, identity, { protoVer: 2 });
      ok.close();
    } finally {
      await s.stop();
    }
  });

  it('在线状态 90 秒有效期（这里缩短到 1 秒）：过期后目标视为离线，下一次心跳自动重新登记', async () => {
    const s = await startStack({ tunables: { presenceTtlSec: 1 } });
    try {
      const { identity, sig } = await onlineDevice(s);
      await sleep(1300);
      expect(await s.stores.presence.get(identity.deviceCode)).toBeNull();
      await sig.ping();
      expect(await s.stores.presence.get(identity.deviceCode)).not.toBeNull();
      sig.close();
    } finally {
      await s.stop();
    }
  });

  it('服务端优雅停止：已连接的客户端收到关闭码 1001', async () => {
    const s = await startStack();
    const { sig } = await onlineDevice(s);
    await s.stop();
    expect(await sig.closed).toBe(1001);
  });
});
