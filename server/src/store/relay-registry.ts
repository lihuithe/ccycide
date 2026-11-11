import type { Redis } from 'ioredis';
import type { RelayNodeReport, RelayRegistry } from './types.js';

/** 内存版：中继节点负载表，超过 ttl 没上报视为下线 */
export class MemoryRelayRegistry implements RelayRegistry {
  private map = new Map<string, { info: RelayNodeReport; expiresAt: number }>();

  constructor(private now: () => number = Date.now) {}

  async report(info: RelayNodeReport, ttlMs: number): Promise<void> {
    this.map.set(info.name, { info: { ...info }, expiresAt: this.now() + ttlMs });
  }

  async list(): Promise<RelayNodeReport[]> {
    const t = this.now();
    const out: RelayNodeReport[] = [];
    for (const [k, e] of this.map) {
      if (e.expiresAt <= t) this.map.delete(k);
      else out.push({ ...e.info });
    }
    return out;
  }

  async remove(name: string): Promise<void> {
    this.map.delete(name);
  }
}

const key = (name: string): string => `relay:node:${name}`;

/** Redis 版：relay:node:{name} Hash，30 秒有效期 */
export class RedisRelayRegistry implements RelayRegistry {
  constructor(private redis: Redis) {}

  async report(info: RelayNodeReport, ttlMs: number): Promise<void> {
    await this.redis
      .multi()
      .hset(key(info.name), {
        name: info.name,
        region: info.region,
        publicUrl: info.publicUrl,
        sessions: String(info.sessions),
        capacity: String(info.capacity),
        bandwidth: String(info.bandwidth),
        status: info.status,
        ts: String(info.ts),
      })
      .pexpire(key(info.name), Math.ceil(ttlMs))
      .exec();
  }

  async list(): Promise<RelayNodeReport[]> {
    const names: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'relay:node:*', 'COUNT', 200);
      cursor = next;
      names.push(...keys);
    } while (cursor !== '0');
    const out: RelayNodeReport[] = [];
    for (const k of names) {
      const h = await this.redis.hgetall(k);
      if (!h.name || !h.publicUrl) continue;
      out.push({
        name: h.name,
        region: h.region ?? '',
        publicUrl: h.publicUrl,
        sessions: Number(h.sessions ?? 0),
        capacity: Number(h.capacity ?? 0),
        bandwidth: Number(h.bandwidth ?? 0),
        status: h.status === 'draining' ? 'draining' : 'up',
        ts: Number(h.ts ?? 0),
      });
    }
    return out;
  }

  async remove(name: string): Promise<void> {
    await this.redis.del(key(name));
  }
}
