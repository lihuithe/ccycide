import { authSignString, decodeB64Exact, newUlid, verifyEd25519 } from '../crypto.js';
import type { DeviceRecord } from '../db/repos/index.js';
import { signTicket } from '../relay/ticket.js';
import type { PresenceInfo } from '../store/index.js';
import { banTargetFor, ipToBuffer, rateKeyIp } from '../util/ip.js';
import { versionLt } from '../util/version.js';
import type { Conn } from './conn.js';
import { CLOSE, protoCompatible, type AuthErrCode, type ConnectErrCode, type Msg } from './protocol.js';
import type { SignalServer } from './server.js';
import { markAccepted, markAuthed, markClosed, markFailed } from './sessions.js';
import { GUARD } from '../service/guard.js';

/**
 * 等待被控端处理的连接请求（保存在主控端所在的实例上）。
 * 票据在被控端同意之后才签发；没有固定超时，被控端开启“连接确认”时会一直等到用户操作。
 */
export interface Pending {
  sid: string;
  controller: Conn;
  reqId?: string;
  hostCode: string;
  hostDeviceId: number;
  /** 被控端当时所在的实例和连接，用于跨实例投递 connect.go / connect.cancelled，以及判断被控端是否已经丢失 */
  hostInstanceId: string;
  hostConnId: string;
  hostUid: string;
  controllerUid: string;
  peer: { public_key: string; platform: string; proto_ver: number };
  timer: NodeJS.Timeout;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

// ---------- 认证 ----------

export async function handleAuth(srv: SignalServer, conn: Conn, msg: Msg): Promise<void> {
  const { ctx } = srv;
  const t = ctx.cfg.tunables;
  const fail = (code: AuthErrCode, closeCode: number = CLOSE.AUTH): void => {
    ctx.m.authResults.inc({ result: code });
    conn.dead = true;
    conn.send('auth.err', { code }, msg.id);
    conn.close(closeCode, `auth failed ${code}`);
  };

  const deviceId = str(msg.d.device_id, 64);
  const sigB64 = str(msg.d.sig, 256);
  const appVersion = msg.d.app_version === undefined ? '' : str(msg.d.app_version, 32);
  const protoVer = msg.d.proto_ver === undefined ? 1 : msg.d.proto_ver;
  if (!deviceId || !sigB64 || appVersion === null || typeof protoVer !== 'number' || !Number.isInteger(protoVer) || protoVer < 1 || protoVer > 1000) {
    return fail('BAD_REQUEST');
  }
  const minProto = msg.d.min_proto_ver === undefined ? 1 : msg.d.min_proto_ver;
  if (typeof minProto !== 'number' || !Number.isInteger(minProto) || minProto < 1 || minProto > protoVer) return fail('BAD_REQUEST');

  let device: DeviceRecord | null;
  try {
    device = await ctx.devices.getByUid(deviceId);
  } catch (err) {
    ctx.log.error({ err: (err as Error).message }, '认证时查询设备失败');
    return fail('INTERNAL');
  }
  if (!device) return fail('UNKNOWN_DEVICE');

  const sig = decodeB64Exact(sigB64, 64);
  const okSig = sig !== null && verifyEd25519(device.publicKey, Buffer.from(authSignString(conn.nonce, deviceId), 'utf8'), sig);
  if (!okSig) {
    // 同一 IP 反复签名失败：限流
    const rl = await ctx.stores.limiter.hit(`authfail:ip:${rateKeyIp(conn.ip)}`, 30, 60_000).catch(() => ({ allowed: false }));
    return fail(rl.allowed ? 'BAD_SIGNATURE' : 'RATE_LIMITED');
  }

  // 封禁检查放在验签之后，避免向未证明身份的人泄露封禁状态
  try {
    const ban = device.status === 1 ? { reason: 'device' } : await ctx.repos.bans.findActive({ deviceUid: device.uid, ip: conn.ip });
    if (ban) return fail('BANNED', CLOSE.BANNED);
  } catch (err) {
    ctx.log.error({ err: (err as Error).message }, '认证时查询封禁失败');
    return fail('INTERNAL');
  }

  if (protoVer < t.minProtoVer) return fail('VERSION');

  conn.device = device;
  conn.appVersion = appVersion;
  conn.protoVer = protoVer;
  conn.minProtoVer = minProto;
  const accept = typeof msg.d.accept === 'boolean' ? msg.d.accept : true;

  // 登记在线状态；同一设备只允许一条信令连接，旧连接被踢
  const oldLocal = srv.byCode.get(device.code);
  let prev: PresenceInfo | null = null;
  try {
    prev = await ctx.stores.presence.set(device.code, buildPresence(srv, conn, accept));
  } catch (err) {
    ctx.log.error({ err: (err as Error).message }, '登记在线状态失败');
    return fail('INTERNAL');
  }
  srv.byCode.set(device.code, conn);
  conn.state = 'ready';
  if (oldLocal && oldLocal !== conn) srv.kickConn(oldLocal, 'replaced');
  if (prev && prev.instanceId !== srv.instanceId && prev.connId !== conn.id) {
    await ctx.stores.bus.publish(prev.instanceId, { k: 'kick', code: device.code, connId: prev.connId, reason: 'replaced' }).catch(() => {});
  }
  ctx.m.onlineDevices.set(srv.byCode.size);
  ctx.m.authResults.inc({ result: 'ok' });
  touchSeen(srv, conn);

  conn.send('auth.ok', { device_code: device.code, heartbeat_sec: t.heartbeatSec }, msg.id);

  // 强制升级通知，以及配置里的运营通知
  try {
    const pub = await ctx.configService.get();
    if (appVersion && versionLt(appVersion, pub.min_app_version)) {
      conn.send('notice', { level: 'force_upgrade', text: `当前版本 ${appVersion} 低于最低支持版本 ${pub.min_app_version}，请升级后使用` });
    }
    if (pub.notice) conn.send('notice', pub.notice);
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, '读取配置发送通知失败');
  }
}

