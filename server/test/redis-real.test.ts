import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tunables } from '../src/config.js';
import { createKnex } from '../src/db/knex.js';
import { createKnexRepos } from '../src/db/repos/mysql.js';
import { SessionStatus } from '../src/db/repos/index.js';
import { silentLogger } from '../src/logger.js';
import { createStores, type BusMessage, type PresenceInfo, type RelaySessionEvent, type Stores } from '../src/store/index.js';
import { RedisBus } from '../src/store/bus.js';
import { RedisSessionEvents } from '../src/store/session-events.js';
import { createContext } from '../src/context.js';
import { startSignalApp } from '../src/runtime.js';
import { RelayConn, SignalClient, registerNew } from '../tools/rterm-client.js';
import { crossInstanceFlow, startExtraRelay } from './redis-flow.js';
import { onlineDevice, sleep, startStack, testConfig, until } from './helpers.js';
import { TcpProxy } from './tcp-proxy.js';

/*
 * 真实 Redis 集成测试（Redis 7）。没有设置 TEST_REDIS_URL 时整个文件跳过：
 *   TEST_REDIS_URL=redis://:密码@127.0.0.1:6379 npm test
 * 测试固定使用该实例的 db 9（可用 TEST_REDIS_DB 改），开始前会 FLUSHDB 清空它，所以不要指向有真实数据的实例。
 * 同时设置 TEST_MYSQL_URL 时，全链路用例还会把真实 MySQL 一起接上。
 * 故障用例通过本地 TCP 代理（test/tcp-proxy.ts）断开/冻结到 Redis 的网络，不需要 Docker 权限。
 */
const BASE = process.env.TEST_REDIS_URL ?? '';
const MYSQL = process.env.TEST_MYSQL_URL ?? '';
const DB = Number(process.env.TEST_REDIS_DB ?? 9);
const d = describe.skipIf(!BASE);

