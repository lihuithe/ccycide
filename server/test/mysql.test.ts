import { randomBytes } from 'node:crypto';
import knexLib, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnex } from '../src/db/knex.js';
import { createKnexRepos } from '../src/db/repos/mysql.js';
import { DuplicateError, SessionStatus, type Repos } from '../src/db/repos/index.js';
import { maintainSessionPartitions, listSessionPartitions } from '../src/jobs/partitions.js';
import { newDeviceCode, newUlid } from '../src/crypto.js';
import { RelayConn, SignalClient, registerNew } from '../tools/rterm-client.js';
import { createRepos } from '../src/db/repos/index.js';
import { silentLogger } from '../src/logger.js';
import { onlineDevice, sleep, startStack, testConfig, until } from './helpers.js';
import { TcpProxy } from './tcp-proxy.js';

/*
 * MySQL 集成测试。需要一个可用的 MySQL 8（本机没有，可用 mysql-memory-server 起一个）：
 *   TEST_MYSQL_URL=mysql://root@127.0.0.1:PORT/rterm npm test
 * 没有设置 TEST_MYSQL_URL 时整个文件跳过。数据库必须已存在；迁移由本测试自动执行。
 */
const URL_ = process.env.TEST_MYSQL_URL ?? '';
const d = describe.skipIf(!URL_);

