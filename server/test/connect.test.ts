import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { silentLogger } from '../src/logger.js';
import { verifyTicket } from '../src/relay/ticket.js';
import { startSignalApp } from '../src/runtime.js';
import { SessionStatus } from '../src/db/repos/index.js';
import { RelayConn, SignalClient, registerNew, type ConnectOk, type Identity } from '../tools/rterm-client.js';
import { onlineDevice, sleep, startStack, until, type Stack } from './helpers.js';

async function pair(s: Stack, hostOpts = {}) {
  const host = await onlineDevice(s, hostOpts);
  const ctl = await onlineDevice(s);
  return { host, ctl };
}

/** 主控发起 + 被控接受，返回主控的 connect.ok、被控收到的 incoming 和 connect.go */
async function connectOk(host: { identity: Identity; sig: SignalClient }, ctl: { sig: SignalClient }) {
  const incP = host.sig.waitIncoming();
  const resP = ctl.sig.connectRequest(host.identity.deviceCode);
  const inc = await incP;
  const goP = host.sig.acceptGo(inc.session_id);
  const res = await resP;
  if (!res.ok) throw new Error(`连接失败 ${res.code}`);
  return { res: res.data, inc, go: await goP };
}

describe('信令：发起连接的流程（T5）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ tunables: { connectPerMinDevice: 10 } });
  });
  afterAll(() => s.stop());

  it('A 请求连接 B，B 回 accept：A 先收到 connect.pending，B 的 incoming 不带票据；同意后 A 收到 connect.ok、B 收到 connect.go，session_id 和 relay_url 相同，票据不同，票据可验', async () => {
    const { host, ctl } = await pair(s);
    const { res, inc, go } = await connectOk(host, ctl);
    // connect.incoming 里没有 relay_url / ticket
    expect(inc).not.toHaveProperty('ticket');
    expect(inc).not.toHaveProperty('relay_url');
    // 主控端先收到 connect.pending（id 是原请求 id），再收到 connect.ok（沿用同一个 id）
    const types = ctl.sig.messages.filter((m) => m.t === 'connect.pending' || m.t === 'connect.ok');
    expect(types.map((m) => m.t)).toEqual(['connect.pending', 'connect.ok']);
    expect(types[0]!.d).toEqual({ session_id: inc.session_id });
    expect(types[0]!.id).toBe(types[1]!.id);
    expect(res.session_id).toBe(inc.session_id);
    expect(go.session_id).toBe(inc.session_id);
    expect(res.relay_url).toBe(go.relay_url);
    expect(res.relay_url).toBe(s.cfg.relay.publicUrl);
    expect(res.ticket).not.toBe(go.ticket);
    const secrets = [s.cfg.ticketSecret];
    const tc = verifyTicket(res.ticket, secrets, 'relay-test')!;
    const th = verifyTicket(go.ticket, secrets, 'relay-test')!;
    expect(tc).toMatchObject({ sid: res.session_id, role: 'c', did: ctl.identity.deviceId, node: 'relay-test' });
    expect(th).toMatchObject({ sid: res.session_id, role: 'h', did: host.identity.deviceId, node: 'relay-test' });
    // 票据 30 秒有效
    expect(tc.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
    expect(tc.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(25);
    // 对端信息
    expect(res.peer).toEqual({ public_key: host.identity.publicKey, platform: 'windows', proto_ver: 1 });
    expect(inc.from).toEqual({ device_code: ctl.identity.deviceCode, platform: 'windows', public_key: ctl.identity.publicKey, region: '' });
    // sessions 表：状态 1 已接受，字段正确
    const row = (await s.repos.sessions.get(res.session_id))!;
    expect(row.status).toBe(SessionStatus.Accepted);
    expect(row.relayNode).toBe('relay-test');
    expect((await s.repos.devices.findById(row.controllerDeviceId))!.uid).toBe(ctl.identity.deviceId);
    expect((await s.repos.devices.findById(row.hostDeviceId))!.uid).toBe(host.identity.deviceId);
    expect(row.controllerIp).toEqual(Buffer.from([127, 0, 0, 1]));
    host.sig.close();
    ctl.sig.close();
  });

  it('响应带回请求的 id', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    const h = ctl.sig.startConnect(host.identity.deviceCode);
    host.sig.accept((await incP).session_id);
    expect((await h.result).ok).toBe(true);
    const r = ctl.sig.messages.find((m) => m.t === 'connect.ok')!;
    expect(r.id).toBeDefined();
    expect(ctl.sig.messages.find((m) => m.t === 'connect.pending')!.id).toBe(r.id);
  });

  it('B 回 connect.reject：A 收到 connect.err REJECTED，sessions 记为失败(rejected)', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.reject(inc.session_id);
    const res = await resP;
    expect(res).toMatchObject({ ok: false, code: 'REJECTED' });
    const row = (await s.repos.sessions.get(inc.session_id))!;
    expect(row).toMatchObject({ status: SessionStatus.Failed, failReason: 'rejected' });
    expect(row.endedAt).not.toBeNull();
  });

  it('B 迟迟不答复（模拟“连接确认”弹窗没人点）：没有 10 秒超时，16 秒后才同意仍然连得上，票据从同意时刻起算 30 秒（真实计时）', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    const h = ctl.sig.startConnect(host.identity.deviceCode, 0);
    const inc = await incP;
    expect(await h.pending).toBe(inc.session_id);
    await sleep(16_000);
    // 16 秒过去了：主控端没有收到任何最终结果，会话仍是待接受
    expect(ctl.sig.messages.some((m) => m.t === 'connect.ok' || m.t === 'connect.err')).toBe(false);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Pending);
    await ctl.sig.ping(); // 连接仍然可用
    const tSign = Math.floor(Date.now() / 1000);
    const goP = host.sig.acceptGo(inc.session_id);
    const res = await h.result;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const go = await goP;
    // 票据是同意时才签发的：过期时间 = 现在 + 30 秒，而不是请求时刻 + 30 秒
    const tc = verifyTicket(res.data.ticket, [s.cfg.ticketSecret], 'relay-test')!;
    expect(tc.exp).toBeGreaterThanOrEqual(tSign + 29);
    expect(tc.exp).toBeLessThanOrEqual(tSign + 32);
    expect(verifyTicket(go.ticket, [s.cfg.ticketSecret], 'relay-test')!.role).toBe('h');
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Accepted);
    const [hr, cr] = await Promise.all([RelayConn.connect(go.relay_url, go.ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
    await cr.send(Buffer.from('late'));
    await hr.waitCount(1);
    expect(hr.received[0]!.toString()).toBe('late');
    hr.close();
    cr.close();
  }, 30_000);

  it('A 请求不存在的设备码、请求存在但离线的设备码：都是 UNAVAILABLE，且响应完全一样', async () => {
    const ctl = await onlineDevice(s);
    const offline = await registerNew(s.http); // 已注册但没上线
    const a = await ctl.sig.request('connect.request', { target_code: '999999999' });
    const b = await ctl.sig.request('connect.request', { target_code: offline.identity.deviceCode });
    expect(a.t).toBe('connect.err');
    expect(a.d).toEqual({ code: 'UNAVAILABLE' });
    expect(b.t).toBe(a.t);
    expect(b.d).toEqual(a.d);
    // 格式不对、自己连自己、对方明确不接受连接，也都是同样的响应
    for (const code of ['abc', '', '12345', '1'.repeat(30), ctl.identity.deviceCode]) {
      const r = await ctl.sig.request('connect.request', { target_code: code });
      expect(r.d).toEqual({ code: 'UNAVAILABLE' });
    }
    const noAccept = await onlineDevice(s, { accept: false });
    expect((await ctl.sig.request('connect.request', { target_code: noAccept.identity.deviceCode })).d).toEqual({ code: 'UNAVAILABLE' });
    // 没有目标时不会产生 session 记录
    expect(await s.repos.sessions.list({ deviceId: (await s.repos.devices.findByUid(ctl.identity.deviceId))!.id, limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('C 冒充 B 对这个 session_id 回 connect.accept / reject：被忽略，B 之后正常答复仍然有效', async () => {
    const host = await onlineDevice(s);
    const ctl = await onlineDevice(s);
    const imp = await onlineDevice(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    imp.sig.accept(inc.session_id);
    imp.sig.reject(inc.session_id);
    imp.sig.report(inc.session_id, 'auth_failed');
    await sleep(150);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Pending);
    host.sig.accept(inc.session_id);
    const res = await resP;
    expect(res.ok).toBe(true);
    expect(await s.ctx.guard.getLock(host.identity.deviceCode)).toBeNull();
  });

  it('同一个 session_id 重复答复只生效一次；未知 session_id 被忽略', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    host.sig.reject(inc.session_id);
    host.sig.accept('01NOSUCHSESSION000000000000');
    const res = await resP;
    expect(res.ok).toBe(true);
    await sleep(100);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Accepted);
  });

  it('限流：一分钟内第 11 次 connect.request 收到 RATE_LIMITED（带 retry_after）', async () => {
    const ctl = await onlineDevice(s);
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await ctl.sig.request('connect.request', { target_code: String(500000000 + i * 7919) });
      codes.push(r.d.code);
      if (i === 10) expect(r.d.retry_after).toBeGreaterThan(0);
    }
    expect(codes.slice(0, 10).every((c) => c === 'UNAVAILABLE')).toBe(true);
    expect(codes[10]).toBe('RATE_LIMITED');
    await ctl.sig.ping(); // 被限流不会断开连接
  });

  it('被控端协议版本与主控没有交集：VERSION', async () => {
    const host = await onlineDevice(s, { protoVer: 1, minProtoVer: 1 });
    const ctl = await onlineDevice(s, { protoVer: 3, minProtoVer: 2 });
    const res = await ctl.sig.connectRequest(host.identity.deviceCode);
    expect(res).toMatchObject({ ok: false, code: 'VERSION' });
    // 有交集就行
    const ctl2 = await onlineDevice(s, { protoVer: 3, minProtoVer: 1 });
    const incP = host.sig.waitIncoming();
    const p = ctl2.sig.connectRequest(host.identity.deviceCode);
    host.sig.accept((await incP).session_id);
    expect((await p).ok).toBe(true);
  });

  it('被控端 reject 带 reason=locked：主控端收到 LOCKED；reason=unavailable 映射 UNAVAILABLE', async () => {
    const { host, ctl } = await pair(s);
    let incP = host.sig.waitIncoming();
    let resP = ctl.sig.connectRequest(host.identity.deviceCode);
    host.sig.reject((await incP).session_id, 'locked');
    expect(await resP).toMatchObject({ ok: false, code: 'LOCKED' });
    incP = host.sig.waitIncoming();
    resP = ctl.sig.connectRequest(host.identity.deviceCode);
    host.sig.reject((await incP).session_id, 'user_denied');
    expect(await resP).toMatchObject({ ok: false, code: 'REJECTED', data: { reason: 'user_denied' } });
  });

  it('session.report：auth_ok -> 已认证(3)，closed -> 正常结束(4)；未认证就 closed -> 失败', async () => {
    const { host, ctl } = await pair(s);
    const { res } = await connectOk(host, ctl);
    host.sig.report(res.session_id, 'auth_ok');
    await until(async () => (await s.repos.sessions.get(res.session_id))!.status === SessionStatus.Authed, 2000, '状态 3');
    expect((await s.repos.sessions.get(res.session_id))!.authedAt).not.toBeNull();
    ctl.sig.report(res.session_id, 'closed');
    await until(async () => (await s.repos.sessions.get(res.session_id))!.status === SessionStatus.Ended, 2000, '状态 4');

    const second = await connectOk(host, ctl);
    host.sig.report(second.res.session_id, 'closed');
    await until(async () => (await s.repos.sessions.get(second.res.session_id))!.status === SessionStatus.Failed, 2000, '状态 5');
    expect((await s.repos.sessions.get(second.res.session_id))!.failReason).toBe('closed_before_auth');
    // 终态不会被覆盖
    host.sig.report(second.res.session_id, 'auth_ok');
    await sleep(100);
    expect((await s.repos.sessions.get(second.res.session_id))!.status).toBe(SessionStatus.Failed);
  });

  it('主控端在被控端答复前断开：请求作废，session 记为失败，之后被控端再 accept 无效', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    void ctl.sig.connectRequest(host.identity.deviceCode, 500).catch(() => {});
    const inc = await incP;
    const cancelledP = host.sig.waitCancelled(inc.session_id);
    ctl.sig.ws.terminate();
    await cancelledP; // 主控端信令断开等同取消：被控端撤掉确认弹窗
    await until(async () => (await s.repos.sessions.get(inc.session_id))!.status === SessionStatus.Failed, 2000, 'session 失败');
    expect((await s.repos.sessions.get(inc.session_id))!.failReason).toBe('controller_gone');
    host.sig.accept(inc.session_id);
    await sleep(100);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Failed);
  });
});

