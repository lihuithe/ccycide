import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RateLimiter, RateResult } from './types.js';

/** 内存版滑动窗口计数。定时清理很久没用的 key，避免内存一直涨。 */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { times: number[]; windowMs: number }>();
  private timer: NodeJS.Timeout;

  constructor(private now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateResult> {
    const now = this.now();
    const rec = this.hits.get(key) ?? { times: [], windowMs };
    rec.windowMs = Math.max(rec.windowMs, windowMs);
    // 只保留窗口内的记录（时间戳升序，从头部丢弃）
    let i = 0;
    while (i < rec.times.length && now - rec.times[i]! >= windowMs) i++;
    if (i > 0) rec.times.splice(0, i);
    if (rec.times.length >= limit) {
      this.hits.set(key, rec);
      return { allowed: false, retryAfterMs: Math.max(1, rec.times[0]! + windowMs - now) };
    }
    rec.times.push(now);
    this.hits.set(key, rec);
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, rec] of this.hits) {
      const last = rec.times[rec.times.length - 1];
      if (last === undefined || now - last >= rec.windowMs) this.hits.delete(k);
    }
  }

  /** 当前保存的 key 数（测试用） */
  size(): number {
    return this.hits.size;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

// KEYS[1]=zset；ARGV: now, windowMs, limit, member。返回 {允许(1/0), 剩余等待毫秒}
const WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)
local c = redis.call('ZCARD', KEYS[1])
if c >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + win - now}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], win)
return {1, 0}
`;

/** Redis 版滑动窗口：rl:{规则}:{对象} 的 ZSet */
export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateResult> {
    const member = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const r = (await this.redis.eval(WINDOW_SCRIPT, 1, `rl:${key}`, Date.now(), windowMs, limit, member)) as [number, number];
    return { allowed: r[0] === 1, retryAfterMs: Math.max(0, Number(r[1])) };
  }
}