function buildPresence(srv: SignalServer, conn: Conn, accept: boolean): PresenceInfo {
  const d = conn.device!;
  return {
    instanceId: srv.instanceId,
    connId: conn.id,
    deviceId: d.id,
    deviceUid: d.uid,
    deviceCode: d.code,
    accept,
    protoVer: conn.protoVer,
    minProtoVer: conn.minProtoVer,
    platform: d.platform,
    publicKey: d.publicKey.toString('base64'),
    appVersion: conn.appVersion,
    ip: conn.ip,
    region: '',
  };
}

/** devices.last_seen_at 节流：同一设备每 5 分钟最多写一次库 */
function touchSeen(srv: SignalServer, conn: Conn): void {
  const d = conn.device!;
  const now = Date.now();
  const last = srv.lastTouch.get(d.uid) ?? 0;
  if (now - last < srv.ctx.cfg.tunables.lastSeenThrottleMs) return;
  srv.lastTouch.set(d.uid, now);
  if (srv.lastTouch.size > 200_000) srv.lastTouch.clear();
  srv.ctx.repos.devices.touchSeen(d.id, ipToBuffer(conn.ip), new Date(now), conn.appVersion || undefined).catch((err) => {
    srv.ctx.log.warn({ err: (err as Error).message }, '更新 last_seen_at 失败');
  });
}

// ---------- 消息分发 ----------

