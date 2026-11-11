import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * 配置签名（安全审查 H1）：对 /v1/config 里的 adapters 与 claude_catalog 做 Ed25519 签名，
 * 客户端用内置公钥验签，验签失败就忽略下发内容、只用内置规则。
 *
 * 被签名的字节：`rterm-config-v1\n` + canonicalJson({ adapters, claude_catalog })（UTF-8）。
 *
 * 规范化（canonicalJson）：键排序的紧凑 JSON，与 RFC 8785（JCS）一致的子集——
 *   - 对象键按 UTF-16 码元顺序排序，数组保持原顺序，无空白；
 *   - 字符串转义与 JSON.stringify 相同；
 *   - 数字只允许有限的整数（|n| ≤ 2^53-1，写成十进制整数）；小数、NaN、Infinity 一律拒绝。
 * 客户端（Rust，crates/rterm-core/src/config_sig.rs）按同样规则实现，两端有共用的测试向量。
 */
export const CONFIG_SIG_PREFIX = 'rterm-config-v1\n';

export class CanonicalError extends Error {}

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new CanonicalError(`规范化只允许整数：${v}`);
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort(); // JS 默认按 UTF-16 码元排序
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default:
      throw new CanonicalError(`不能规范化的类型：${typeof v}`);
  }
}

/** 被签名的字节 */
export function signedConfigBytes(adapters: unknown, claudeCatalog: unknown): Buffer {
  return Buffer.from(CONFIG_SIG_PREFIX + canonicalJson({ adapters, claude_catalog: claudeCatalog }), 'utf8');
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ConfigSigner {
  /** 32 字节原始公钥的 base64（写进客户端常量） */
  publicKeyB64: string;
  sign(adapters: unknown, claudeCatalog: unknown): string;
}

/** 由 32 字节 seed（base64）构造签名器；格式不对抛错 */
export function signerFromSeed(seedB64: string): ConfigSigner {
  const seed = Buffer.from(seedB64.trim(), 'base64');
  if (seed.length !== 32) throw new Error('CONFIG_SIGNING_KEY 必须是 base64 编码的 32 字节 Ed25519 seed');
  const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const publicKeyB64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
  return {
    publicKeyB64,
    sign: (adapters, claudeCatalog) => sign(null, signedConfigBytes(adapters, claudeCatalog), priv).toString('base64'),
  };
}

/** 生成一个新的 seed（base64），dev:all 未设置 CONFIG_SIGNING_KEY 时用 */
export function generateSeedB64(): string {
  return randomBytes(32).toString('base64');
}
