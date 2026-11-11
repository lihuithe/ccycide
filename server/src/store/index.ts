import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import type { Log } from '../logger.js';
import { MemoryBus, RedisBus } from './bus.js';
import { MemoryKvStore, RedisKvStore } from './kv.js';
import { MemoryPresenceStore } from './presence.memory.js';
import { RedisPresenceStore } from './presence.redis.js';
import { MemoryRateLimiter, RedisRateLimiter } from './ratelimit.js';
import { MemoryRelayRegistry, RedisRelayRegistry } from './relay-registry.js';
import { MemorySessionEvents, RedisSessionEvents } from './session-events.js';
import { MemorySessionTracker, RedisSessionTracker } from './session-tracker.js';
import type { Stores } from './types.js';

export * from './types.js';

/** 全部使用进程内存的实现（REDIS_URL 为空时） */
export function createMemoryStores(cfg: Pick<Config, 'tunables'>): Stores {
  const presence = new MemoryPresenceStore(cfg.tunables.presenceTtlSec * 1000);
  const kv = new MemoryKvStore();
  const limiter = new MemoryRateLimiter();
  return {
    presence,
    kv,
    limiter,
    bus: new MemoryBus(),
    registry: new MemoryRelayRegistry(),
    tracker: new MemorySessionTracker(),
    sessionEvents: new MemorySessionEvents(),
    isRedis: false,
    async close() {
      presence.stop();
      kv.stop();
      limiter.stop();
    },
  };
}

/** 用已有的 Redis 连接构造 Redis 实现。subscriber 工厂用于发布订阅需要的独立连接 */
export function createRedisStores(
  cfg: Pick<Config, 'tunables'>,
  redis: Redis,
  makeSubscriber: () => Redis,
  onError: (e: unknown) => void = () => {},
): Stores {
  const bus = new RedisBus(redis, makeSubscriber, onError);
  return {
    presence: new RedisPresenceStore(redis, cfg.tunables.presenceTtlSec),
    kv: new RedisKvStore(redis),
    limiter: new RedisRateLimiter(redis),
    bus,
    registry: new RedisRelayRegistry(redis),
    tracker: new RedisSessionTracker(redis),
    sessionEvents: new RedisSessionEvents(redis, 500, onError),
    isRedis: true,
    async close() {
      await bus.close();
      redis.disconnect();
    },
  };
}

/** 按配置创建：REDIS_URL 为空用内存实现，否则连接 Redis（连不上会抛出明确错误） */
export async function createStores(cfg: Config, log: Log): Promise<Stores> {
  if (!cfg.redisUrl) {
    if (cfg.nodeEnv === 'production') log.warn('REDIS_URL 为空，使用内存实现；仅限单机部署，多实例或中继独立部署时必须配置 Redis');
    return createMemoryStores(cfg);
  }
  // commandTimeout：Redis 进程被挂起或网络黑洞时（连接还在但不回包），命令也要在几秒内失败，
  // 调用方才能走降级（NO_RELAY）；不设的话 ioredis 会一直等，connect.request 会无限挂起。
  const opts = { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 3000, lazyConnect: true };
  const redis = new Redis(cfg.redisUrl, opts);
  redis.on('error', (e: Error) => log.error({ err: e.message }, 'Redis 错误'));
  try {
    await redis.connect();
    await redis.ping();
  } catch (e) {
    redis.disconnect();
    throw new Error(`无法连接 Redis（REDIS_URL）：${(e as Error).message}`);
  }
  return createRedisStores(cfg, redis, () => {
    const s = new Redis(cfg.redisUrl, { ...opts, lazyConnect: false });
    s.on('error', (e: Error) => log.error({ err: e.message }, 'Redis 订阅连接错误'));
    return s;
  }, (e) => log.error({ err: (e as Error).message }, 'Redis 存储错误'));
}
