/** 信令协议常量与消息类型，见《实现方案.md》4.3 */

/** 信令连接的 WebSocket 关闭码（4xxx 为应用自定义） */
export const CLOSE = {
  /** 非法消息：坏 JSON、二进制、缺 t 字段等 */
  BAD_MESSAGE: 4400,
  /** 认证超时、未认证就发其他消息、认证失败 */
  AUTH: 4401,
  /** 被封禁 */
  BANNED: 4403,
  /** 45 秒没有收到任何消息 */
  IDLE_TIMEOUT: 4408,
  /** 同一设备在别处登录，旧连接被踢 */
  REPLACED: 4409,
  /** 同 IP 连接数过多、消息过于频繁 */
  TOO_MANY: 4429,
  /** 服务端正在重启 */
  GOING_AWAY: 1001,
} as const;

export const SIGNAL_PATH = '/v1/signal';

/** connect.err 的错误码 */
export type ConnectErrCode = 'UNAVAILABLE' | 'REJECTED' | 'RATE_LIMITED' | 'LOCKED' | 'VERSION' | 'BANNED' | 'NO_RELAY';

/** auth.err 的错误码 */
export type AuthErrCode = 'BAD_REQUEST' | 'UNKNOWN_DEVICE' | 'BAD_SIGNATURE' | 'BANNED' | 'VERSION' | 'RATE_LIMITED' | 'INTERNAL';

export interface Msg {
  t: string;
  id?: string;
  d: Record<string, unknown>;
}

/** 解析一条文本消息，不合法返回 null（调用方据此关闭连接） */
export function parseMsg(raw: string): Msg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== 'string' || o.t.length === 0 || o.t.length > 64) return null;
  const msg: Msg = { t: o.t, d: {} };
  if (typeof o.id === 'string' && o.id.length <= 64) msg.id = o.id;
  else if (typeof o.id === 'number' && Number.isFinite(o.id)) msg.id = String(o.id);
  if (typeof o.d === 'object' && o.d !== null && !Array.isArray(o.d)) msg.d = o.d as Record<string, unknown>;
  return msg;
}

/** 客户端可以发送的消息类型。只有这些类型会作为指标标签，其余一律记为 other（安全审查 M2） */
export const KNOWN_MSG_TYPES: readonly string[] = ['auth', 'ping', 'presence.update', 'connect.request', 'connect.accept', 'connect.reject', 'connect.cancel', 'session.report'];

/** 指标标签：白名单内的类型原样返回，未知类型归为 other，避免任意字符串撑大指标序列数 */
export function metricMsgType(t: string): string {
  return KNOWN_MSG_TYPES.includes(t) ? t : 'other';
}

/** 协议版本是否有交集：[a.min, a.ver] 与 [b.min, b.ver] 相交 */
export function protoCompatible(a: { ver: number; min: number }, b: { ver: number; min: number }): boolean {
  return Math.max(a.min, b.min) <= Math.min(a.ver, b.ver);
}