export async function dispatch(srv: SignalServer, conn: Conn, msg: Msg): Promise<void> {
  const { ctx } = srv;
  const dev = conn.device!;
  switch (msg.t) {
    case 'ping': {
      try {
        const ok = await ctx.stores.presence.refresh(dev.code, conn.id);
        // 在线状态丢了（Redis 重启、过期）：重新登记
        if (!ok && srv.byCode.get(dev.code) === conn) {
          const cur = await ctx.stores.presence.get(dev.code);
          await ctx.stores.presence.set(dev.code, buildPresence(srv, conn, cur?.connId === conn.id ? cur.accept : true));
        }
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, '续期在线状态失败');
      }
      touchSeen(srv, conn);
      conn.send('pong', {}, msg.id);
      return;
    }
    case 'presence.update': {
      if (typeof msg.d.accept !== 'boolean') return conn.send('error', { code: 'BAD_REQUEST', message: 'accept 必须是布尔值' }, msg.id);
      await ctx.stores.presence.setAccept(dev.code, conn.id, msg.d.accept);
      return;
    }
    case 'connect.request':
      return onConnectRequest(srv, conn, msg);
    case 'connect.accept':
    case 'connect.reject': {
      const sid = str(msg.d.session_id, 40);
      if (!sid) return conn.send('error', { code: 'BAD_REQUEST', message: '缺少 session_id' }, msg.id);
      let reason: string | undefined;
      if (typeof msg.d.reason === 'string' && /^[a-z0-9_.-]{1,32}$/i.test(msg.d.reason)) reason = msg.d.reason;
      await srv.routeHostReply(conn, msg.t === 'connect.accept' ? 'accept' : 'reject', sid, reason);
      return;
    }
    case 'connect.cancel': {
      // 主控端取消等待：只有发起这个请求的主控端本人有效
      const sid = str(msg.d.session_id, 40);
      if (!sid) return conn.send('error', { code: 'BAD_REQUEST', message: '缺少 session_id' }, msg.id);
      const p = srv.pending.get(sid);
      if (p && p.controller === conn) await resolvePending(srv, p, 'cancel', 'cancelled');
      return;
    }
    case 'session.report':
      return onSessionReport(srv, conn, msg);
    case 'auth':
      return conn.send('error', { code: 'ALREADY_AUTHED' }, msg.id);
    default:
      return conn.send('error', { code: 'UNKNOWN_TYPE', t: msg.t.slice(0, 32) }, msg.id);
  }
}

// ---------- 发起连接 ----------

