import { createRequire } from 'node:module';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNABLES } from '../src/config.js';
import { MemoryBus } from '../src/store/bus.js';
import { MemoryKvStore, RedisKvStore } from '../src/store/kv.js';
import { MemoryPresenceStore } from '../src/store/presence.memory.js';
import { RedisPresenceStore } from '../src/store/presence.redis.js';
import { MemoryRateLimiter, RedisRateLimiter } from '../src/store/ratelimit.js';
import { MemoryRelayRegistry, RedisRelayRegistry } from '../src/store/relay-registry.js';
import { MemorySessionEvents, RedisSessionEvents } from '../src/store/session-events.js';
import { MemorySessionTracker, RedisSessionTracker } from '../src/store/session-tracker.js';
import { createMemoryStores, createRedisStores, type PresenceInfo, type RelayNodeReport } from '../src/store/index.js';
import { Guard, GUARD } from '../src/service/guard.js';
import { sleep } from './helpers.js';

/*
 * 存储接口的契约测试：同一套用例分别跑内存实现和 Redis 实现。
 * Redis 实现用 ioredis-mock 跑（本机没有 Redis），所以标注为“未对真实 Redis 实测”。
 */
const require = createRequire(import.meta.url);
const RedisMock = require('ioredis-mock') as new () => Redis;

const info = (over: Partial<PresenceInfo> = {}): PresenceInfo => ({
  instanceId: 'inst-1',
  connId: 'conn-1',
  deviceId: 1,
  deviceUid: '01UID',
  deviceCode: '482913675',
  accept: true,
  protoVer: 1,
  minProtoVer: 1,
  platform: 'windows',
  publicKey: 'cGs=',
  appVersion: '1.0.0',
  ip: '1.2.3.4',
  region: '',
  ...over,
});

interface Impl {
  name: string;
  make(): { presence: MemoryPresenceStore | RedisPresenceStore; kv: MemoryKvStore | RedisKvStore; limiter: MemoryRateLimiter | RedisRateLimiter; tracker: MemorySessionTracker | RedisSessionTracker; registry: MemoryRelayRegistry | RedisRelayRegistry };
}

const impls: Impl[] = [
  {
    name: '内存',
    make: () => ({
      presence: new MemoryPresenceStore(90_000),
      kv: new MemoryKvStore(),
      limiter: new MemoryRateLimiter(),
      tracker: new MemorySessionTracker(),
      registry: new MemoryRelayRegistry(),
    }),
  },
  {
    name: 'Redis(ioredis-mock)',
    make: () => {
      const r = new RedisMock();
      return {
        presence: new RedisPresenceStore(r, 90),
        kv: new RedisKvStore(r),
        limiter: new RedisRateLimiter(r),
        tracker: new RedisSessionTracker(r),
        registry: new RedisRelayRegistry(r),
      };
    },
  },
];