function withDb(url: string, db = DB): string {
  const u = new globalThis.URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const URL_ = BASE ? withDb(BASE) : '';

const logger = silentLogger();
const opened: Stores[] = [];

/** 与生产相同的创建路径：createStores(cfg) 读 REDIS_URL */
async function mk(url = URL_, tunables: Partial<Tunables> = {}): Promise<Stores> {
  const cfg = { ...testConfig({ tunables }), redisUrl: url };
  const s = await createStores(cfg, logger);
  opened.push(s);
  return s;
}

const info = (code: string, connId: string, over: Partial<PresenceInfo> = {}): PresenceInfo => ({
  instanceId: 'inst-1',
  connId,
  deviceId: 7,
  deviceUid: '01UID',
  deviceCode: code,
  accept: true,
  protoVer: 1,
  minProtoVer: 1,
  platform: 'windows',
  publicKey: 'cGs=',
  appVersion: '1.0.0',
  ip: '1.2.3.4',
  region: 'cn',
  ...over,
});
const uniq = (p: string): string => `${p}-${randomBytes(4).toString('hex')}`;

d('真实 Redis：连接与基础', () => {
  let raw: Redis;
  beforeAll(async () => {
    raw = new Redis(URL_);
    await raw.flushdb();
  });
  afterAll(async () => {
    await raw.flushdb();
    raw.disconnect();
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
  });

  it('服务端版本是 Redis 7+', async () => {
    const m = /redis_version:(\d+)\./.exec(await raw.info('server'));
    expect(Number(m![1])).toBeGreaterThanOrEqual(7);
  });

  it('createStores 对错误密码/不可达地址给出明确错误', async () => {
    const u = new globalThis.URL(URL_);
    u.password = 'wrong-password';
    const cfg = { ...testConfig(), redisUrl: u.toString() };
    await expect(createStores(cfg, logger)).rejects.toThrow(/无法连接 Redis/);
    const dead = { ...testConfig(), redisUrl: 'redis://127.0.0.1:1' };
    await expect(createStores(dead, logger)).rejects.toThrow(/无法连接 Redis/);
  });

  it('KV：set/get/PX 过期、setNx、del、pttl', async () => {
    const { kv } = await mk();
    const k = uniq('kv');
    expect(await kv.get(k)).toBeNull();
    expect(await kv.pttl(k)).toBe(-2);
    await kv.set(k, 'v', 400);
    expect(await kv.get(k)).toBe('v');
    const t = await kv.pttl(k);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(400);
    await sleep(500);
    expect(await kv.get(k)).toBeNull();
    expect(await kv.pttl(k)).toBe(-2);

    expect(await kv.setNx(k, 'a', 5000)).toBe(true);
    expect(await kv.setNx(k, 'b', 5000)).toBe(false);
    expect(await kv.get(k)).toBe('a');
    await kv.del(k);
    expect(await kv.setNx(k, 'c', 300)).toBe(true);
    await sleep(400);
    expect(await kv.setNx(k, 'd', 300)).toBe(true); // 过期后可再次抢到（任务锁的语义）
    // 非整数毫秒向上取整，不会变成 0 导致报错
    await kv.set(k, 'x', 0.2);
    expect(await kv.pttl(k)).toBeGreaterThanOrEqual(-2);
  });

  it('KV.incrBy（Lua）：返回数字、只在新建时设置过期、过期后重新计数、并发原子', async () => {
    const { kv } = await mk();
    const k = uniq('incr');
    expect(await kv.incrBy(k, 1, 1000)).toBe(1);
    const t1 = await kv.pttl(k);
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(1000);
    await sleep(300);
    expect(await kv.incrBy(k, 5, 1000)).toBe(6);
    expect(await kv.pttl(k)).toBeLessThan(t1); // 第二次累加没有重置过期时间
    await sleep(800);
    expect(await kv.get(k)).toBeNull();
    expect(await kv.incrBy(k, 1, 1000)).toBe(1);

    // 100 个并发累加：返回值恰好是 1..100 各一次
    const k2 = uniq('incr-par');
    const vals = await Promise.all(Array.from({ length: 100 }, () => kv.incrBy(k2, 1, 10_000)));
    expect([...vals].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(await kv.get(k2)).toBe('100');

    // 流量配额用的大数（超过 2^32）
    const k3 = uniq('incr-big');
    expect(await kv.incrBy(k3, 6_000_000_000, 5000)).toBe(6_000_000_000);
    expect(await kv.incrBy(k3, 6_000_000_000, 5000)).toBe(12_000_000_000);

    // 没有过期时间的旧 key（比如手工写入）累加时会补上过期时间
    const k4 = uniq('incr-nottl');
    await raw.set(k4, '10');
    expect(await kv.incrBy(k4, 1, 2000)).toBe(11);
    expect(await kv.pttl(k4)).toBeGreaterThan(0);
  });

  it('在线状态：往返、覆盖返回旧值、守卫脚本只认当前 connId、TTL 续期与过期、count', async () => {
    const { presence } = await mk(URL_, { presenceTtlSec: 2 });
    const code = uniq('9').replace(/\D/g, '').padEnd(9, '1').slice(0, 9);
    expect(await presence.get(code)).toBeNull();
    expect(await presence.set(code, info(code, 'c1'))).toBeNull();
    expect(await presence.get(code)).toEqual(info(code, 'c1'));
    const ttl = await raw.pttl(`presence:${code}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);

    // 覆盖：返回旧值，且新值完整替换（旧字段不残留）
    const old = await presence.set(code, info(code, 'c2', { instanceId: 'inst-2', accept: false, region: '' }));
    expect(old).toEqual(info(code, 'c1'));
    expect(await presence.get(code)).toMatchObject({ connId: 'c2', instanceId: 'inst-2', accept: false });

    // 守卫：旧 connId 不能续期/改 accept/删除
    expect(await presence.refresh(code, 'c1')).toBe(false);
    expect(await presence.setAccept(code, 'c1', true)).toBe(false);
    expect(await presence.remove(code, 'c1')).toBe(false);
    expect((await presence.get(code))!.accept).toBe(false);
    expect(await presence.setAccept(code, 'c2', true)).toBe(true);
    expect((await presence.get(code))!.accept).toBe(true);

    // 续期：2 秒 TTL，隔 1.2 秒续期一次，2.4 秒后仍在；之后不续期则过期
    await sleep(1200);
    expect(await presence.refresh(code, 'c2')).toBe(true);
    await sleep(1200);
    expect(await presence.get(code)).not.toBeNull();
    expect(await raw.pttl(`presence:${code}`)).toBeGreaterThan(0);
    await sleep(2300);
    expect(await presence.get(code)).toBeNull();
    expect(await presence.refresh(code, 'c2')).toBe(false); // 过期后续期失败，由 ping 处理重新登记

    // count 用 SCAN，只数 presence:*（超过 SCAN 单批大小也要数对）
    const before = await presence.count();
    const codes = Array.from({ length: 1500 }, (_, i) => `88${String(i).padStart(7, '0')}`);
    const pipe = raw.pipeline();
    for (const c of codes) pipe.hset(`presence:${c}`, { instanceId: 'x', connId: 'y' }).expire(`presence:${c}`, 30);
    pipe.set('other:key', '1');
    await pipe.exec();
    expect(await presence.count()).toBe(before + 1500);
    await presence.remove(code, 'c2');
    const del = raw.pipeline();
    for (const c of codes) del.del(`presence:${c}`);
    await del.exec();
  });

  it('在线状态：remove 之后 get 为空；坏数据（缺 connId）读作 null', async () => {
    const { presence } = await mk();
    const code = '777000111';
    await presence.set(code, info(code, 'cc'));
    expect(await presence.remove(code, 'cc')).toBe(true);
    expect(await presence.get(code)).toBeNull();
    await raw.hset(`presence:${code}`, { foo: 'bar' });
    expect(await presence.get(code)).toBeNull();
    await raw.del(`presence:${code}`);
  });

  it('限流（Lua 滑动窗口）：窗口内计数、retryAfter、窗口滑动后放行、key 过期、并发精确', async () => {
    const { limiter } = await mk();
    const k = uniq('lim');
    for (let i = 0; i < 3; i++) expect(await limiter.hit(k, 3, 1000)).toEqual({ allowed: true, retryAfterMs: 0 });
    const denied = await limiter.hit(k, 3, 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
    expect(await raw.zcard(`rl:${k}`)).toBe(3); // 被拒绝的请求不占名额
    expect(await raw.pttl(`rl:${k}`)).toBeGreaterThan(0);
    await sleep(denied.retryAfterMs + 50);
    expect((await limiter.hit(k, 3, 1000)).allowed).toBe(true);
    await sleep(1100);
    expect(await raw.exists(`rl:${k}`)).toBe(0); // 没有新请求，key 随窗口过期

    // 同一毫秒的并发请求也各占一个名额：30 个并发、上限 5 -> 恰好 5 个通过
    const k2 = uniq('lim-par');
    const rs = await Promise.all(Array.from({ length: 30 }, () => limiter.hit(k2, 5, 5000)));
    expect(rs.filter((r) => r.allowed).length).toBe(5);

    // 长窗口（1 小时）key 的 TTL 跟随窗口
    const k3 = uniq('lim-h');
    await limiter.hit(k3, 10, 3600_000);
    const t = await raw.pttl(`rl:${k3}`);
    expect(t).toBeGreaterThan(3_590_000);
    expect(t).toBeLessThanOrEqual(3_600_000);
  });

  it('会话计数（ZSet）：成员各自过期、remove、集合 24 小时 TTL', async () => {
    const { tracker } = await mk();
    const uid = uniq('dev');
    await tracker.touch(uid, 's1', 400);
    await tracker.touch(uid, 's2', 60_000);
    expect(await tracker.count(uid)).toBe(2);
    expect(await raw.pttl(`sess:dev:${uid}`)).toBeGreaterThan(23 * 3600_000);
    await sleep(500);
    expect(await tracker.count(uid)).toBe(1);
    await tracker.touch(uid, 's2', 60_000); // 重复 touch 不增加
    expect(await tracker.count(uid)).toBe(1);
    await tracker.remove(uid, 's2');
    expect(await tracker.count(uid)).toBe(0);
    expect(await tracker.count(uniq('none'))).toBe(0);
  });

  it('中继注册表：上报、列表、节点 TTL 过期、remove、忽略损坏条目', async () => {
    const { registry } = await mk();
    const a = uniq('node-a');
    const b = uniq('node-b');
    const rep = (name: string, over = {}) => ({ name, region: 'cn', publicUrl: `wss://${name}`, sessions: 3, capacity: 100, bandwidth: 0.25, status: 'up' as const, ts: Date.now(), ...over });
    await registry.report(rep(a), 30_000);
    await registry.report(rep(b, { status: 'draining', sessions: 9 }), 400);
    let list = await registry.list();
    expect(list.find((x) => x.name === a)).toMatchObject({ region: 'cn', publicUrl: `wss://${a}`, sessions: 3, capacity: 100, bandwidth: 0.25, status: 'up' });
    expect(list.find((x) => x.name === b)).toMatchObject({ status: 'draining', sessions: 9 });
    expect(await raw.pttl(`relay:node:${a}`)).toBeGreaterThan(29_000);
    await raw.hset('relay:node:broken', { foo: 'bar' });
    await sleep(500);
    list = await registry.list();
    expect(list.map((x) => x.name)).toContain(a);
    expect(list.map((x) => x.name)).not.toContain(b); // 30 秒不上报视为下线
    expect(list.map((x) => x.name)).not.toContain('broken');
    await registry.report(rep(a, { sessions: 4 }), 30_000);
    expect((await registry.list()).find((x) => x.name === a)!.sessions).toBe(4); // 再次上报覆盖
    await registry.remove(a);
    expect((await registry.list()).map((x) => x.name)).not.toContain(a);
    await raw.del('relay:node:broken');
  });
});

d('真实 Redis：事件通道与总线', () => {
  let raw: Redis;
  beforeAll(async () => {
    raw = new Redis(URL_);
    await raw.flushdb();
  });
  afterAll(async () => {
    await raw.flushdb();
    raw.disconnect();
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
  });

  const ev = (i: number): RelaySessionEvent => ({ type: 'ended', sid: `sid-${i}`, node: 'n', reason: 'closed', bytesC2h: i, bytesH2c: i * 2, ts: i });

  it('会话事件：RPUSH/LPOP 保序、超过单批 100 条、处理函数抛错不影响后续、多消费者每条只处理一次', async () => {
    const errs: unknown[] = [];
    const pubR = new Redis(URL_);
    const conR = new Redis(URL_);
    const con2R = new Redis(URL_);
    const pub = new RedisSessionEvents(pubR, 20);
    const got1: number[] = [];
    const got2: number[] = [];
    // 先发布再消费：事件在列表里等着，不会丢
    for (let i = 0; i < 250; i++) await pub.publish(ev(i));
    expect(await raw.llen('relay:events')).toBe(250);
    const c1 = new RedisSessionEvents(conR, 20, (e) => errs.push(e));
    const c2 = new RedisSessionEvents(con2R, 20);
    const stop1 = c1.consume(async (e) => {
      if (e.bytesC2h === 3) throw new Error('boom');
      got1.push(e.bytesC2h!);
    });
    const stop2 = c2.consume((e) => void got2.push(e.bytesC2h!));
    await until(() => got1.length + got2.length >= 249, 5000, '事件消费');
    stop1();
    stop2();
    const all = [...got1, ...got2].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 250 }, (_, i) => i).filter((i) => i !== 3)); // 恰好一次，除了抛错的那条
    expect(errs).toHaveLength(1);
    for (const g of [got1, got2]) expect(g).toEqual([...g].sort((a, b) => a - b)); // 各自内部保序
    expect(await raw.llen('relay:events')).toBe(0);
    pubR.disconnect();
    conR.disconnect();
    con2R.disconnect();
  });

  it('会话事件：列表上限 50000，超出丢弃最旧的', async () => {
    const r = new Redis(URL_);
    const pub = new RedisSessionEvents(r, 20);
    const pipe = r.pipeline();
    for (let i = 0; i < 50_000; i++) pipe.rpush('relay:events', JSON.stringify(ev(i)));
    await pipe.exec();
    await pub.publish(ev(99_999));
    expect(await r.llen('relay:events')).toBe(50_000);
    expect(JSON.parse((await r.lindex('relay:events', -1))!).sid).toBe('sid-99999');
    expect(JSON.parse((await r.lindex('relay:events', 0))!).sid).toBe('sid-1'); // sid-0 被挤掉
    await r.del('relay:events');
    r.disconnect();
  }, 60_000);

  it('总线：点对点、广播、取消订阅、保序、大消息与中文、一个实例订阅两个处理函数', async () => {
    const a = await mk();
    const b = await mk();
    const gotA: BusMessage[] = [];
    const gotB: BusMessage[] = [];
    const ida = uniq('A');
    const idb = uniq('B');
    const unA = await a.bus.subscribe(ida, (m) => void gotA.push(m));
    await b.bus.subscribe(idb, (m) => void gotB.push(m));
    await b.bus.publish(ida, { k: 'kick', code: '1', connId: 'c', reason: 'replaced' });
    await a.bus.broadcast({ k: 'notice', level: 'info', text: '你好，世界 🚀' });
    await until(() => gotA.length === 2 && gotB.length === 1, 3000, '总线投递');
    expect(gotA.map((m) => m.k).sort()).toEqual(['kick', 'notice']);
    expect(gotB[0]).toMatchObject({ k: 'notice', text: '你好，世界 🚀' });

    // 保序：同一发布者对同一频道的消息顺序不乱
    gotA.length = 0;
    for (let i = 0; i < 300; i++) await b.bus.publish(ida, { k: 'kick', code: String(i), connId: 'c', reason: 'r' });
    await until(() => gotA.length === 300, 5000, '300 条');
    expect(gotA.map((m) => (m as { code: string }).code)).toEqual(Array.from({ length: 300 }, (_, i) => String(i)));

    // 大消息（200KB 文本）
    gotA.length = 0;
    const big = 'x'.repeat(200_000);
    await b.bus.broadcast({ k: 'notice', level: 'info', text: big });
    await until(() => gotA.length === 1, 3000, '大消息');
    expect((gotA[0] as { text: string }).text.length).toBe(200_000);

    // 取消订阅后不再收到点对点消息
    await unA();
    gotA.length = 0;
    await b.bus.publish(ida, { k: 'kick', code: 'z', connId: 'c', reason: 'r' });
    await sleep(200);
    expect(gotA).toHaveLength(0);

    // 发给没有订阅者的实例：不报错，返回收到消息的订阅者数 0（信令据此判定“目标实例已退出”，立即给主控端返回 deliver_failed）
    await expect(b.bus.publish(uniq('nobody'), { k: 'kick', code: '1', connId: 'c', reason: 'r' })).resolves.toBe(0);
  });

  it('总线：非法 JSON 不会让订阅连接崩溃', async () => {
    const errs: unknown[] = [];
    const pub = new Redis(URL_);
    const bus = new RedisBus(new Redis(URL_), () => new Redis(URL_), (e) => errs.push(e));
    const got: BusMessage[] = [];
    const id = uniq('J');
    await bus.subscribe(id, (m) => void got.push(m));
    await pub.publish(`signal:${id}`, '{not json');
    await bus.publish(id, { k: 'kick', code: '1', connId: 'c', reason: 'r' });
    await until(() => got.length === 1, 2000, '合法消息');
    expect(errs).toHaveLength(1);
    await bus.close();
    pub.disconnect();
  });
});

