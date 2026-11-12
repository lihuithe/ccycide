/**
 * 加密层，与 Rust 核心（crates/rterm-core/src/crypto/*）逐字节一致：
 * Argon2id 口令派生、SPAKE2(Ed25519Group, spake2 crate 0.4)、transcript、HKDF 密钥派生、确认 MAC、AEAD 记录层。
 * 算法和顺序不得改动；任何改动都要与 Rust 端同步并重新联调。
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { EdwardsPoint } from '@noble/curves/abstract/edwards.js';

const enc = new TextEncoder();
const Point = ed25519.Point;
/** 子群阶 l */
const L = Point.Fn.ORDER;

export const REC_HANDSHAKE = 0x01;
export const REC_DATA = 0x02;

// ———————————————————— 小工具 ————————————————————

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bytesToBigIntBE(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function bytesToBigIntLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

// ———————————————————— 口令派生 ————————————————————

/** 临时密码字符集（与 Rust TEMP_PASSWORD_CHARSET 一致） */
export const TEMP_PASSWORD_CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 0 临时密码（恰好 8 位且全在字符集内）；1 固定密码 */
export function passwordKindOf(input: string): number {
  const chars = [...input];
  return chars.length === 8 && chars.every((c) => TEMP_PASSWORD_CHARSET.includes(c)) ? 0 : 1;
}

/** Argon2id(密码, salt = "rterm-v1" || 被控端设备码, m = 19MiB, t = 2, p = 1) → 32 字节 */
export async function derivePwKey(password: string, hostCode: string): Promise<Uint8Array> {
  return argon2idAsync(enc.encode(password), enc.encode(`rterm-v1${hostCode}`), { t: 2, m: 19 * 1024, p: 1, dkLen: 32, asyncTick: 20 });
}

// ———————————————————— SPAKE2 (Ed25519Group) ————————————————————

const SPAKE_M = Point.fromHex('15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312');
const SPAKE_N = Point.fromHex('f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3');

const mul = (p: EdwardsPoint, k: bigint): EdwardsPoint => (k === 0n ? Point.ZERO : p.multiply(k));

/** spake2::ed25519_hash_to_scalar：HKDF-SHA256(salt = "", ikm = pw, info = "SPAKE2 pw") 取 48 字节，按大端整数对 l 取模 */
export function passwordScalar(pw: Uint8Array): bigint {
  const okm = hkdf(sha256, pw, new Uint8Array(0), enc.encode('SPAKE2 pw'), 48);
  return bytesToBigIntBE(okm) % L;
}

/** dalek Scalar::random：64 个随机字节按小端整数对 l 取模；排除 0 */
function randomScalar(): bigint {
  const x = bytesToBigIntLE(randomBytes(64)) % L;
  return x === 0n ? 1n : x;
}

/** SPAKE2 的 A 侧（主控端）。`scalar` 仅测试用：固定 x 以便与 Rust 做向量对照 */
export class Spake2A {
  private constructor(
    private readonly pw: Uint8Array,
    private readonly pwScalar: bigint,
    private readonly x: bigint,
    private readonly msg1: Uint8Array,
    private readonly idA: Uint8Array,
    private readonly idB: Uint8Array,
  ) {}

  /** 返回状态和要发送的消息：0x41 || X（共 33 字节） */
  static start(pw: Uint8Array, idA: Uint8Array, idB: Uint8Array, scalar?: bigint): { state: Spake2A; message: Uint8Array } {
    const pwScalar = passwordScalar(pw);
    const x = scalar ?? randomScalar();
    const msg1 = Point.BASE.multiply(x).add(mul(SPAKE_M, pwScalar)).toBytes();
    return { state: new Spake2A(pw, pwScalar, x, msg1, idA, idB), message: concat(Uint8Array.of(0x41), msg1) };
  }

  /** 收到被控端（B 侧）的 33 字节消息，返回 32 字节共享密钥；格式不对抛错 */
  finish(msg2: Uint8Array): Uint8Array {
    if (msg2.length !== 33) throw new Error('spake2 消息长度非法');
    if (msg2[0] !== 0x42) throw new Error('spake2 方向标记非法');
    const y = Point.fromBytes(msg2.subarray(1));
    // K = (Y + N * (-pw)) * x
    const negPw = (L - this.pwScalar) % L;
    const k = mul(y.add(mul(SPAKE_N, negPw)), this.x).toBytes();
    return sha256(concat(sha256(this.pw), sha256(this.idA), sha256(this.idB), this.msg1, msg2.subarray(1), k));
  }
}

// ———————————————————— 握手：transcript / 密钥 / 确认 ————————————————————

export interface TranscriptInput {
  protoVer: number;
  sessionId: string;
  controllerCode: string;
  hostCode: string;
  spakeMsgA: Uint8Array;
  spakeMsgB: Uint8Array;
  controllerPubkey: Uint8Array;
  hostPubkey: Uint8Array;
  nonceC: Uint8Array;
  nonceH: Uint8Array;
}

/** 每个字段前加 4 字节大端长度再拼接，顺序固定，最后 SHA-256 */
export function transcript(i: TranscriptInput): Uint8Array {
  const parts = [
    u32be(i.protoVer),
    enc.encode(i.sessionId),
    enc.encode(i.controllerCode),
    enc.encode(i.hostCode),
    i.spakeMsgA,
    i.spakeMsgB,
    i.controllerPubkey,
    i.hostPubkey,
    i.nonceC,
    i.nonceH,
  ];
  return sha256(concat(...parts.flatMap((p) => [u32be(p.length), p])));
}

export interface SessionKeys {
  c2h: Uint8Array;
  h2c: Uint8Array;
  confirm: Uint8Array;
}

export function deriveKeys(shared: Uint8Array, transcriptHash: Uint8Array): SessionKeys {
  const ex = (info: string): Uint8Array => hkdf(sha256, shared, transcriptHash, enc.encode(info), 32);
  return { c2h: ex('rterm v1 c2h'), h2c: ex('rterm v1 h2c'), confirm: ex('rterm v1 confirm') };
}

/** role：控制端 'c'，被控端 'h' */
export function confirmMac(confirmKey: Uint8Array, role: 'c' | 'h', transcriptHash: Uint8Array): Uint8Array {
  return hmac(sha256, confirmKey, concat(enc.encode(role), transcriptHash));
}

export function verifyMac(confirmKey: Uint8Array, role: 'c' | 'h', transcriptHash: Uint8Array, got: Uint8Array): boolean {
  return equalBytes(confirmMac(confirmKey, role, transcriptHash), got);
}

// ———————————————————— Ed25519 ————————————————————

/** 等价于 ed25519-dalek 的 verify_strict：拒绝小阶公钥和不规范签名 */
export function verifySignature(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  try {
    if (Point.fromBytes(publicKey).isSmallOrder()) return false;
    if (Point.fromBytes(sig.subarray(0, 32)).isSmallOrder()) return false;
    return ed25519.verify(sig, msg, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function signMessage(seed: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, seed);
}

export function publicKeyOf(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

// ———————————————————— AEAD 记录层 ————————————————————

/** 单方向的加密器/解密器：ChaCha20-Poly1305，nonce = 4 字节 0 + 8 字节大端计数器（每个方向从 0 递增，不随记录传输） */
export class Sealer {
  private counter = 0n;
  constructor(private readonly key: Uint8Array) {}

  private nextNonce(): Uint8Array {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, this.counter, false);
    this.counter += 1n;
    return n;
  }

  /** 明文 → 一条完整记录：0x02 || 密文(含 16 字节标签)，AAD = [0x02] */
  seal(plain: Uint8Array): Uint8Array {
    const ct = chacha20poly1305(this.key, this.nextNonce(), Uint8Array.of(REC_DATA)).encrypt(plain);
    return concat(Uint8Array.of(REC_DATA), ct);
  }

  open(record: Uint8Array): Uint8Array {
    if (record.length < 1 + 16 || record[0] !== REC_DATA) throw new Error('不是数据记录');
    return chacha20poly1305(this.key, this.nextNonce(), Uint8Array.of(REC_DATA)).decrypt(record.subarray(1));
  }
}