d('MySQL：迁移与仓储层（knex）', () => {
  let db: Knex;
  let repos: Repos;

  beforeAll(async () => {
    db = createKnex(URL_);
    await db.migrate.latest();
    repos = createKnexRepos(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('迁移建出全部表，再执行一次没有新迁移', async () => {
    const [rows] = await db.raw('show tables');
    const names = (rows as Array<Record<string, string>>).map((r) => Object.values(r)[0]);
    for (const t of ['devices', 'sessions', 'security_events', 'bans', 'relay_nodes', 'app_releases', 'app_config', 'daily_stats', 'admin_users', 'admin_audit_logs']) {
      expect(names).toContain(t);
    }
    const [batch, files] = await db.migrate.latest();
    expect(files).toEqual([]);
    expect(batch).toBeGreaterThan(0);
  });

  it('设备：插入、按各键查询、唯一索引冲突区分 public_key / device_code', async () => {
    const pk = randomBytes(32);
    const code = newDeviceCode();
    const uid = newUlid();
    const rec = await repos.devices.create({ uid, code, publicKey: pk, kind: 'desktop', platform: 'windows', arch: 'x86_64', osVersion: '10', appVersion: '1.0', registerIp: Buffer.from([1, 2, 3, 4]) });
    expect(rec).toMatchObject({ uid, code, kind: 'desktop', status: 0 });
    expect(rec.publicKey.equals(pk)).toBe(true);
    expect(rec.registerIp).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(rec.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(rec.createdAt.getTime() - Date.now())).toBeLessThan(60_000); // UTC 存取没有时区偏移
    expect((await repos.devices.findByCode(code))!.uid).toBe(uid);
    expect((await repos.devices.findByPublicKey(pk))!.id).toBe(rec.id);
    expect((await repos.devices.findById(rec.id))!.uid).toBe(uid);

    await expect(repos.devices.create({ uid: newUlid(), code: newDeviceCode(), publicKey: pk, kind: 'cli', platform: 'linux', arch: 'x86_64', osVersion: '', appVersion: '', registerIp: null })).rejects.toMatchObject({ field: 'public_key' });
    await expect(repos.devices.create({ uid: newUlid(), code, publicKey: randomBytes(32), kind: 'cli', platform: 'linux', arch: 'x86_64', osVersion: '', appVersion: '', registerIp: null })).rejects.toMatchObject({ field: 'device_code' });
    await expect(repos.devices.create({ uid: newUlid(), code: newDeviceCode(), publicKey: randomBytes(32), kind: 'cli', platform: 'linux', arch: 'x86_64', osVersion: '', appVersion: '', registerIp: null })).resolves.toBeTruthy();

    await repos.devices.updateInfo(rec.id, { platform: 'linux', osVersion: '6.1', appVersion: '2.0' });
    const when = new Date();
    await repos.devices.touchSeen(rec.id, Buffer.from([9, 9, 9, 9]), when, '2.1');
    const after = (await repos.devices.findById(rec.id))!;
    expect(after).toMatchObject({ platform: 'linux', osVersion: '6.1', appVersion: '2.1' });
    expect(after.lastIp).toEqual(Buffer.from([9, 9, 9, 9]));
    expect(Math.abs(after.lastSeenAt!.getTime() - when.getTime())).toBeLessThan(2);
    await repos.devices.setStatus(rec.id, 1);
    expect((await repos.devices.findById(rec.id))!.status).toBe(1);
    expect((await repos.devices.search({ text: code, limit: 10, offset: 0 })).total).toBe(1);
    expect((await repos.devices.search({ status: 1, limit: 10, offset: 0 })).items.some((x) => x.uid === uid)).toBe(true);
    expect(await repos.devices.countCreatedSince(new Date(Date.now() - 3600_000))).toBeGreaterThan(0);
    expect(await repos.devices.countSeenSince(new Date(Date.now() - 3600_000))).toBeGreaterThan(0);
  });

  it('会话（分区表）：创建、状态迁移只往前、列表、统计', async () => {
    const mk = async (n: string) =>
      repos.devices.create({ uid: newUlid(), code: newDeviceCode(), publicKey: randomBytes(32), kind: 'desktop', platform: 'windows', arch: 'x86_64', osVersion: n, appVersion: '', registerIp: null });
    const c = await mk('c');
    const h = await mk('h');
    const uid = newUlid();
    await repos.sessions.create({ uid, controllerDeviceId: c.id, hostDeviceId: h.id, relayNode: 'relay-01', controllerIp: Buffer.from([1, 1, 1, 1]), hostIp: null });
    expect(await repos.sessions.get(uid)).toMatchObject({ status: 0, relayNode: 'relay-01', controllerDeviceId: c.id, hostDeviceId: h.id, bytesC2h: 0 });
    expect(await repos.sessions.transition(uid, { status: SessionStatus.Accepted }, [SessionStatus.Pending])).toBe(true);
    expect(await repos.sessions.transition(uid, { status: SessionStatus.Accepted }, [SessionStatus.Pending])).toBe(false);
    expect(await repos.sessions.transition(uid, { status: SessionStatus.Authed, authedAt: new Date() }, [SessionStatus.Accepted, SessionStatus.Paired])).toBe(true);
    expect(await repos.sessions.transition(uid, { status: SessionStatus.Ended, endedAt: new Date(), bytesC2h: 5_000_000_000, bytesH2c: 7 }, [SessionStatus.Authed])).toBe(true);
    const row = (await repos.sessions.get(uid))!;
    expect(row).toMatchObject({ status: SessionStatus.Ended, bytesC2h: 5_000_000_000, bytesH2c: 7 });
    expect(row.authedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
    // 终态不会被覆盖
    expect(await repos.sessions.transition(uid, { status: SessionStatus.Failed }, [SessionStatus.Pending, SessionStatus.Accepted])).toBe(false);
    expect((await repos.sessions.list({ deviceId: h.id, limit: 10, offset: 0 })).map((s) => s.uid)).toEqual([uid]);
    expect((await repos.sessions.list({ status: 4, limit: 100, offset: 0 })).some((s) => s.uid === uid)).toBe(true);
    const cnt = await repos.sessions.countSince(new Date(Date.now() - 3600_000));
    expect(cnt.total).toBeGreaterThan(0);
    expect(cnt.authed).toBeGreaterThan(0);
  });

  it('并发：同公钥并发注册只有一个成功；同一会话并发状态迁移只有一个赢；批量并发插入不丢', async () => {
    const mk = (pk: Buffer) => repos.devices.create({ uid: newUlid(), code: newDeviceCode(), publicKey: pk, kind: 'cli', platform: 'linux', arch: 'x86_64', osVersion: '', appVersion: '', registerIp: null });
    const pk = randomBytes(32);
    const rs = await Promise.allSettled(Array.from({ length: 12 }, () => mk(pk)));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DuplicateError);

    const c = await mk(randomBytes(32));
    const h = await mk(randomBytes(32));
    const uid = newUlid();
    await repos.sessions.create({ uid, controllerDeviceId: c.id, hostDeviceId: h.id, relayNode: 'n', controllerIp: null, hostIp: null });
    const wins = await Promise.all(Array.from({ length: 20 }, () => repos.sessions.transition(uid, { status: SessionStatus.Accepted }, [SessionStatus.Pending])));
    expect(wins.filter(Boolean)).toHaveLength(1);

    const many = await Promise.all(Array.from({ length: 100 }, () => mk(randomBytes(32))));
    expect(new Set(many.map((m) => m.id)).size).toBe(100);
    expect(new Set(many.map((m) => m.code)).size).toBe(100);
  });

  it('安全事件（JSON 字段）、审计日志', async () => {
    await repos.events.add({ type: 'auth_failed', targetDeviceId: 1, sourceDeviceId: 2, sourceIp: Buffer.from([8, 8, 8, 8]), sessionUid: newUlid(), detail: { reason: '中文', n: 1 } });
    await repos.events.add({ type: 'enum_suspected', sourceDeviceId: 2 });
    const ev = await repos.events.list({ type: 'auth_failed', deviceId: 2, limit: 5, offset: 0 });
    expect(ev[0]).toMatchObject({ type: 'auth_failed', targetDeviceId: 1, sourceDeviceId: 2, detail: { reason: '中文', n: 1 } });
    expect(ev[0]!.sourceIp).toEqual(Buffer.from([8, 8, 8, 8]));
    expect((await repos.events.list({ type: 'enum_suspected', limit: 5, offset: 0 }))[0]!.detail).toBeNull();
    expect(await repos.events.deleteOlderThan(new Date(Date.now() + 1000))).toBeGreaterThan(0);

    await repos.audit.add({ adminId: 0, action: 'test.action', target: 't', detail: { a: [1, 2] }, ip: Buffer.from([1, 2, 3, 4]) });
    const a = await repos.audit.list({ limit: 1, offset: 0 });
    expect(a[0]).toMatchObject({ action: 'test.action', detail: { a: [1, 2] } });
    expect(await repos.audit.deleteOlderThan(new Date(Date.now() + 1000))).toBeGreaterThan(0);
  });

  it('封禁：设备 / IP / CIDR 命中、到期不命中、覆盖更新、删除过期', async () => {
    const uid = newUlid();
    const ban = await repos.bans.add({ kind: 'device', value: uid, reason: 'r1', source: 'manual', expiresAt: null, createdBy: 'a' });
    expect((await repos.bans.findActive({ deviceUid: uid }))!.id).toBe(ban.id);
    const again = await repos.bans.add({ kind: 'device', value: uid, reason: 'r2', source: 'auto', expiresAt: new Date(Date.now() + 60_000), createdBy: 'b' });
    expect(again.id).toBe(ban.id);
    expect(again).toMatchObject({ reason: 'r2', source: 'auto' });
    await repos.bans.add({ kind: 'ip', value: '203.0.113.9', reason: '', source: 'manual', expiresAt: null, createdBy: '' });
    await repos.bans.add({ kind: 'cidr', value: '198.18.0.0/15', reason: '', source: 'manual', expiresAt: null, createdBy: '' });
    expect(await repos.bans.findActive({ ip: '203.0.113.9' })).not.toBeNull();
    expect(await repos.bans.findActive({ ip: '203.0.113.10' })).toBeNull();
    expect(await repos.bans.findActive({ ip: '198.19.5.5' })).not.toBeNull();
    expect(await repos.bans.findActive({ ip: '198.20.0.1' })).toBeNull();
    await repos.bans.add({ kind: 'device', value: 'EXPIRED-' + uid.slice(8), reason: '', source: 'auto', expiresAt: new Date(Date.now() - 1000), createdBy: '' });
    expect(await repos.bans.findActive({ deviceUid: 'EXPIRED-' + uid.slice(8) })).toBeNull();
    expect((await repos.bans.list({})).some((b) => b.value.startsWith('EXPIRED-'))).toBe(false);
    expect((await repos.bans.list({ includeExpired: true })).some((b) => b.value.startsWith('EXPIRED-'))).toBe(true);
    expect(await repos.bans.deleteExpired()).toBeGreaterThan(0);
    expect(await repos.bans.removeByValue('ip', '203.0.113.9')).toBe(1);
    expect(await repos.bans.remove(ban.id)).toBe(true);
  });

  it('版本发布与下发配置、中继节点、每日统计', async () => {
    const v = `9.${Math.floor(Math.random() * 1e6)}.0`;
    const r = await repos.releases.insert({ version: v, kind: 'desktop', platform: 'windows', arch: 'x86_64', channel: 'stable', downloadUrl: 'https://x/y', signature: 'sig', notes: '说明', rolloutPercent: 50, status: 1 });
    expect(r).toMatchObject({ version: v, rolloutPercent: 50, status: 1, notes: '说明' });
    await expect(repos.releases.insert({ version: v, kind: 'desktop', platform: 'windows', arch: 'x86_64', channel: 'stable', downloadUrl: 'u', signature: 's', notes: null, rolloutPercent: 100, status: 1 })).rejects.toBeInstanceOf(DuplicateError);
    expect(await repos.releases.update(r.id, { rolloutPercent: 100 })).toBe(true);
    expect(await repos.releases.update(r.id, { rolloutPercent: 100 })).toBe(true); // 值没变也算存在
    expect(await repos.releases.update(999_999_999, { status: 0 })).toBe(false);
    expect((await repos.releases.findActive({ kind: 'desktop', platform: 'windows', arch: 'x86_64', channel: 'stable' })).some((x) => x.id === r.id && x.rolloutPercent === 100)).toBe(true);
    await repos.releases.update(r.id, { status: 0 });
    expect((await repos.releases.findActive({ kind: 'desktop', platform: 'windows', arch: 'x86_64', channel: 'stable' })).some((x) => x.id === r.id)).toBe(false);

    await repos.appConfig.set('adapters', [{ id: 'x', match: {} }], '备注', 'admin');
    await repos.appConfig.set('adapters', [{ id: 'y', match: {} }], '备注2', 'admin');
    const e = (await repos.appConfig.getAll()).find((x) => x.key === 'adapters')!;
    expect(e).toMatchObject({ value: [{ id: 'y', match: {} }], remark: '备注2' });
    expect(await repos.appConfig.delete('adapters')).toBe(true);

    const n = await repos.relayNodes.upsert({ name: 'relay-it', region: 'cn-east', publicUrl: 'wss://a', status: 1, capacity: 10 });
    const n2 = await repos.relayNodes.upsert({ name: 'relay-it', region: 'cn-north', publicUrl: 'wss://b', status: 2, capacity: 20 });
    expect(n2.id).toBe(n.id);
    expect(n2).toMatchObject({ region: 'cn-north', status: 2, capacity: 20 });
    expect(await repos.relayNodes.remove('relay-it')).toBe(true);

    await db('daily_stats').where({ stat_date: '2030-01-02' }).delete();
    await repos.stats.apply('2030-01-02', { newDevices: 2, sessionsTotal: 3, bytesRelayed: 4_000_000_000 }, { peakOnline: 5, activeDevices: 7 });
    await repos.stats.apply('2030-01-02', { newDevices: 1, authFailures: 2 }, { peakOnline: 3, peakSessions: 9 });
    const st = (await repos.stats.range('2030-01-02', '2030-01-02'))[0]!;
    expect(st).toMatchObject({ statDate: '2030-01-02', newDevices: 3, sessionsTotal: 3, authFailures: 2, bytesRelayed: 4_000_000_000, peakOnline: 5, peakSessions: 9, activeDevices: 7 });
  });
});

d('MySQL：完整链路（信令 + 中继 + knex 仓储，STORE=mysql 等价）', () => {
  it('注册 -> 认证 -> 连接 -> 中继互发 -> 会话状态与字节数写入 MySQL；封禁 / 锁定落库', async () => {
    const db = createKnex(URL_);
    await db.migrate.latest();
    const repos = createKnexRepos(db);
    const s = await startStack({ repos });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      // 注册幂等也走真实唯一索引
      const dupe = await registerNew(s.http);
      expect(dupe.identity.deviceCode).toMatch(/^\d{9}$/);

      const incP = host.sig.waitIncoming();
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const inc = await incP;
      const goP = host.sig.acceptGo(inc.session_id);
      const res = await resP;
      if (!res.ok) throw new Error(res.code);
      const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
      await c.send(randomBytes(1234));
      await h.send(randomBytes(4321));
      await Promise.all([h.waitCount(1), c.waitCount(1)]);
      host.sig.report(inc.session_id, 'auth_ok');
      await until(async () => (await repos.sessions.get(inc.session_id))!.status === SessionStatus.Authed, 5000, '状态 3');
      c.close();
      await h.closed;
      await until(async () => (await repos.sessions.get(inc.session_id))!.status === SessionStatus.Ended, 5000, '状态 4');
      expect(await repos.sessions.get(inc.session_id)).toMatchObject({ bytesC2h: 1234, bytesH2c: 4321 });

      // 5 次密码失败 -> security_events 落库 + 锁定
      for (let i = 0; i < 5; i++) {
        const p = host.sig.waitIncoming();
        const r = ctl.sig.connectRequest(host.identity.deviceCode);
        const x = await p;
        host.sig.accept(x.session_id);
        await r;
        host.sig.report(x.session_id, 'auth_failed');
      }
      await until(async () => (await s.ctx.guard.getLock(host.identity.deviceCode)) !== null, 3000, '锁定');
      const hostRow = (await repos.devices.findByUid(host.identity.deviceId))!;
      expect((await repos.events.list({ type: 'auth_failed', deviceId: hostRow.id, limit: 20, offset: 0 })).length).toBe(5);
      expect(await ctl.sig.connectRequest(host.identity.deviceCode)).toMatchObject({ ok: false, code: 'LOCKED' });

      // 管理接口封禁 -> bans 表 + devices.status
      const H = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      expect((await fetch(`${s.http}/v1/admin/devices/${ctl.identity.deviceCode}/ban`, { method: 'POST', headers: H, body: JSON.stringify({ reason: 'it' }) })).status).toBe(200);
      expect(await ctl.sig.closed).toBe(4403);
      await expect(SignalClient.connect(s.ws, ctl.identity)).rejects.toMatchObject({ code: 'BANNED' });
      expect((await repos.devices.findByUid(ctl.identity.deviceId))!.status).toBe(1);

      // 配置与统计
      s.ctx.configService.invalidate();
      expect(((await (await fetch(`${s.http}/v1/config`)).json()) as { adapters: unknown[] }).adapters).toHaveLength(2);
      await s.ctx.collector.flush();
      const today = new Date().toISOString().slice(0, 10);
      const stat = (await repos.stats.range(today, today))[0]!;
      expect(stat.newDevices).toBeGreaterThanOrEqual(3);
      expect(stat.sessionsTotal).toBeGreaterThanOrEqual(6);
      expect(stat.authFailures).toBeGreaterThanOrEqual(5);
    } finally {
      await s.stop();
      await repos.close();
    }
  }, 60_000);
});

d('MySQL：sessions 分区维护（在独立的临时库里做，会 DROP PARTITION）', () => {
  it('补建未来分区、删除 6 个月前的分区，且分区里的数据按月落位', async () => {
    const u = new globalThis.URL(URL_);
    const admin = knexLib({ client: 'mysql2', connection: { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } });
    const name = `rterm_part_${Date.now()}`;
    await admin.raw(`CREATE DATABASE \`${name}\``);
    const partUrl = `${u.protocol}//${u.username}${u.password ? ':' + u.password : ''}@${u.host}/${name}`;
    const db = createKnex(partUrl);
    try {
      await db.migrate.latest();
      let parts = await listSessionPartitions(db);
      expect(parts.map((p) => p.name)).toEqual(['p202611', 'p202612', 'pmax']);
      expect(parts.map((p) => p.bound)).toEqual(['2026-12-01', '2027-01-01', null]);

      // 先在 pmax 里放一行（2027-02 的数据），补建分区时它必须被正确重新分配
      await db.raw("INSERT INTO sessions (session_uid, controller_device_id, host_device_id, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 1, 2, '2027-02-10 10:00:00.000')");
      const first = await maintainSessionPartitions(db, new Date('2026-11-11T00:00:00Z'));
      expect(first.length).toBe(1);
      parts = await listSessionPartitions(db);
      expect(parts.map((p) => p.name)).toEqual(['p202611', 'p202612', 'p202701', 'pmax']);
      // 再跑一次没有变化（幂等）
      expect(await maintainSessionPartitions(db, new Date('2026-11-11T00:00:00Z'))).toEqual([]);

      // 到了 2027-05：补到 2027-07；Nov 2026 的分区还在保留期内（保留 6 个完整月 + 当月）
      const later = await maintainSessionPartitions(db, new Date('2027-05-20T00:00:00Z'));
      expect(later.some((q) => q.includes('REORGANIZE'))).toBe(true);
      expect(later.some((q) => q.includes('DROP'))).toBe(false);
      parts = await listSessionPartitions(db);
      expect(parts.map((p) => p.name)).toEqual(['p202611', 'p202612', 'p202701', 'p202702', 'p202703', 'p202704', 'p202705', 'p202706', 'p202707', 'pmax']);
      // pmax 里原有的 2027-02 数据被正确重新分配到 p202702
      const [cnt] = await db.raw('SELECT COUNT(*) AS n FROM sessions PARTITION (p202702)');
      expect((cnt as Array<{ n: number }>)[0]!.n).toBe(1);

      // 到了 2027-06：p202611 超过保留期被删除，p202612 还在
      const drop = await maintainSessionPartitions(db, new Date('2027-06-20T00:00:00Z'));
      expect(drop).toContain('ALTER TABLE sessions DROP PARTITION p202611');
      parts = await listSessionPartitions(db);
      expect(parts.map((p) => p.name)).not.toContain('p202611');
      expect(parts.map((p) => p.name)).toContain('p202612');
      expect(parts.map((p) => p.name)).toContain('p202708');
    } finally {
      await db.destroy();
      await admin.raw(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.destroy();
    }
  }, 60_000);
});

d('MySQL：数据库短暂不可用时的行为（经 TCP 代理断开/冻结连接）', () => {
  let proxy: TcpProxy;
  let proxied: string;
  beforeAll(async () => {
    const u = new globalThis.URL(URL_);
    proxy = new TcpProxy(u.hostname, Number(u.port || 3306));
    await proxy.start();
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    proxied = u.toString();
    const db = createKnex(URL_);
    await db.migrate.latest();
    await db.destroy();
  });
  afterAll(async () => {
    await proxy.restore().catch(() => {});
    await proxy.stop();
  });

  const bundle = () => createRepos({ ...testConfig(), store: 'mysql', mysqlUrl: proxied }, silentLogger());

  async function connectOnce(s: Awaited<ReturnType<typeof startStack>>, host: Awaited<ReturnType<typeof onlineDevice>>, ctl: Awaited<ReturnType<typeof onlineDevice>>) {
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    const goP = host.sig.acceptGo(inc.session_id);
    const res = await resP;
    if (!res.ok) throw new Error(res.code);
    void s;
    return { inc, res: res.data, go: await goP };
  }

  it('断开期间：已认证设备仍可建立会话（会话写入进补写队列），恢复后补写成功且状态正确；已有的中继会话不受影响', async () => {
    const b = bundle();
    const s = await startStack({ repos: b.repos });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      const first = await connectOnce(s, host, ctl);
      const [h1, c1] = await Promise.all([RelayConn.connect(first.go.relay_url, first.go.ticket), RelayConn.connect(first.res.relay_url, first.res.ticket)]);
      await until(async () => (await b.repos.sessions.get(first.inc.session_id))?.status === SessionStatus.Paired, 5000, '第一个会话配对');

      await proxy.cut();
      // 已建立的会话继续转发；信令连接心跳正常
      await c1.send(Buffer.from('during outage'));
      await h1.waitCount(1);
      expect(await ctl.sig.request('ping', {})).toMatchObject({ t: 'pong' });
      // 新建会话：设备已缓存，建会话的写库进队列，请求仍成功
      const second = await connectOnce(s, host, ctl);
      expect(b.writeQueue!.size).toBeGreaterThan(0);
      // 在断开期间结束第一个会话（字节数写库也进队列）
      c1.close();
      await h1.closed;
      await sleep(500);

      await proxy.restore();
      await until(async () => b.writeQueue!.size === 0, 30_000, '补写队列清空');
      expect(b.writeQueue!.dropped).toBe(0);
      expect(await b.repos.sessions.get(second.inc.session_id)).toMatchObject({ status: SessionStatus.Accepted });
      // 第一个会话没有认证过，结束事件把它记为失败，但字节数要落库
      await until(async () => (await b.repos.sessions.get(first.inc.session_id))?.status === SessionStatus.Failed, 10_000, '第一个会话结束');
      expect(await b.repos.sessions.get(first.inc.session_id)).toMatchObject({ bytesC2h: 13 });
    } finally {
      await proxy.restore();
      await s.stop();
      await b.repos.close();
      await b.knex?.destroy().catch(() => {});
    }
  }, 90_000);

  it('冻结（连接在但无响应）：建会话不应无限挂起，请求在几秒内有结果，恢复后补写', async () => {
    const b = bundle();
    const s = await startStack({ repos: b.repos });
    try {
      const host = await onlineDevice(s);
      const ctl = await onlineDevice(s);
      await b.repos.devices.findByUid(host.identity.deviceId); // 预热连接池
      proxy.freeze();
      const t0 = Date.now();
      const incP = host.sig.waitIncoming(20_000);
      void incP.then((i) => host.sig.accept(i.session_id), () => {});
      const resP = ctl.sig.connectRequest(host.identity.deviceCode);
      const winner = await Promise.race([resP.then((r) => (r.ok ? 'ok' : r.code)), sleep(20_000).then(() => 'hung')]);
      expect(winner).toBe('ok');
      expect(Date.now() - t0).toBeLessThan(20_000); // 写库超时后进队列，请求继续
      const inc = await incP;
      await proxy.restore();
      await until(async () => b.writeQueue!.size === 0, 30_000, '补写队列清空');
      expect(await b.repos.sessions.get(inc.session_id)).toMatchObject({ status: SessionStatus.Accepted });
    } finally {
      await proxy.restore();
      await s.stop();
      await b.repos.close();
      await b.knex?.destroy().catch(() => {});
    }
  }, 90_000);
});