d('真实 Redis：多实例全链路', () => {
  afterAll(async () => {
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
  });

  it('两个信令实例 + 一个中继：跨实例投递 connect.incoming、字节数回传落库、踢旧连接、锁定、票据一次性', async () => {
    await new Redis(URL_).flushdb();
    await crossInstanceFlow({ makeStores: () => mk() });
  }, 60_000);

  it.skipIf(!MYSQL)('同上，并接真实 MySQL 作为仓储（sessions 分区表落库字节数）', async () => {
    const db = createKnex(MYSQL);
    await db.migrate.latest();
    const repos = createKnexRepos(db);
    try {
      await crossInstanceFlow({ makeStores: () => mk(), repos });
    } finally {
      await repos.close();
    }
  }, 60_000);

  it('中继节点选择：负载最低优先、排空/已满/过期节点被排除、同地区优先、真实中继的上报带 30 秒 TTL', async () => {
    const raw = new Redis(URL_);
    await raw.flushdb();
    const stores = await mk();
    const s = await startStack({ stores, relayStores: await mk(), relay: { region: 'cn' } });
    const rep = (name: string, over: object) => ({ name, region: 'cn', publicUrl: `wss://${name}`, sessions: 0, capacity: 100, bandwidth: 0, status: 'up' as const, ts: Date.now(), ...over });
    try {
      // 真实中继启动时就上报了
      const real = (await stores.registry.list()).find((n) => n.name === 'relay-test');
      expect(real).toBeDefined();
      expect(await raw.pttl('relay:node:relay-test')).toBeGreaterThan(20_000);

      await stores.registry.report(rep('busy', { sessions: 80 }), 30_000);
      await stores.registry.report(rep('idle', { sessions: 5, region: 'cn' }), 30_000);
      await stores.registry.report(rep('full', { sessions: 100 }), 30_000);
      await stores.registry.report(rep('drain', { status: 'draining' }), 30_000);
      await stores.registry.report(rep('far-idle', { region: 'us', sessions: 0 }), 30_000);
      // 真实中继 relay-test 是 0 会话 0 带宽，先把它排除再比较
      await stores.registry.report({ ...real!, status: 'draining' }, 30_000);
      expect((await s.ctx.relays.pick('cn'))!.name).toBe('idle');
      expect((await s.ctx.relays.pick('us'))!.name).toBe('far-idle');
      expect((await s.ctx.relays.pick())!.name).toBe('far-idle'); // 不指定地区按负载
      await stores.registry.report(rep('idle', { sessions: 5, bandwidth: 0.9 }), 30_000); // 带宽高 -> 负载加权
      expect((await s.ctx.relays.pick('cn'))!.name).toBe('idle'); // 同地区里只要有可用的就优先
      await stores.registry.report(rep('idle', { sessions: 100 }), 30_000); // 满了
      expect((await s.ctx.relays.pick('cn'))!.name).toBe('busy');
      for (const n of ['busy', 'idle', 'full', 'drain', 'far-idle']) await stores.registry.remove(n);
      expect(await s.ctx.relays.pick('cn')).toBeNull(); // 只剩排空中的真实中继 -> 没有可用节点

      // 起第二个真实中继，注册后被选中
      const r2 = await startExtraRelay(() => mk(), 'relay-second', { region: 'cn' });
      try {
        await until(async () => (await stores.registry.list()).some((n) => n.name === 'relay-second'), 3000, '第二个中继上报');
        expect((await s.ctx.relays.pick('cn'))!.name).toBe('relay-second');
        expect((await s.ctx.relays.pick('cn'))!.publicUrl).toBe(r2.url);
      } finally {
        await r2.stop();
      }
      // 中继优雅退出会主动从注册表摘除
      expect((await stores.registry.list()).map((n) => n.name)).not.toContain('relay-second');
    } finally {
      await s.stop();
      raw.disconnect();
    }
  }, 30_000);
});

