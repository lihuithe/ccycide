import type { Redis } from 'ioredis';
import type { KvStore } from './types.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/** 内存键值存储，支持过期 */
export class MemoryKvStore implements KvStore {
  private map = new Map<string, Entry>();
  private timer: NodeJS.Timeout;

  constructor(private now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  private live(key: string): Entry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.map) if (e.expiresAt <= t) this.map.delete(k);
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }

  async incrBy(key: string, n: number, ttlMs: number): Promise<number> {
    const e = this.live(key);
    if (!e) {
      this.map.set(key, { value: String(n), expiresAt: this.now() + ttlMs });
      return n;
    }
    const v = Number(e.value) + n;
    e.value = String(v);
    return v;
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async pttl(key: string): Promise<number> {
    const e = this.live(key);
    return e ? e.expiresAt - this.now() : -2;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

// 累加；仅在键没有过期时间时设置过期（即新建时）
const INCR_SCRIPT = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v
`;

export class RedisKvStore implements KvStore {
  constructor(private redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const r = await this.redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)), 'NX');
    return r === 'OK';
  }

  async incrBy(key: string, n: number, ttlMs: number): Promise<number> {
    return Number(await this.redis.eval(INCR_SCRIPT, 1, key, n, Math.max(1, Math.ceil(ttlMs))));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }
}