async function onConnectRequest(srv: SignalServer, conn: Conn, msg: Msg): Promise<void> {
  const { ctx } = srv;
  const t = ctx.cfg.tunables;
  const dev = conn.device!;
  const err = (code: ConnectErrCode, result: string, extra: Record<string, unknown> = {}): void => {
    ctx.m.connectResults.inc({ result });
    conn.send('connect.err', { code, ...extra }, msg.id);
  };

  const target = typeof msg.d.target_code === 'string' ? msg.d.target_code : '';
  const validCode = /^\d{9,12}$/.test(target) && target !== dev.code;

  // 1. 查目标在线状态（Redis 不可用时降级为拒绝新的连接请求）
  let presence: PresenceInfo | null = null;
  if (validCode) {
    try {
      presence = await ctx.stores.presence.get(target);
    } catch (e) {
      ctx.log.error({ err: (e as Error).message }, 'Redis 不可用，拒绝连接请求');
      return err('NO_RELAY', 'store_error');
    }
  }
  const online = presence !== null && presence.accept;

  // 2. 枚举检测：来源设备连续请求不存在 / 不在线的设备码（先于限流计数，否则被限流的枚举者永远累计不到阈值）
  if (!online) {
    // 计数存储出错时 fail-closed（与后面的限流一致），不能让存储故障变成免检
    let miss: { count: number; ban: boolean; sourceCount: number };
    try {
      miss = await ctx.guard.recordMiss(dev.uid, rateKeyIp(conn.ip));
    } catch (e) {
      ctx.log.error({ err: (e as Error).message }, '枚举计数存储不可用，拒绝连接请求');
      return err('NO_RELAY', 'store_error');
    }
    if (miss.ban) {
      const expires = new Date(Date.now() + GUARD.missBanSec * 1000);
      await ctx.repos.bans.add({ kind: 'device', value: dev.uid, reason: '疑似枚举设备码', source: 'auto', expiresAt: expires, createdBy: 'system' }).catch((e) => ctx.log.error({ err: (e as Error).message }, '写入自动封禁失败'));
      // 同时封来源（IPv4 单个地址、IPv6 整个 /64），否则换一个新注册的设备就能继续枚举
      const src = banTargetFor(conn.ip);
      await ctx.repos.bans.add({ kind: src.kind, value: src.value, reason: '疑似枚举设备码（来源）', source: 'auto', expiresAt: expires, createdBy: 'system' }).catch((e) => ctx.log.error({ err: (e as Error).message }, '写入来源自动封禁失败'));
      await ctx.repos.events.add({ type: 'enum_suspected', sourceDeviceId: dev.id, sourceIp: ipToBuffer(conn.ip), detail: { misses: miss.count, source_misses: miss.sourceCount, source_ban: src.value, ban_sec: GUARD.missBanSec } });
      ctx.m.connectResults.inc({ result: 'enum_banned' });
      srv.kickConn(conn, 'banned');
      return;
    }
  }

  // 3. 限流
  const rate: Array<[string, number, number]> = [
    [`cr:dev:min:${dev.uid}`, t.connectPerMinDevice, 60_000],
    [`cr:dev:hour:${dev.uid}`, t.connectPerHourDevice, 3600_000],
    [`cr:ip:min:${rateKeyIp(conn.ip)}`, t.connectPerMinIp, 60_000],
  ];
  if (validCode) rate.push([`cr:tgt:min:${target}`, t.connectPerMinTarget, 60_000]);
  let limited: number | null = null;
  try {
    for (const [key, limit, win] of rate) {
      const r = await ctx.stores.limiter.hit(key, limit, win);
      if (!r.allowed) {
        limited = Math.max(limited ?? 0, r.retryAfterMs);
      }
    }
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, '限流存储不可用，拒绝连接请求');
    return err('NO_RELAY', 'store_error');
  }
  if (limited !== null) {
    // 安全事件每分钟最多记一条，避免被刷
    if (await ctx.stores.kv.setNx(`rlevt:${dev.uid}`, '1', 60_000).catch(() => false)) {
      await ctx.repos.events.add({ type: 'rate_limited', sourceDeviceId: dev.id, sourceIp: ipToBuffer(conn.ip) });
    }
    return err('RATE_LIMITED', 'rate_limited', { retry_after: Math.ceil(limited / 1000) });
  }

  // 4. 目标不存在、不在线或不接受连接：统一 UNAVAILABLE（不区分，防枚举）
  if (!presence || !online) return err('UNAVAILABLE', 'unavailable');

  // 5. 被控端是否处于锁定状态
  try {
    if (await ctx.guard.getLock(target)) return err('LOCKED', 'locked');
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, '查询锁定状态失败，拒绝连接请求');
    return err('NO_RELAY', 'store_error');
  }

  // 6. 协议版本是否有交集
  if (!protoCompatible({ ver: conn.protoVer, min: conn.minProtoVer }, { ver: presence.protoVer, min: presence.minProtoVer })) {
    return err('VERSION', 'version');
  }

  // 7. 单设备同时会话数
  try {
    if ((await ctx.stores.tracker.count(dev.uid)) >= t.maxSessionsPerDevice) return err('RATE_LIMITED', 'too_many_sessions');
    if ((await ctx.stores.tracker.count(presence.deviceUid)) >= t.maxSessionsPerHost) return err('UNAVAILABLE', 'host_busy');
    // 被控端同时挂起（等用户确认）的请求数上限，防止有人刷一堆弹窗
    if ((await ctx.stores.tracker.count(`hp:${presence.deviceUid}`)) >= t.maxPendingPerHost) {
      return err('RATE_LIMITED', 'host_pending_full', { reason: 'host_pending_full' });
    }
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, '查询会话数失败，拒绝连接请求');
    return err('NO_RELAY', 'store_error');
  }

  // 8. 选中继节点（只用来提前发现 NO_RELAY；真正使用的节点在被控端同意时重新选择）
  let node;
  try {
    node = await ctx.relays.pick(presence.region || undefined);
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, '选择中继节点失败');
    return err('NO_RELAY', 'store_error');
  }
  if (!node) return err('NO_RELAY', 'no_relay');

  // 9. 建会话（此时不签发票据）、记录同时会话计数
  const sid = newUlid();
  await ctx.repos.sessions.create({
    uid: sid,
    controllerDeviceId: dev.id,
    hostDeviceId: presence.deviceId,
    relayNode: node.name,
    controllerIp: ipToBuffer(conn.ip),
    hostIp: ipToBuffer(presence.ip),
  });
  ctx.collector.inc('sessionsTotal');
  const pendingMs = t.connectPendingMaxSec * 1000;
  await ctx.stores.tracker.touch(dev.uid, sid, pendingMs + 90_000).catch(() => {});
  await ctx.stores.tracker.touch(presence.deviceUid, sid, pendingMs + 90_000).catch(() => {});
  await ctx.stores.tracker.touch(`hp:${presence.deviceUid}`, sid, pendingMs + 90_000).catch(() => {});

  // 10. 挂起请求，先告诉主控端“已送达、等待对方处理”，再向被控端投递；没有固定超时
  const pending: Pending = {
    sid,
    controller: conn,
    reqId: msg.id,
    hostCode: presence.deviceCode,
    hostDeviceId: presence.deviceId,
    hostInstanceId: presence.instanceId,
    hostConnId: presence.connId,
    hostUid: presence.deviceUid,
    controllerUid: dev.uid,
    peer: { public_key: presence.publicKey, platform: presence.platform, proto_ver: presence.protoVer },
    // 兜底上限，仅用于防泄漏：到期按 REJECTED(timeout) 处理
    timer: setTimeout(() => void resolvePending(srv, pending, 'reject', 'timeout'), pendingMs),
  };
  srv.pending.set(sid, pending);
  conn.pendingSessions.add(sid);
  conn.send('connect.pending', { session_id: sid }, msg.id);

  // 投递失败（被控端连接已不在、跨实例总线不可用、对方实例已退出）要立即告诉主控端，不能让它一直挂着
  let delivered = false;
  try {
    delivered = await srv.deliverIncoming(
      presence,
      sid,
      {
        session_id: sid,
        from: { device_code: dev.code, platform: dev.platform, public_key: dev.publicKey.toString('base64'), region: '' },
      },
      { code: dev.code, connId: conn.id },
    );
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, '投递 connect.incoming 失败');
  }
  if (!delivered) await resolvePending(srv, pending, 'reject', 'deliver_failed');
}