/**
 * 故障注入：信令和中继的 Redis 连接都经过本地 TCP 代理。
 * cut = 连接被拒绝（等同 redis 容器停止），freeze = 连接存在但无响应（等同进程挂起/网络黑洞）。
 */
d('真实 Redis：Redis 短暂不可用时的行为', () => {
  let proxy: TcpProxy;
  let proxied: string;
  let raw: Redis;

  beforeAll(async () => {
    raw = new Redis(URL_);
    await raw.flushdb();
    const target = new globalThis.URL(URL_);
    proxy = new TcpProxy(target.hostname, Number(target.port || 6379));
    await proxy.start();
    const u = new globalThis.URL(URL_);
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    proxied = u.toString();
  });
  afterAll(async () => {
    await proxy.restore().catch(() => {});
    await proxy.stop();
    raw.disconnect();
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
  });

  /** 在 ms 内持续重试直到成功 */
  async function eventually<T>(fn: () => Promise<T>, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await sleep(100);
      }
    }
  }

  it('断开：命令在几秒内失败（不会无限挂起）；恢复后自动重连，数据还在；总线自动重新订阅；事件消费继续', async () => {
    const stores = await mk(proxied);
    const other = await mk(); // 直连的“另一个实例”
    const k = uniq('outage');
    await stores.kv.set(k, 'alive', 60_000);
    const got: BusMessage[] = [];
    const id = uniq('I');
    await stores.bus.subscribe(id, (m) => void got.push(m));
    const seen: number[] = [];
    const stop = stores.sessionEvents.consume((e) => void seen.push(e.bytesC2h!));

    await proxy.cut();
    const t0 = Date.now();
    await expect(stores.kv.get(k)).rejects.toThrow();
    await expect(stores.presence.get('123456789')).rejects.toThrow();
    await expect(stores.limiter.hit('x', 1, 1000)).rejects.toThrow();
    await expect(stores.registry.list()).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(8000);

    // 断开期间别的实例发的消息、事件
    await other.bus.publish(id, { k: 'kick', code: 'lost', connId: 'c', reason: 'during outage' });
    await other.sessionEvents.publish({ type: 'ended', sid: 'during', node: 'n', reason: 'closed', bytesC2h: 42, bytesH2c: 1, ts: 1 });

    await proxy.restore();
    expect(await eventually(() => stores.kv.get(k))).toBe('alive');
    // 订阅连接自动恢复订阅：恢复之后发的消息能收到
    await eventually(async () => {
      await other.bus.publish(id, { k: 'kick', code: 'after', connId: 'c', reason: 'r' });
      await until(() => got.some((m) => (m as { code: string }).code === 'after'), 700, '恢复后的总线消息');
    });
    // 断开期间发布的总线消息是丢了的（Pub/Sub 不持久化），这是预期行为
    expect(got.some((m) => (m as { code: string }).code === 'lost')).toBe(false);
    // 事件列表是持久的：断开期间入列的事件，恢复后被消费
    await until(() => seen.includes(42), 5000, '断开期间的事件');
    stop();
  }, 40_000);

  it('会话事件发布：Redis 断开时不抛错、缓冲并按原顺序补发、不重复', async () => {
    await raw.del('relay:events');
    const r = new Redis(proxied, { maxRetriesPerRequest: 2, commandTimeout: 1000 });
    r.on('error', () => {});
    const errs: unknown[] = [];
    const ch = new RedisSessionEvents(r, 20, (e) => errs.push(e), 100);
    const mkEv = (i: number): RelaySessionEvent => ({ type: 'ended', sid: `b-${i}`, node: 'n', bytesC2h: i, ts: i });
    await ch.publish(mkEv(0));
    await proxy.cut();
    await ch.publish(mkEv(1));
    await ch.publish(mkEv(2));
    await ch.publish(mkEv(3));
    expect(ch.pending).toBe(3);
    expect(errs.length).toBeGreaterThan(0);
    await proxy.restore();
    await ch.publish(mkEv(4)); // 缓冲非空时排在后面
    await until(async () => (await raw.llen('relay:events')) === 5, 10_000, '补发');
    expect((await raw.lrange('relay:events', 0, -1)).map((x) => JSON.parse(x).bytesC2h)).toEqual([0, 1, 2, 3, 4]);
    expect(ch.pending).toBe(0);
    await raw.del('relay:events');
    r.disconnect();
  }, 30_000);

  it('冻结（连接在但无响应）：命令不应无限挂起', async () => {
    const stores = await mk(proxied);
    await stores.kv.set('freeze-probe', '1', 60_000);
    proxy.freeze();
    const t0 = Date.now();
    const r = await Promise.race([
      stores.kv.get('freeze-probe').then(() => 'ok', () => 'rejected'),
      sleep(12_000).then(() => 'hung'),
    ]);
    const took = Date.now() - t0;
    await proxy.restore();
    expect(r).toBe('rejected');
    expect(took).toBeLessThan(8000);
    expect(await eventually(() => stores.kv.get('freeze-probe'))).toBe('1');
  }, 40_000);

  it('全链路：Redis 断开期间已建立的会话继续转发，新连接请求被拒绝为 NO_RELAY，中继在断开期间结束的会话字节数不丢，恢复后一切照常', async () => {
    await raw.flushdb();
    const stores = await mk(proxied);
    const relayStores = await mk(proxied);
    const s = await startStack({ stores, relayStores });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const open = async (): Promise<{ sid: string; h: RelayConn; c: RelayConn }> => {
        const incP = host.sig.waitIncoming();
        const resP = ctl.sig.connectRequest(host.identity.deviceCode);
        const inc = await incP;
        const goP = host.sig.acceptGo(inc.session_id);
        const res = await resP;
        if (!res.ok) throw new Error(res.code);
        const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
        return { sid: inc.session_id, h, c };
      };
      await until(async () => (await stores.registry.list()).length === 1, 3000, '中继上报');
      const s1 = await open(); // 断开期间保持的会话
      const s2 = await open(); // 断开期间结束的会话
      await s1.c.send(Buffer.from('before'));
      await s1.h.waitCount(1);
      await s2.c.send(Buffer.from('12345'));
      await s2.h.waitCount(1);
      host.sig.report(s1.sid, 'auth_ok');
      host.sig.report(s2.sid, 'auth_ok');
      await until(async () => (await s.repos.sessions.get(s1.sid))!.status === SessionStatus.Authed, 4000, 's1 认证');
      await until(async () => (await s.repos.sessions.get(s2.sid))!.status === SessionStatus.Authed, 4000, 's2 认证');

      await proxy.cut();
      // 1) 信令连接和心跳不受影响
      expect(await ctl.sig.request('ping', {})).toMatchObject({ t: 'pong' });
      // 2) 已建立的会话继续转发
      await s1.c.send(Buffer.from('during'));
      await s1.h.waitCount(2);
      expect(s1.h.received[1]!.toString()).toBe('during');
      // 3) 新的连接请求被拒绝（NO_RELAY），而不是挂住
      const t0 = Date.now();
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'NO_RELAY' });
      expect(Date.now() - t0).toBeLessThan(8000);
      // 4) 断开期间会话 s2 结束：中继要把 ended（含字节数）攒着，恢复后补发
      s2.c.close();
      await s2.h.closed;
      await sleep(1500);

      await proxy.restore();
      // 恢复后新建连接成功（重连需要一点时间，期间的请求可能仍被拒绝）
      await eventually(async () => {
        const incP = host.sig.waitIncoming();
        const resP = ctl.sig.connectRequest(host.identity.deviceCode);
        const first = await Promise.race([incP.then((i) => ({ i })), resP.then((r) => ({ r }))]);
        if ('r' in first) throw new Error(`连接失败：${JSON.stringify(first.r)}`);
        host.sig.accept(first.i.session_id);
        const res = await resP;
        if (!res.ok) throw new Error(res.code);
        expect(res.data.session_id).toBe(first.i.session_id);
      }, 20_000);

      // s1 还活着
      await s1.c.send(Buffer.from('after'));
      await s1.h.waitCount(3);
      // s2 的 ended 事件最终要落库，字节数正确
      await until(async () => (await s.repos.sessions.get(s2.sid))!.status === SessionStatus.Ended, 20_000, 's2 结束事件补发');
      expect(await s.repos.sessions.get(s2.sid)).toMatchObject({ bytesC2h: 5, bytesH2c: 0 });
      s1.c.close();
      await s1.h.closed;
      await until(async () => (await s.repos.sessions.get(s1.sid))!.status === SessionStatus.Ended, 10_000, 's1 结束');
      expect(await s.repos.sessions.get(s1.sid)).toMatchObject({ bytesC2h: 6 + 6 + 5 });
    } finally {
      await proxy.restore();
      await s.stop();
    }
  }, 90_000);

  it('Redis 数据丢失（等同无持久化重启）：在线状态由 ping 自动重新登记，中继节点在下一个上报周期重新出现', async () => {
    await raw.flushdb();
    const stores = await mk();
    const s = await startStack({ stores, relayStores: await mk() });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      expect(await stores.presence.get(host.identity.deviceCode)).not.toBeNull();
      await raw.flushdb();
      expect(await stores.presence.get(host.identity.deviceCode)).toBeNull();
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      // 被控端下一次心跳会补登记
      expect(await host.sig.request('ping', {})).toMatchObject({ t: 'pong' });
      await until(async () => (await stores.presence.get(host.identity.deviceCode)) !== null, 3000, '在线状态恢复');
      // 中继节点上报周期 10 秒
      await until(async () => (await stores.registry.list()).length === 1, 13_000, '中继重新上报');
      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      host.sig.accept(inc.session_id);
      expect((await resP).ok).toBe(true);
    } finally {
      await s.stop();
    }
  }, 40_000);
});

