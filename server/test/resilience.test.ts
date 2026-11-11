import { describe, expect, it } from 'vitest';
import { MemoryDevicesRepo, MemorySessionsRepo } from '../src/db/repos/memory.js';
import { ResilientSessionsRepo, WriteQueue } from '../src/db/repos/resilient.js';
import { DuplicateError, SessionStatus, type SessionsRepo } from '../src/db/repos/index.js';
import { silentLogger } from '../src/logger.js';
import { DeviceDirectory } from '../src/service/device-directory.js';
import { newDeviceCode, newUlid } from '../src/crypto.js';
import { randomBytes } from 'node:crypto';
import { sleep } from './helpers.js';

/** 可以随时“断开数据库”的会话仓储 */
class FlakySessions extends MemorySessionsRepo {
  down = false;
  override async create(...a: Parameters<SessionsRepo['create']>): Promise<void> {
    if (this.down) throw new Error('MySQL 连接失败');
    if (await this.get(a[0].uid)) throw new DuplicateError('other'); // 和真实唯一索引一致
    return super.create(...a);
  }
  override async transition(...a: Parameters<SessionsRepo['transition']>): Promise<boolean> {
    if (this.down) throw new Error('MySQL 连接失败');
    return super.transition(...a);
  }
}

const newSession = (uid = newUlid()) => ({ uid, controllerDeviceId: 1, hostDeviceId: 2, relayNode: 'n', controllerIp: null, hostIp: null });

describe('MySQL 不可用时的降级（实现方案 10.1）', () => {
  it('会话写入失败进入内存补写队列，恢复后按原顺序补写（create 先于 transition）', async () => {
    const inner = new FlakySessions();
    const q = new WriteQueue(silentLogger(), 100, 20);
    const repo = new ResilientSessionsRepo(inner, q);
    inner.down = true;
    const uid = newUlid();
    await repo.create(newSession(uid));
    expect(await repo.transition(uid, { status: SessionStatus.Accepted }, [SessionStatus.Pending])).toBe(true); // 入队时乐观返回
    expect(q.size).toBe(2);
    inner.down = false;
    // 队列非空时新的写入也排在后面，保证顺序
    const uid2 = newUlid();
    await repo.create(newSession(uid2));
    expect(q.size === 0 || q.size === 3).toBe(true);
    for (let i = 0; i < 50 && q.size > 0; i++) await sleep(20);
    expect(q.size).toBe(0);
    expect((await inner.get(uid))!.status).toBe(SessionStatus.Accepted);
    expect(await inner.get(uid2)).not.toBeNull();
    q.stop();
  });

  it('队列满了丢弃新的写入并计数', async () => {
    const inner = new FlakySessions();
    const q = new WriteQueue(silentLogger(), 3, 60_000);
    const repo = new ResilientSessionsRepo(inner, q);
    inner.down = true;
    for (let i = 0; i < 6; i++) await repo.create(newSession());
    expect(q.size).toBe(3);
    expect(q.dropped).toBe(3);
    q.stop();
  });

  it('补写时撞上唯一索引（上次写入其实已成功）：丢弃该条继续，不堵死队列', async () => {
    const inner = new FlakySessions();
    const q = new WriteQueue(silentLogger(), 100, 60_000);
    const repo = new ResilientSessionsRepo(inner, q);
    const dup = newUlid();
    await inner.create(newSession(dup));
    // 库没挂时的重复写入：直接丢弃，不入队
    await repo.create(newSession(dup));
    expect(q.size).toBe(0);
    expect(q.dropped).toBe(1);
    // 库挂着时入队，恢复后队首是重复键，后面的仍要写成功
    inner.down = true;
    await repo.create(newSession(dup));
    const next = newUlid();
    await repo.create(newSession(next));
    expect(q.size).toBe(2);
    inner.down = false;
    await q.flush();
    expect(q.size).toBe(0);
    expect(q.dropped).toBe(2);
    expect(await inner.get(next)).not.toBeNull();
    q.stop();
  });

  it('读操作不受队列影响，仍直接访问仓储', async () => {
    const inner = new FlakySessions();
    const q = new WriteQueue(silentLogger(), 10, 60_000);
    const repo = new ResilientSessionsRepo(inner, q);
    const uid = newUlid();
    await repo.create(newSession(uid));
    expect((await repo.get(uid))!.uid).toBe(uid);
    expect(q.size).toBe(0);
    q.stop();
  });
});