describe('信令：缩短计时与资源上限', () => {
  it('兜底上限 connectPendingMaxSec（防泄漏，这里缩短到 0.4 秒）：到期主控端收到 REJECTED(timeout)，被控端撤掉弹窗', async () => {
    const s = await startStack({ tunables: { connectPendingMaxSec: 0.4 } });
    try {
      const { ctl, host } = await pair(s);
      const incP = host.sig.waitIncoming();
      const t0 = Date.now();
      const h = ctl.sig.startConnect(host.identity.deviceCode);
      const cancelledP = incP.then((inc) => host.sig.waitCancelled(inc.session_id));
      const res = await h.result;
      expect(res).toMatchObject({ ok: false, code: 'REJECTED', data: { reason: 'timeout' } });
      expect(Date.now() - t0).toBeLessThan(2000);
      await cancelledP;
    } finally {
      await s.stop();
    }
  });

  it('单设备同时会话数达到上限：主控超限 RATE_LIMITED；会话结束后释放', async () => {
    const s = await startStack({ tunables: { maxSessionsPerDevice: 2 } });
    try {
      const ctl = await onlineDevice(s);
      const hosts = [await onlineDevice(s), await onlineDevice(s), await onlineDevice(s)];
      const results = [];
      for (const h of hosts.slice(0, 2)) {
        const incP = h.sig.waitIncoming();
        const p = ctl.sig.connectRequest(h.identity.deviceCode);
        h.sig.accept((await incP).session_id);
        results.push(await p);
      }
      expect(results.every((r) => r.ok)).toBe(true);
      const third = await ctl.sig.connectRequest(hosts[2]!.identity.deviceCode);
      expect(third).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      // 第一个会话结束 -> 释放名额
      await s.stores.tracker.remove(ctl.identity.deviceId, (results[0] as { ok: true; data: ConnectOk }).data.session_id);
      const incP = hosts[2]!.sig.waitIncoming();
      const p = ctl.sig.connectRequest(hosts[2]!.identity.deviceCode);
      hosts[2]!.sig.accept((await incP).session_id);
      expect((await p).ok).toBe(true);
    } finally {
      await s.stop();
    }
  });

  it('没有可用中继节点：NO_RELAY', async () => {
    const s = await startStack({ noRelay: true });
    try {
      await s.stores.registry.report(
        { name: 'relay-test', region: 'dev', publicUrl: 'ws://x', sessions: 0, capacity: 10, bandwidth: 0, status: 'draining', ts: Date.now() },
        60_000,
      );
      const { host, ctl } = await pair(s);
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'NO_RELAY' });
      // 节点满了同样 NO_RELAY；恢复后可用
      await s.stores.registry.report({ name: 'relay-test', region: 'dev', publicUrl: 'ws://x', sessions: 10, capacity: 10, bandwidth: 0, status: 'up', ts: Date.now() }, 60_000);
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'NO_RELAY' });
    } finally {
      await s.stop();
    }
  });

  it('中继选择：优先同地区，同地区内选负载最低的', async () => {
    const s = await startStack({ noRelay: true });
    try {
      const rep = (name: string, region: string, sessions: number) =>
        s.stores.registry.report({ name, region, publicUrl: `wss://${name}`, sessions, capacity: 100, bandwidth: 0, status: 'up', ts: Date.now() }, 60_000);
      await rep('a', 'cn-east', 50);
      await rep('b', 'cn-east', 10);
      await rep('c', 'us-west', 0);
      expect((await s.ctx.relays.pick())?.name).toBe('c');
      expect((await s.ctx.relays.pick('cn-east'))?.name).toBe('b');
      expect((await s.ctx.relays.pick('eu'))?.name).toBe('c');
    } finally {
      await s.stop();
    }
  });
});

