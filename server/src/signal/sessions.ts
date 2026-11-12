import type { Ctx } from '../context.js';
import { SessionStatus } from '../db/repos/index.js';
import type { RelaySessionEvent } from '../store/index.js';
import { utcDate } from '../util/time.js';

/**
 * 会话状态机（sessions.status）：
 * 0 待接受 -> 1 已接受 -> 2 已配对 -> 3 已认证 -> 4 正常结束；任何阶段可到 5 失败。
 * 状态只往前走，终态（4、5）不会被覆盖，只补写字节数。
 */
const S = SessionStatus;

export async function markAccepted(ctx: Ctx, uid: string, relayNode?: string): Promise<void> {
  await ctx.repos.sessions.transition(uid, { status: S.Accepted, relayNode }, [S.Pending]);
}

export async function markFailed(ctx: Ctx, uid: string, reason: string): Promise<void> {
  await ctx.repos.sessions.transition(uid, { status: S.Failed, failReason: reason, endedAt: new Date() }, [S.Pending, S.Accepted, S.Paired]);
}

export async function markAuthed(ctx: Ctx, uid: string): Promise<boolean> {
  const ok = await ctx.repos.sessions.transition(uid, { status: S.Authed, authedAt: new Date() }, [S.Pending, S.Accepted, S.Paired]);
  if (ok) ctx.collector.inc('sessionsAuthed');
  return ok;
}

/** 一方上报 closed：已认证的算正常结束，没认证就结束的算失败 */
export async function markClosed(ctx: Ctx, uid: string): Promise<void> {
  const ended = await ctx.repos.sessions.transition(uid, { status: S.Ended, endedAt: new Date() }, [S.Authed]);
  if (!ended) {
    await ctx.repos.sessions.transition(uid, { status: S.Failed, failReason: 'closed_before_auth', endedAt: new Date() }, [S.Pending, S.Accepted, S.Paired]);
  }
}

/** 应用中继回传的事件：配对成功、会话结束（带累计字节数） */
export async function applyRelayEvent(ctx: Ctx, ev: RelaySessionEvent): Promise<void> {
  const s = await ctx.repos.sessions.get(ev.sid);
  if (!s) return;
  if (ev.type === 'traffic') {
    // 控制端 -> 被控端的流量：控制端发出、被控端收到；反方向相反。两台设备一次写入（单条语句，重试不会只记一半）
    const c2h = { bytes: ev.bytesC2h ?? 0, frames: ev.framesC2h ?? 0 };
    const h2c = { bytes: ev.bytesH2c ?? 0, frames: ev.framesH2c ?? 0 };
    await ctx.repos.traffic.add(utcDate(new Date(ev.ts)), [
      { deviceId: s.controllerDeviceId, bytesIn: h2c.bytes, bytesOut: c2h.bytes, framesIn: h2c.frames, framesOut: c2h.frames },
      { deviceId: s.hostDeviceId, bytesIn: c2h.bytes, bytesOut: h2c.bytes, framesIn: c2h.frames, framesOut: h2c.frames },
    ]);
    return;
  }
  if (ev.type === 'paired') {
    await ctx.repos.sessions.transition(ev.sid, { status: S.Paired }, [S.Pending, S.Accepted]);
    return;
  }
  const bytes = { bytesC2h: ev.bytesC2h ?? 0, bytesH2c: ev.bytesH2c ?? 0 };
  const now = new Date();
  if (s.status === S.Authed) {
    await ctx.repos.sessions.transition(ev.sid, { status: S.Ended, endedAt: now, ...bytes }, [S.Authed]);
  } else if (s.status === S.Pending || s.status === S.Accepted || s.status === S.Paired) {
    const reason = ev.reason === 'pair_timeout' ? 'pair_timeout' : 'closed_before_auth';
    await ctx.repos.sessions.transition(ev.sid, { status: S.Failed, failReason: reason, endedAt: now, ...bytes }, [s.status]);
  } else {
    // 已是终态，只补写字节数
    await ctx.repos.sessions.transition(ev.sid, { status: s.status, endedAt: s.endedAt ?? now, ...bytes }, [s.status]);
  }
  // 放在最后：前面的数据库操作失败会整体重试，不能重复累计
  ctx.collector.inc('bytesRelayed', bytes.bytesC2h + bytes.bytesH2c);
}