/**
 * 结束一个等待项。每个等待项只会被处理一次。
 *  accept ：被控端同意 -> 此刻才签发两张票据，被控端收 connect.go，主控端收 connect.ok
 *  reject ：被控端拒绝 / 被控端离线或丢失 / 投递失败 / 兜底超时 -> 主控端收 connect.err
 *  cancel ：主控端主动取消 -> 通知被控端撤掉弹窗
 *  fail   ：主控端断开或丢失 -> 通知被控端撤掉弹窗
 */
export async function resolvePending(srv: SignalServer, p: Pending, action: 'accept' | 'reject' | 'cancel' | 'fail', reason?: string): Promise<void> {
  const { ctx } = srv;
  const t = ctx.cfg.tunables;
  if (srv.pending.get(p.sid) !== p) return;
  srv.pending.delete(p.sid);
  clearTimeout(p.timer);
  p.controller.pendingSessions.delete(p.sid);
  const release = async (): Promise<void> => {
    await ctx.stores.tracker.remove(p.controllerUid, p.sid).catch(() => {});
    await ctx.stores.tracker.remove(p.hostUid, p.sid).catch(() => {});
  };
  const notifyHostCancelled = (): Promise<void> =>
    srv.toHost(p, 'connect.cancelled', { session_id: p.sid }).catch((e) => ctx.log.warn({ err: (e as Error).message }, '通知被控端撤销弹窗失败'));
  try {
    await ctx.stores.tracker.remove(`hp:${p.hostUid}`, p.sid).catch(() => {});
    if (action === 'accept') {
      // 同意之后才选节点、签票据：等待可能持续很久，请求时选的节点未必还可用
      let node = null;
      try {
        node = await ctx.relays.pick();
      } catch (e) {
        ctx.log.error({ err: (e as Error).message }, '被控端同意后选择中继节点失败');
      }
      if (!node) {
        await markFailed(ctx, p.sid, 'no_relay');
        await release();
        ctx.m.connectResults.inc({ result: 'no_relay' });
        p.controller.send('connect.err', { code: 'NO_RELAY' }, p.reqId);
        await notifyHostCancelled();
        return;
      }
      await markAccepted(ctx, p.sid, node.name);
      const secret = ctx.cfg.ticketSecret;
      const ticketC = signTicket({ sid: p.sid, role: 'c', did: p.controllerUid, node: node.name }, secret, t.ticketTtlSec);
      const ticketH = signTicket({ sid: p.sid, role: 'h', did: p.hostUid, node: node.name }, secret, t.ticketTtlSec);
      // 同时会话计数从“等待”切换为“配对窗口”（之后由中继续期）
      await ctx.stores.tracker.touch(p.controllerUid, p.sid, 90_000).catch(() => {});
      await ctx.stores.tracker.touch(p.hostUid, p.sid, 90_000).catch(() => {});
      ctx.m.connectResults.inc({ result: 'ok' });
      await srv
        .toHost(p, 'connect.go', { session_id: p.sid, relay_url: node.publicUrl, ticket: ticketH })
        .catch((e) => ctx.log.warn({ err: (e as Error).message }, '投递 connect.go 失败'));
      p.controller.send('connect.ok', { session_id: p.sid, relay_url: node.publicUrl, ticket: ticketC, peer: p.peer }, p.reqId);
      return;
    }
    const why = reason ?? 'rejected';
    await markFailed(ctx, p.sid, why);
    await release();
    if (action === 'cancel' || action === 'fail') {
      ctx.m.connectResults.inc({ result: 'cancelled' });
      await notifyHostCancelled();
      return;
    }
    // 兜底超时：被控端界面上的弹窗也要撤掉
    if (why === 'timeout') await notifyHostCancelled();
    // 被控端因锁定拒绝 -> LOCKED；被控端已不在线 / 丢失 / 投递失败 -> UNAVAILABLE；其余都是 REJECTED
    const code: ConnectErrCode = why === 'locked' ? 'LOCKED' : why === 'unavailable' || why === 'deliver_failed' || why === 'host_gone' ? 'UNAVAILABLE' : 'REJECTED';
    ctx.m.connectResults.inc({ result: code.toLowerCase() });
    const extra = code === 'REJECTED' ? { code, reason: why } : why === 'deliver_failed' ? { code, reason: why } : { code };
    p.controller.send('connect.err', extra, p.reqId);
  } catch (e) {
    ctx.log.error({ err: (e as Error).message, sid: p.sid }, '处理连接答复出错');
    p.controller.send('connect.err', { code: 'NO_RELAY' }, p.reqId);
  }
}

