import type { Redis } from 'ioredis';
import type { SessionTracker } from './types.js';

/** 内存版：设备 -> {会话ID -> 过期时间} */
export class MemorySessionTracker implements SessionTracker {
  private map = new Map<string, Map<string, number>>();

  constructor(private now: () => number = Date.now) {}

  async touch(deviceUid: string, sid: string, ttlMs: number): Promise<void> {
    const m = this.map.get(deviceUid) ?? new Map<string, number>();
    m.set(sid, this.now() + ttlMs);
    this.map.set(deviceUid, m);
  }

  async remove(deviceUid: string, sid: string): Promise<void> {
    const m = this.map.get(deviceUid);
    if (!m) return;
    m.delete(sid);
    if (m.size === 0) this.map.delete(deviceUid);
  }

  async has(deviceUid: string, sid: string): Promise<boolean> {
    const exp = this.map.get(deviceUid)?.get(sid);
    return exp !== undefined && exp > this.now();
  }

  async count(deviceUid: string): Promise<number> {
    const m = this.map.get(deviceUid);
    if (!m) return 0;
    const t = this.now();
    for (const [sid, exp] of m) if (exp <= t) m.delete(sid);
    if (m.size === 0) this.map.delete(deviceUid);
    return m.size;
  }
}

const key = (uid: string): string => `sess:dev:${uid}`;

/** Redis 版：ZSet，score=过期时间戳，统计前先清掉已过期的 */
export class RedisSessionTracker implements SessionTracker {
  constructor(private redis: Redis) {}

  async touch(deviceUid: string, sid: string, ttlMs: number): Promise<void> {
    const exp = Date.now() + ttlMs;
    // 整个集合的有效期取 24 小时，成员各自带过期时间
    await this.redis.multi().zadd(key(deviceUid), exp, sid).pexpire(key(deviceUid), 24 * 3600_000).exec();
  }

  async remove(deviceUid: string, sid: string): Promise<void> {
    await this.redis.zrem(key(deviceUid), sid);
  }

  async has(deviceUid: string, sid: string): Promise<boolean> {
    const score = await this.redis.zscore(key(deviceUid), sid);
    return score !== null && Number(score) > Date.now();
  }

  async count(deviceUid: string): Promise<number> {
    const res = await this.redis.multi().zremrangebyscore(key(deviceUid), 0, Date.now()).zcard(key(deviceUid)).exec();
    return Number(res?.[1]?.[1] ?? 0);
  }
}
