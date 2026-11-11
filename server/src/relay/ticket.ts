import { createHmac, timingSafeEqual } from 'node:crypto';

/** 票据内容。sid=会话ID，role=c 主控 / h 被控，did=设备 ID（ULID），node=中继节点名，exp=过期时间（秒） */
export interface Ticket {
  sid: string;
  role: 'c' | 'h';
  did: string;
  node: string;
  exp: number;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const mac = (payload: string, secret: string): Buffer => createHmac('sha256', secret).update(payload).digest();

/** 签发票据：base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret)) */
export function signTicket(
  t: Omit<Ticket, 'exp'>,
  secret: string,
  ttlSec = 30,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const payload = b64u(Buffer.from(JSON.stringify({ ...t, exp: nowSec + ttlSec })));
  return `${payload}.${b64u(mac(payload, secret))}`;
}

/**
 * 校验票据：签名（常数时间比较，新旧密钥任一匹配即可）、过期、节点名、角色。
 * 任何一项不满足都返回 null。
 */
export function verifyTicket(
  token: string,
  secrets: string[],
  nodeName: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Ticket | null {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!payload || !sig) return null;
  const got = Buffer.from(sig, 'base64url');
  let ok = false;
  for (const s of secrets.filter(Boolean)) {
    const want = mac(payload, s);
    if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
  }
  if (!ok) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<Ticket>;
    if (typeof t.sid !== 'string' || typeof t.did !== 'string' || typeof t.node !== 'string') return null;
    if (typeof t.exp !== 'number' || t.exp < nowSec) return null;
    if (t.node !== nodeName) return null;
    if (t.role !== 'c' && t.role !== 'h') return null;
    return t as Ticket;
  } catch {
    return null;
  }
}