// ---------- session.report ----------

async function onSessionReport(srv: SignalServer, conn: Conn, msg: Msg): Promise<void> {
  const { ctx } = srv;
  const dev = conn.device!;
  const sid = str(msg.d.session_id, 40);
  const event = str(msg.d.event, 32);
  if (!sid || !event) return conn.send('error', { code: 'BAD_REQUEST', message: '缺少 session_id 或 event' }, msg.id);
  const detail = typeof msg.d.detail === 'object' && msg.d.detail !== null ? (msg.d.detail as Record<string, unknown>) : {};

  const s = await ctx.repos.sessions.get(sid);
  if (!s) return;
  const isHost = s.hostDeviceId === dev.id;
  const isController = s.controllerDeviceId === dev.id;
  if (!isHost && !isController) return; // 与该会话无关的设备，忽略

  switch (event) {
    case 'auth_ok':
      await markAuthed(ctx, sid);
      return;
    case 'closed':
      await markClosed(ctx, sid);
      return;
    case 'auth_failed': {
      // 密码是被控端校验的，只接受被控端的上报，防止主控端或第三方伪造失败次数去锁别人
      if (!isHost) return;
      ctx.m.passwordFailures.inc();
      ctx.collector.inc('authFailures');
      await ctx.repos.events.add({
        type: 'auth_failed',
        targetDeviceId: dev.id,
        sourceDeviceId: s.controllerDeviceId,
        sourceIp: s.controllerIp,
        sessionUid: sid,
        detail: typeof detail.reason === 'string' ? { reason: detail.reason.slice(0, 64) } : null,
      });
      await markFailed(ctx, sid, 'auth_failed');
      // 服务端自己也计数：达到阈值就锁定，之后的 connect.request 直接返回 LOCKED
      const r = await ctx.guard.recordAuthFailure(dev.code);
      if (r.locked) {
        await ctx.repos.events.add({ type: 'host_locked', targetDeviceId: dev.id, sessionUid: sid, detail: { lock_sec: r.lockSec, by: 'server' } });
      }
      return;
    }
    case 'host_locked': {
      // 被控端自己锁定（带锁定时长），服务端同步设置标记
      if (!isHost) return;
      const raw = detail.lock_sec ?? detail.duration_sec ?? detail.seconds;
      const sec = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(raw, GUARD.lockMaxSec) : GUARD.lockBaseSec;
      await ctx.guard.lockHost(dev.code, sec, 'host_locked');
      await ctx.repos.events.add({ type: 'host_locked', targetDeviceId: dev.id, sessionUid: sid, detail: { lock_sec: sec, by: 'host' } });
      return;
    }
    default:
      return conn.send('error', { code: 'BAD_REQUEST', message: '未知的 event' }, msg.id);
  }
}