for (const impl of impls) {
  describe(`在线状态 PresenceStore - ${impl.name}`, () => {
    it('set / get / 续期 / 修改 accept', async () => {
      const { presence } = impl.make();
      expect(await presence.get('482913675')).toBeNull();
      expect(await presence.set('482913675', info())).toBeNull();
      expect(await presence.get('482913675')).toEqual(info());
      expect(await presence.refresh('482913675', 'conn-1')).toBe(true);
      expect(await presence.refresh('482913675', 'other')).toBe(false);
      expect(await presence.setAccept('482913675', 'conn-1', false)).toBe(true);
      expect((await presence.get('482913675'))!.accept).toBe(false);
      expect(await presence.setAccept('482913675', 'other', true)).toBe(false);
      expect(await presence.count()).toBe(1);
    });

    it('同一设备重连：set 返回旧登记；旧连接 remove 不会删掉新连接', async () => {
      const { presence } = impl.make();
      await presence.set('482913675', info({ connId: 'old' }));
      const prev = await presence.set('482913675', info({ connId: 'new', instanceId: 'inst-2' }));
      expect(prev?.connId).toBe('old');
      expect(await presence.remove('482913675', 'old')).toBe(false);
      expect((await presence.get('482913675'))!.connId).toBe('new');
      expect(await presence.remove('482913675', 'new')).toBe(true);
      expect(await presence.get('482913675')).toBeNull();
    });
  });

  describe(`键值存储 KvStore - ${impl.name}`, () => {
    it('setNx 只有第一次成功（票据一次性标记）', async () => {
      const { kv } = impl.make();
      expect(await kv.setNx('ticket:used:s1:c', '1', 60_000)).toBe(true);
      expect(await kv.setNx('ticket:used:s1:c', '1', 60_000)).toBe(false);
      expect(await kv.setNx('ticket:used:s1:h', '1', 60_000)).toBe(true);
    });
    it('过期后可再次设置', async () => {
      const { kv } = impl.make();
      expect(await kv.setNx('k', '1', 50)).toBe(true);
      await sleep(80);
      expect(await kv.get('k')).toBeNull();
      expect(await kv.setNx('k', '2', 50)).toBe(true);
    });
    it('incrBy 累加，只在新建时设置过期时间', async () => {
      const { kv } = impl.make();
      expect(await kv.incrBy('c', 5, 60_000)).toBe(5);
      expect(await kv.incrBy('c', 7, 1)).toBe(12);
      const ttl = await kv.pttl('c');
      expect(ttl).toBeGreaterThan(10_000);
      expect(await kv.pttl('nope')).toBe(-2);
      await kv.del('c');
      expect(await kv.get('c')).toBeNull();
    });
    it('set / get', async () => {
      const { kv } = impl.make();
      await kv.set('a', 'x', 1000);
      expect(await kv.get('a')).toBe('x');
    });
  });

  describe(`滑动窗口限流 RateLimiter - ${impl.name}`, () => {
    it('窗口内超限被拒，窗口过后恢复', async () => {
      const { limiter } = impl.make();
      for (let i = 0; i < 3; i++) expect((await limiter.hit('k', 3, 200)).allowed).toBe(true);
      const denied = await limiter.hit('k', 3, 200);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(200);
      await sleep(230);
      expect((await limiter.hit('k', 3, 200)).allowed).toBe(true);
    });
    it('不同 key 互不影响', async () => {
      const { limiter } = impl.make();
      expect((await limiter.hit('a', 1, 1000)).allowed).toBe(true);
      expect((await limiter.hit('a', 1, 1000)).allowed).toBe(false);
      expect((await limiter.hit('b', 1, 1000)).allowed).toBe(true);
    });
    it('被拒的请求不占用额度', async () => {
      const { limiter } = impl.make();
      await limiter.hit('k', 2, 300);
      await limiter.hit('k', 2, 300);
      for (let i = 0; i < 10; i++) expect((await limiter.hit('k', 2, 300)).allowed).toBe(false);
      await sleep(330);
      // 窗口过后额度完全恢复（被拒的 10 次没有被记入）
      expect((await limiter.hit('k', 2, 300)).allowed).toBe(true);
      expect((await limiter.hit('k', 2, 300)).allowed).toBe(true);
      expect((await limiter.hit('k', 2, 300)).allowed).toBe(false);
    });
  });

  describe(`同时会话计数 SessionTracker - ${impl.name}`, () => {
    it('touch / remove / count，过期的不计', async () => {
      const { tracker } = impl.make();
      await tracker.touch('d1', 's1', 60_000);
      await tracker.touch('d1', 's2', 60_000);
      await tracker.touch('d1', 's3', 50);
      expect(await tracker.count('d1')).toBe(3);
      await sleep(80);
      expect(await tracker.count('d1')).toBe(2);
      await tracker.remove('d1', 's1');
      expect(await tracker.count('d1')).toBe(1);
      expect(await tracker.count('nobody')).toBe(0);
    });
  });

  describe(`中继节点注册表 RelayRegistry - ${impl.name}`, () => {
    const rep = (name: string): RelayNodeReport => ({ name, region: 'cn-east', publicUrl: `wss://${name}.example.com`, sessions: 3, capacity: 100, bandwidth: 0.1, status: 'up', ts: Date.now() });
    it('上报、列出、30 秒（这里缩短）没上报视为下线', async () => {
      const { registry } = impl.make();
      await registry.report(rep('relay-01'), 60_000);
      await registry.report(rep('relay-02'), 50);
      expect((await registry.list()).map((n) => n.name).sort()).toEqual(['relay-01', 'relay-02']);
      await sleep(80);
      const list = await registry.list();
      expect(list.map((n) => n.name)).toEqual(['relay-01']);
      expect(list[0]).toMatchObject({ region: 'cn-east', sessions: 3, capacity: 100, status: 'up' });
      await registry.remove('relay-01');
      expect(await registry.list()).toEqual([]);
    });
  });
}

