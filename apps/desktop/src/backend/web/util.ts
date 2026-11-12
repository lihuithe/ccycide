export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 退避间隔：base * 2^attempt，不超过 max（默认 1、2、4、8、15、15…秒，与 Rust 控制端一致） */
export function backoff(baseMs: number, maxMs: number, attempt: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
}

export function b64encode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 带 code 的错误：与前端 CommandError 同形，可直接抛给界面 */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

/** 公钥指纹（前 8 字节 SHA-256 的十六进制，冒号分隔），用于“公钥变化”提示；调用方传入已算好的哈希 */
export function fingerprint(hash: Uint8Array): string {
  return [...hash.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(':');
}

/** ms 毫秒后以 make() 拒绝；已挂上空 catch，不会在被 race 淘汰后变成“未处理的拒绝” */
export function timeoutAfter(ms: number, make: () => unknown): Promise<never> {
  const p = new Promise<never>((_, reject) => setTimeout(() => reject(make()), ms));
  p.catch(() => {});
  return p;
}