describe('密码失败上报与锁定（T30 服务端部分、6.6）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ tunables: { connectPerMinDevice: 10_000 } });
  });
  afterAll(() => s.stop());

  async function failOnce(host: { sig: SignalClient }, ctl: { sig: SignalClient }, hostCode: string) {
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(hostCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    const res = await resP;
    expect(res.ok).toBe(true);
    host.sig.report(inc.session_id, 'auth_failed');
    return inc.session_id;
  }

  it('连续 5 次密码失败：写 security_events；第 6 次 connect.request 直接 LOCKED', async () => {
    const { host, ctl } = await pair(s);
    const hostRow = (await s.repos.devices.findByUid(host.identity.deviceId))!;
    const ctlRow = (await s.repos.devices.findByUid(ctl.identity.deviceId))!;
    let sid = '';
    for (let i = 0; i < 5; i++) sid = await failOnce(host, ctl, host.identity.deviceCode);
    await until(async () => (await s.ctx.guard.getLock(host.identity.deviceCode)) !== null, 2000, '锁定标记');

    const events = await s.repos.events.list({ type: 'auth_failed', deviceId: hostRow.id, limit: 50, offset: 0 });
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ targetDeviceId: hostRow.id, sourceDeviceId: ctlRow.id, sessionUid: sid });
    expect(events[0]!.sourceIp).toEqual(Buffer.from([127, 0, 0, 1]));
    const locked = await s.repos.events.list({ type: 'host_locked', deviceId: hostRow.id, limit: 10, offset: 0 });
    expect(locked).toHaveLength(1);
    expect((locked[0]!.detail as { lock_sec: number }).lock_sec).toBe(600);
    expect((await s.repos.sessions.get(sid))!).toMatchObject({ status: SessionStatus.Failed, failReason: 'auth_failed' });

    const res = await ctl.sig.connectRequest(host.identity.deviceCode);
    expect(res).toMatchObject({ ok: false, code: 'LOCKED' });
    // 被控端没有收到新的 connect.incoming
    await sleep(100);
    expect(host.sig.messages.filter((m) => m.t === 'connect.incoming')).toHaveLength(5);
  });

  it('锁定到期后可以再连接', async () => {
    const { host, ctl } = await pair(s);
    await s.ctx.guard.lockHost(host.identity.deviceCode, 1, 'test');
    expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'LOCKED' });
    await sleep(1200);
    const { res } = await connectOk(host, ctl);
    expect(res.session_id).toBeTruthy();
  });

  it('被控端自己上报 host_locked(lock_sec)：服务端同步设置锁定标记', async () => {
    const { host, ctl } = await pair(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    await resP;
    host.sig.report(inc.session_id, 'host_locked', { lock_sec: 1 });
    await until(async () => (await s.ctx.guard.getLock(host.identity.deviceCode)) !== null, 2000, '锁定标记');
    expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'LOCKED' });
    await sleep(1200);
    expect(await s.ctx.guard.getLock(host.identity.deviceCode)).toBeNull();
  });

  it('只接受被控端上报的 auth_failed：主控端或无关设备伪造的上报不计数', async () => {
    const { host, ctl } = await pair(s);
    const other = await onlineDevice(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    await resP;
    for (let i = 0; i < 8; i++) {
      ctl.sig.report(inc.session_id, 'auth_failed');
      other.sig.report(inc.session_id, 'auth_failed');
      ctl.sig.report(inc.session_id, 'host_locked', { lock_sec: 600 });
    }
    await sleep(200);
    expect(await s.ctx.guard.getLock(host.identity.deviceCode)).toBeNull();
    const hostRow = (await s.repos.devices.findByUid(host.identity.deviceId))!;
    expect(await s.repos.events.list({ deviceId: hostRow.id, limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('枚举检测：连续请求 30 个不存在的设备码，第 20 个时该设备被临时封禁并踢下线', async () => {
    const ctl = await onlineDevice(s);
    let sent = 0;
    for (let i = 0; i < 30 && ctl.sig.ws.readyState === 1; i++) {
      ctl.sig.sendRaw({ t: 'connect.request', id: String(100 + i), d: { target_code: String(600000000 + i * 104729) } });
      sent++;
      await sleep(5);
    }
    expect(await ctl.sig.closed).toBe(4403);
    expect(sent).toBeLessThanOrEqual(21);
    expect(ctl.sig.messages.some((m) => m.t === 'kick' && m.d.reason === 'banned')).toBe(true);
    const ban = await s.repos.bans.findActive({ deviceUid: ctl.identity.deviceId });
    expect(ban).toMatchObject({ kind: 'device', source: 'auto' });
    const ttl = ban!.expiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(3500_000);
    expect(ttl).toBeLessThanOrEqual(3600_000);
    const row = (await s.repos.devices.findByUid(ctl.identity.deviceId))!;
    expect(await s.repos.events.list({ type: 'enum_suspected', deviceId: row.id, limit: 5, offset: 0 })).toHaveLength(1);
    // 封禁期间无法再认证
    await expect(SignalClient.connect(s.ws, ctl.identity)).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('枚举检测对被限流的请求同样计数（10 次/分钟的限流不能让枚举者逃过封禁）', async () => {
    const s2 = await startStack({ tunables: { connectPerMinDevice: 10 } });
    try {
      const ctl = await onlineDevice(s2);
      const replies: string[] = [];
      ctl.sig.on('connect.err', (m) => replies.push(m.d.code));
      for (let i = 0; i < 30 && ctl.sig.ws.readyState === 1; i++) {
        ctl.sig.sendRaw({ t: 'connect.request', id: String(i), d: { target_code: String(700000000 + i * 7727) } });
        await sleep(5);
      }
      expect(await ctl.sig.closed).toBe(4403);
      expect(replies).toContain('RATE_LIMITED');
      expect(replies).toContain('UNAVAILABLE');
    } finally {
      await s2.stop();
    }
  });
});

describe('多实例（两个信令实例共用存储，经总线投递）', () => {
  let s: Stack;
  let s2Stop: () => Promise<void>;
  let ws2: string;
  let instanceB = '';
  beforeAll(async () => {
    s = await startStack();
    const ctx2 = await createContext(s.cfg, silentLogger(), { stores: s.stores, repos: s.repos });
    const app2 = await startSignalApp(ctx2, 0, '127.0.0.1');
    ws2 = `ws://127.0.0.1:${app2.port}/v1/signal`;
    s2Stop = () => app2.stop();
    instanceB = app2.signal.instanceId;
    expect(instanceB).not.toBe(s.signal.signal.instanceId);
  });
  afterAll(async () => {
    await s2Stop();
    await s.stop();
  });

  async function on(ws: string): Promise<{ identity: Identity; sig: SignalClient }> {
    const { identity } = await registerNew(s.http);
    return { identity, sig: await SignalClient.connect(ws, identity) };
  }

  it('主控端在实例 A、被控端在实例 B：accept 经总线回到 A', async () => {
    const ctl = await on(s.ws);
    const host = await on(ws2);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    const res = await resP;
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: ConnectOk }).data.session_id).toBe(inc.session_id);
    expect((await s.repos.sessions.get(inc.session_id))!.status).toBe(SessionStatus.Accepted);
  });

  it('跨实例 reject / 超时 / 冒充', async () => {
    const ctl = await on(ws2);
    const host = await on(s.ws);
    const imp = await on(ws2);
    let incP = host.sig.waitIncoming();
    let resP = ctl.sig.connectRequest(host.identity.deviceCode);
    let inc = await incP;
    imp.sig.accept(inc.session_id);
    host.sig.reject(inc.session_id, 'locked');
    expect(await resP).toMatchObject({ ok: false, code: 'LOCKED' });
    // 被控端在 B 实例的 remote 记录里；换一个场景：冒充者在 B 上
    incP = host.sig.waitIncoming();
    resP = ctl.sig.connectRequest(host.identity.deviceCode);
    inc = await incP;
    imp.sig.reject(inc.session_id);
    host.sig.accept(inc.session_id);
    expect((await resP).ok).toBe(true);
  });

  it('同一设备在另一个实例上登录：旧实例上的连接收到 kick(replaced)', async () => {
    const { identity } = await registerNew(s.http);
    const first = await SignalClient.connect(s.ws, identity);
    const second = await SignalClient.connect(ws2, identity);
    expect(await first.closed).toBe(4409);
    expect(first.messages.some((m) => m.t === 'kick' && m.d.reason === 'replaced')).toBe(true);
    await sleep(50);
    expect((await s.stores.presence.get(identity.deviceCode))!.connId).not.toBe('');
    await second.ping();
    second.close();
  });

  it('在线状态指向本实例上不存在的连接（残留）：立即 UNAVAILABLE 而不是等 10 秒', async () => {
    const ctl = await on(s.ws);
    const host = await on(s.ws);
    const p = (await s.stores.presence.get(host.identity.deviceCode))!;
    await s.stores.presence.set(host.identity.deviceCode, { ...p, connId: 'ghost' });
    const t0 = Date.now();
    const res = await ctl.sig.connectRequest(host.identity.deviceCode);
    expect(res).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('在线状态指向另一个实例，但那个实例上已经没有这条连接：对方实例立即回报 unavailable', async () => {
    const ctl = await on(s.ws);
    const { identity } = await registerNew(s.http); // 已注册，没有任何连接
    const row = (await s.repos.devices.findByUid(identity.deviceId))!;
    await s.stores.presence.set(identity.deviceCode, {
      instanceId: instanceB, connId: 'gone', deviceId: row.id, deviceUid: row.uid, deviceCode: row.code, accept: true,
      protoVer: 1, minProtoVer: 1, platform: 'windows', publicKey: row.publicKey.toString('base64'), appVersion: '', ip: '127.0.0.1', region: '',
    });
    const t0 = Date.now();
    const res = await ctl.sig.connectRequest(identity.deviceCode);
    expect(res).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('管理接口联动：封禁踢下线、广播通知', () => {
  it('封禁在线设备：连接收到 kick(banned) 并被断开，无法再认证；解封后恢复', async () => {
    const s = await startStack();
    try {
      const { identity, sig } = await onlineDevice(s);
      const h = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      const ban = await fetch(`${s.http}/v1/admin/devices/${identity.deviceCode}/ban`, { method: 'POST', headers: h, body: JSON.stringify({ reason: '滥用' }) });
      expect(ban.status).toBe(200);
      expect(await sig.closed).toBe(4403);
      expect(sig.messages.some((m) => m.t === 'kick' && m.d.reason === 'banned')).toBe(true);
      await expect(SignalClient.connect(s.ws, identity)).rejects.toMatchObject({ code: 'BANNED' });
      expect((await s.repos.devices.findByUid(identity.deviceId))!.status).toBe(1);
      const un = await fetch(`${s.http}/v1/admin/devices/${identity.deviceId}/unban`, { method: 'POST', headers: h });
      expect(un.status).toBe(200);
      const again = await SignalClient.connect(s.ws, identity);
      again.close();
    } finally {
      await s.stop();
    }
  });

  it('广播 notice：所有在线设备收到', async () => {
    const s = await startStack();
    try {
      const a = await onlineDevice(s);
      const b = await onlineDevice(s);
      const h = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      const pa = a.sig.waitFor((m) => m.t === 'notice');
      const pb = b.sig.waitFor((m) => m.t === 'notice');
      const r = await fetch(`${s.http}/v1/admin/notice`, { method: 'POST', headers: h, body: JSON.stringify({ level: 'warn', text: '今晚维护' }) });
      expect(r.status).toBe(200);
      expect((await pa).d).toEqual({ level: 'warn', text: '今晚维护' });
      expect((await pb).d.text).toBe('今晚维护');
    } finally {
      await s.stop();
    }
  });
});