describe('Redis 会话事件通道（ioredis-mock）', () => {
  it('中继 publish，信令 consume 取走，每条只消费一次', async () => {
    const r = new RedisMock();
    const ch = new RedisSessionEvents(r, 20);
    const got: string[] = [];
    const stop = ch.consume((ev) => void got.push(ev.sid));
    await ch.publish({ type: 'paired', sid: 'a', node: 'n', ts: 1 });
    await ch.publish({ type: 'ended', sid: 'b', node: 'n', ts: 2, bytesC2h: 5, bytesH2c: 6 });
    await sleep(120);
    stop();
    expect(got).toEqual(['a', 'b']);
    await sleep(60);
    expect(got).toHaveLength(2);
  });
  it('内存通道直接回调', async () => {
    const ch = new MemorySessionEvents();
    const got: string[] = [];
    ch.consume((ev) => void got.push(ev.sid));
    await ch.publish({ type: 'paired', sid: 'x', node: 'n', ts: 1 });
    await sleep(10);
    expect(got).toEqual(['x']);
  });
});

describe('跨实例总线 MemoryBus', () => {
  it('点对点与广播', async () => {
    const bus = new MemoryBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe('A', (m) => void a.push(m));
    await bus.subscribe('B', (m) => void b.push(m));
    await bus.publish('A', { k: 'kick', code: '1', connId: 'c', reason: 'r' });
    await bus.broadcast({ k: 'notice', level: 'info', text: 'hi' });
    await sleep(10);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });
});

describe('createRedisStores 装配', () => {
  it('用 mock 连接可以构造出完整的 Stores，并完成一次读写', async () => {
    const r = new RedisMock();
    const s = createRedisStores({ tunables: DEFAULT_TUNABLES }, r, () => new RedisMock());
    expect(s.isRedis).toBe(true);
    await s.presence.set('1', info());
    expect((await s.presence.get('1'))?.deviceCode).toBe('482913675');
    await s.close();
  });
  it('内存 Stores', async () => {
    const s = createMemoryStores({ tunables: DEFAULT_TUNABLES });
    expect(s.isRedis).toBe(false);
    await s.close();
  });
});

describe('Guard：锁定与枚举计数', () => {
  it('密码连续失败 5 次触发锁定，之后锁定时长翻倍，上限 24 小时', async () => {
    const kv = new MemoryKvStore();
    const g = new Guard(kv);
    for (let i = 1; i < GUARD.failThreshold; i++) expect((await g.recordAuthFailure('111222333')).locked).toBe(false);
    expect(await g.getLock('111222333')).toBeNull();
    const first = await g.recordAuthFailure('111222333');
    expect(first).toMatchObject({ locked: true, lockSec: 600 });
    expect(await g.getLock('111222333')).not.toBeNull();
    // 第二轮：时长翻倍
    for (let i = 1; i < GUARD.failThreshold; i++) await g.recordAuthFailure('111222333');
    expect((await g.recordAuthFailure('111222333')).lockSec).toBe(1200);
    // 很多轮之后封顶 24 小时
    let last = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 1; i < GUARD.failThreshold; i++) await g.recordAuthFailure('111222333');
      last = (await g.recordAuthFailure('111222333')).lockSec;
    }
    expect(last).toBe(24 * 3600);
    await g.unlockHost('111222333');
    expect(await g.getLock('111222333')).toBeNull();
    kv.stop();
  });
  it('枚举：第 20 次不存在的设备码触发封禁阈值', async () => {
    const kv = new MemoryKvStore();
    const g = new Guard(kv);
    for (let i = 1; i < GUARD.missThreshold; i++) expect((await g.recordMiss('01UID')).ban).toBe(false);
    expect((await g.recordMiss('01UID')).ban).toBe(true);
    // 触发后计数清零
    expect((await g.recordMiss('01UID')).ban).toBe(false);
    kv.stop();
  });
});
