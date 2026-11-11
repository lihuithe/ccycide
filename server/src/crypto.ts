import { createPublicKey, randomInt, verify } from 'node:crypto';
import { ulid } from 'ulid';

/** Ed25519 公钥的 SPKI 固定前缀（12 字节），拼上 32 字节原始公钥就是完整的 DER */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 用 32 字节原始公钥验证 Ed25519 签名（64 字节）。任何格式问题都返回 false，不抛异常。 */
export function verifyEd25519(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** 号码过于规律：全相同、顺子（递增或递减，允许 9→0 / 0→9 回绕） */
export function isTooRegular(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  if ('0123456789012345678901234567890'.includes(code)) return true;
  if ('9876543210987654321098765432109'.includes(code)) return true;
  return false;
}

/** 生成 9 位设备码：100000000–999999999，首位非 0，过滤规律号码 */
export function newDeviceCode(): string {
  for (;;) {
    const code = String(randomInt(100_000_000, 1_000_000_000));
    if (!isTooRegular(code)) return code;
  }
}

export const newUlid = (): string => ulid();

/** 注册签名串（开发指南 T3），各字段以 \n 连接，没有末尾换行 */
export function registerSignString(p: {
  publicKeyB64: string;
  platform: string;
  arch: string;
  kind: string;
  ts: number | string;
}): string {
  return ['rterm-register-v1', p.publicKeyB64, p.platform, p.arch, p.kind, String(p.ts)].join('\n');
}

/** 信令认证签名串（开发指南 T4）：对服务端下发的 nonce 签名 */
export function authSignString(nonce: string, deviceId: string): string {
  return `rterm-auth-v1\n${nonce}\n${deviceId}`;
}

/** 宽松的 base64 解码（标准或 url-safe），长度不符返回 null */
export function decodeB64Exact(s: unknown, len: number): Buffer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 256) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === len ? b : null;
}