d('真实 Redis：等待确认期间的清理（Pub/Sub 不持久化时的兜底）', () => {
  let proxy: TcpProxy;
  let proxied: string;
  let raw: Redis;

  beforeAll(async () => {
    raw = new Redis(URL_);
    await raw.flushdb();
    const target = new globalThis.URL(URL_);
    proxy = new TcpProxy(target.hostname, Number(target.port || 6379));
    await proxy.start();
    const u = new globalThis.URL(URL_);
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    proxied = u.toString();
  });
  afterAll(async () => {
    await proxy.restore().catch(() => {});
    await proxy.stop();
    raw.disconnect();
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
  });

  /** 实例 A 的 Redis 连接经过代理（可以被切断），实例 B 和中继直连 */
  async function setup() {
    const s = await startStack({ stores: await mk(proxied), relayStores: await mk(), tunables: { pendingCheckMs: 200 } });
    const ctxB = await createContext(s.cfg, silentLogger(), { stores: await mk(), repos: s.repos });
    const appB = await startSignalApp(ctxB, 0, '127.0.0.1');
    return { s, appB, wsB: `ws://127.0.0.1:${appB.port}/v1/signal` };
  }
  const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${ms}ms 内没有结果`)), ms))]);

  it('目标实例已经不存在：PUBLISH 返回 0 个订阅者，主控端立即收到 UNAVAILABLE + deliver_failed', async () => {
    const { s, appB } = await setup();
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      const row = (await s.repos.devices.findByUid(identity.deviceId))!;
      await s.stores.presence.set(identity.deviceCode, info(identity.deviceCode, 'gone', { instanceId: 'dead-instance', deviceId: row.id, deviceUid: row.uid }));
      const t0 = Date.now();
      expect(await ctl.sig.connectRequest(identity.deviceCode)).toMatchObject({ ok: false, code: 'UNAVAILABLE', data: { reason: 'deliver_failed' } });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await appB.stop();
      await s.stop();
    }
  }, 30_000);

  it('Redis 断开期间被控端掉线（通知主控端的 Pub/Sub 消息丢了）：恢复后定期检查发现被控端不在线，主控端收到 UNAVAILABLE', async () => {
    const { s, appB, wsB } = await setup();
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      const host = await SignalClient.connect(wsB, identity);
      const h = ctl.sig.startConnect(identity.deviceCode, 0);
      await host.waitIncoming();
      await proxy.cut(); // A 的命令和订阅连接都断了
      host.ws.terminate(); // B 直连 Redis：清掉在线状态、发布 reply，但 A 收不到
      await sleep(500);
      await proxy.restore();
      expect(await within(h.result, 40_000)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect(await ctl.sig.request('ping', {})).toMatchObject({ t: 'pong' });
    } finally {
      await proxy.restore();
      await appB.stop();
      await s.stop();
    }
  }, 60_000);

  it('Redis 断开期间主控端掉线（A 的清理写不进 Redis）：被控端的确认弹窗最迟在主控端在线状态过期后被撤掉', async () => {
    const { s, appB, wsB } = await setup();
    try {
      const ctl = await onlineDevice(s);
      const { identity } = await registerNew(s.http);
      const host = await SignalClient.connect(wsB, identity);
      const h = ctl.sig.startConnect(identity.deviceCode, 0);
      void h.result.catch(() => {});
      const inc = await host.waitIncoming();
      const cancelled = host.waitCancelled(inc.session_id, 60_000);
      await proxy.cut();
      ctl.sig.ws.terminate(); // 通知被控端的消息和 presence 清理都没能写进 Redis
      await sleep(500);
      await proxy.restore();
      // 在线状态是带 90 秒有效期的：这里手动让它马上过期，等价于“最迟 90 秒后”
      await raw.pexpire(`presence:${ctl.identity.deviceCode}`, 100);
      await within(cancelled, 40_000);
    } finally {
      await proxy.restore();
      await appB.stop();
      await s.stop();
    }
  }, 90_000);
});
