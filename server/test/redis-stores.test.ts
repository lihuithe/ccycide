import { createRequire } from 'node:module';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createRedisStores, type BusMessage } from '../src/store/index.js';
import { RedisBus } from '../src/store/bus.js';
import { crossInstanceFlow } from './redis-flow.js';
import { sleep, testConfig } from './helpers.js';

/*
 * 用 ioredis-mock 跑 Redis 版存储：在线状态、限流、锁定计数、票据一次性标记、总线、中继事件通道。
 * 注意：这只能验证我们对 Redis 命令的用法和 Lua 脚本逻辑，不能代替对真实 Redis 的测试。
 */
const require = createRequire(import.meta.url);
const RedisMock = require('ioredis-mock') as new () => Redis;

function redisStores(cfg = testConfig()) {
  return createRedisStores(cfg, new RedisMock(), () => new RedisMock());
}

describe('Redis 总线（发布订阅）', () => {
  it('点对点与广播', async () => {
    const a = new RedisBus(new RedisMock(), () => new RedisMock());
    const b = new RedisBus(new RedisMock(), () => new RedisMock());
    const gotA: BusMessage[] = [];
    const gotB: BusMessage[] = [];
    await a.subscribe('A', (m) => void gotA.push(m));
    await b.subscribe('B', (m) => void gotB.push(m));
    await b.publish('A', { k: 'kick', code: '1', connId: 'c', reason: 'replaced' });
    await a.broadcast({ k: 'notice', level: 'info', text: 'hi' });
    await sleep(100);
    expect(gotA.map((m) => m.k).sort()).toEqual(['kick', 'notice']);
    expect(gotB.map((m) => m.k)).toEqual(['notice']);
    await a.close();
    await b.close();
  });
});

describe('全链路使用 Redis 版存储（两个信令实例 + 中继）', () => {
  it('跨实例连接、踢旧连接、锁定、票据一次性、中继事件回传落库', async () => {
    const cfg = testConfig();
    await crossInstanceFlow({ makeStores: () => redisStores(cfg) });
  }, 60_000);
});