describe('设备记录缓存（6.3：进程内缓存 5 分钟；10.1：库不可用时延长）', () => {
  class FlakyDevices extends MemoryDevicesRepo {
    down = false;
    calls = 0;
    override async findByUid(uid: string) {
      this.calls++;
      if (this.down) throw new Error('MySQL 连接失败');
      return super.findByUid(uid);
    }
  }

  async function seed(repo: MemoryDevicesRepo) {
    return repo.create({ uid: newUlid(), code: newDeviceCode(), publicKey: randomBytes(32), kind: 'desktop', platform: 'windows', arch: 'x86_64', osVersion: '', appVersion: '', registerIp: null });
  }

  it('缓存期内不查库；过期后重新查', async () => {
    const repo = new FlakyDevices();
    const d = await seed(repo);
    const dir = new DeviceDirectory(repo, silentLogger(), 100);
    await dir.getByUid(d.uid);
    await dir.getByUid(d.uid);
    expect(repo.calls).toBe(1);
    await sleep(130);
    await dir.getByUid(d.uid);
    expect(repo.calls).toBe(2);
    dir.invalidate(d.uid);
    await dir.getByUid(d.uid);
    expect(repo.calls).toBe(3);
  });

  it('库不可用时使用过期缓存继续认证；没有缓存则抛错', async () => {
    const repo = new FlakyDevices();
    const d = await seed(repo);
    const dir = new DeviceDirectory(repo, silentLogger(), 50);
    await dir.getByUid(d.uid);
    await sleep(80);
    repo.down = true;
    expect((await dir.getByUid(d.uid))!.uid).toBe(d.uid);
    await expect(dir.getByUid('01UNKNOWN0000000000000000')).rejects.toThrow();
  });

  it('不存在的设备返回 null（不缓存）', async () => {
    const repo = new FlakyDevices();
    const dir = new DeviceDirectory(repo, silentLogger());
    expect(await dir.getByUid('01NOSUCH')).toBeNull();
    expect(await dir.getByUid('01NOSUCH')).toBeNull();
    expect(repo.calls).toBe(2);
  });
});

describe('Redis 不可用时的降级（10.1：拒绝新的连接请求，已建立的会话不受影响）', () => {
  it('存储抛错时 connect.request 返回 NO_RELAY，信令连接和已配对的中继会话不受影响', async () => {
    const { startStack, onlineDevice } = await import('./helpers.js');
    const { RelayConn } = await import('../tools/rterm-client.js');
    const s = await startStack();
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      // 先建立一个会话
      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      const goP = host.sig.acceptGo(inc.session_id);
      const res = await resP;
      if (!res.ok) throw new Error(res.code);
      const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);

      // “Redis 挂了”
      const boom = async (): Promise<never> => {
        throw new Error('Redis 不可用');
      };
      const origGet = s.stores.presence.get;
      s.stores.presence.get = boom;
      const r = await ctl.sig.connectRequest(host.identity.deviceCode);
      expect(r).toMatchObject({ ok: false, code: 'NO_RELAY' });
      expect(await ctl.sig.request('ping', {})).toMatchObject({ t: 'pong' });
      // 已建立的会话继续转发
      await c.send(Buffer.from('still alive'));
      await h.waitCount(1);
      expect(h.received[0]!.toString()).toBe('still alive');
      s.stores.presence.get = origGet;

      // 限流存储不可用同样降级
      const origHit = s.stores.limiter.hit;
      s.stores.limiter.hit = boom;
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'NO_RELAY' });
      s.stores.limiter.hit = origHit;
      c.close();
    } finally {
      await s.stop();
    }
  });
});

describe('Redis 不可用时的注册', () => {
  it('限流存储抛错：返回 503 UNAVAILABLE（带 Retry-After），而不是 500；恢复后可以注册', async () => {
    const { startStack } = await import('./helpers.js');
    const { registerNew } = await import('../tools/rterm-client.js');
    const s = await startStack();
    try {
      const origHit = s.stores.limiter.hit;
      s.stores.limiter.hit = async () => {
        throw new Error('Redis 不可用');
      };
      await expect(registerNew(s.http)).rejects.toThrow(/503|UNAVAILABLE/);
      s.stores.limiter.hit = origHit;
      await expect(registerNew(s.http)).resolves.toBeTruthy();
    } finally {
      await s.stop();
    }
  });
});
