import type { Knex } from 'knex';
import { ipInCidr } from '../../util/ip.js';
import {
  DuplicateError,
  type AuditRecord,
  type AuditRepo,
  type BanRecord,
  type BansRepo,
  type ConfigEntry,
  type ConfigRepo,
  type DailyStat,
  type DeviceRecord,
  type DevicesRepo,
  type NewBan,
  type NewDevice,
  type NewRelease,
  type NewSecurityEvent,
  type NewSession,
  type RelayNodeRecord,
  type RelayNodesRepo,
  type ReleaseRecord,
  type ReleasesRepo,
  type Repos,
  type SecurityEventRecord,
  type SecurityEventsRepo,
  type SessionPatch,
  type SessionRecord,
  type SessionsRepo,
  type StatsRepo,
  type DeviceTraffic,
  type TrafficDelta,
  type TrafficRepo,
} from './types.js';

/*
 * MySQL(knex) 实现。所有查询都走参数化，不拼接用户输入。
 * 说明：本机没有 MySQL，这一层只在有 MySQL 的环境里才能实测，见最终报告。
 */

type Row = Record<string, any>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date | null => (v ? (v instanceof Date ? v : new Date(String(v))) : null);
const buf = (v: unknown): Buffer | null => (v ? Buffer.from(v as Buffer) : null);

function isDup(e: unknown): boolean {
  const err = e as { code?: string; errno?: number };
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

function dupField(e: unknown): DuplicateError['field'] {
  const msg = String((e as Error)?.message ?? '');
  if (msg.includes('uk_public_key')) return 'public_key';
  if (msg.includes('uk_device_code')) return 'device_code';
  return 'other';
}

const toDevice = (r: Row): DeviceRecord => ({
  id: num(r.id),
  uid: r.device_uid,
  code: r.device_code,
  publicKey: Buffer.from(r.public_key),
  kind: r.kind,
  platform: r.platform,
  arch: r.arch,
  osVersion: r.os_version,
  appVersion: r.app_version,
  status: num(r.status),
  registerIp: buf(r.register_ip),
  lastIp: buf(r.last_ip),
  lastSeenAt: date(r.last_seen_at),
  createdAt: date(r.created_at)!,
});

export class KnexDevicesRepo implements DevicesRepo {
  constructor(private db: Knex) {}

  async create(d: NewDevice): Promise<DeviceRecord> {
    try {
      await this.db('devices').insert({
        device_uid: d.uid,
        device_code: d.code,
        public_key: d.publicKey,
        kind: d.kind,
        platform: d.platform,
        arch: d.arch,
        os_version: d.osVersion,
        app_version: d.appVersion,
        register_ip: d.registerIp,
        last_ip: d.registerIp,
      });
    } catch (e) {
      if (isDup(e)) throw new DuplicateError(dupField(e));
      throw e;
    }
    const rec = await this.findByUid(d.uid);
    if (!rec) throw new Error('插入设备后查询不到记录');
    return rec;
  }

  private async one(where: Row): Promise<DeviceRecord | null> {
    const r = await this.db('devices').where(where).first();
    return r ? toDevice(r) : null;
  }

  findById(id: number): Promise<DeviceRecord | null> {
    return this.one({ id });
  }
  findByUid(uid: string): Promise<DeviceRecord | null> {
    return this.one({ device_uid: uid });
  }
  findByCode(code: string): Promise<DeviceRecord | null> {
    return this.one({ device_code: code });
  }
  findByPublicKey(pk: Buffer): Promise<DeviceRecord | null> {
    return this.one({ public_key: pk });
  }

  async updateInfo(id: number, v: { platform: string; osVersion: string; appVersion: string }): Promise<void> {
    await this.db('devices').where({ id }).update({ platform: v.platform, os_version: v.osVersion, app_version: v.appVersion });
  }

  async touchSeen(id: number, ip: Buffer | null, at: Date, appVersion?: string): Promise<void> {
    const patch: Row = { last_seen_at: at };
    if (ip) patch.last_ip = ip;
    if (appVersion) patch.app_version = appVersion;
    await this.db('devices').where({ id }).update(patch);
  }

  async setStatus(id: number, status: number): Promise<void> {
    await this.db('devices').where({ id }).update({ status });
  }

  async search(q: { text?: string; status?: number; limit: number; offset: number }): Promise<{ items: DeviceRecord[]; total: number }> {
    const base = (): Knex.QueryBuilder => {
      const b = this.db('devices');
      if (q.status !== undefined) b.where({ status: q.status });
      if (q.text) b.where((w) => w.where({ device_code: q.text }).orWhere({ device_uid: q.text }));
      return b;
    };
    const rows = await base().orderBy('id', 'desc').limit(q.limit).offset(q.offset);
    const cnt = await base().count({ n: '*' }).first();
    return { items: rows.map(toDevice), total: num(cnt?.n) };
  }

  async countCreatedSince(since: Date): Promise<number> {
    const r = await this.db('devices').where('created_at', '>=', since).count({ n: '*' }).first();
    return num(r?.n);
  }

  async countSeenSince(since: Date): Promise<number> {
    const r = await this.db('devices').where('last_seen_at', '>=', since).count({ n: '*' }).first();
    return num(r?.n);
  }
}

const toSession = (r: Row): SessionRecord => ({
  uid: r.session_uid,
  controllerDeviceId: num(r.controller_device_id),
  hostDeviceId: num(r.host_device_id),
  relayNode: r.relay_node,
  status: num(r.status),
  failReason: r.fail_reason,
  controllerIp: buf(r.controller_ip),
  hostIp: buf(r.host_ip),
  bytesC2h: num(r.bytes_c2h),
  bytesH2c: num(r.bytes_h2c),
  createdAt: date(r.created_at)!,
  authedAt: date(r.authed_at),
  endedAt: date(r.ended_at),
});

export class KnexSessionsRepo implements SessionsRepo {
  constructor(private db: Knex) {}

  async create(s: NewSession): Promise<void> {
    await this.db('sessions').insert({
      session_uid: s.uid,
      controller_device_id: s.controllerDeviceId,
      host_device_id: s.hostDeviceId,
      relay_node: s.relayNode,
      controller_ip: s.controllerIp,
      host_ip: s.hostIp,
    });
  }

  async get(uid: string): Promise<SessionRecord | null> {
    const r = await this.db('sessions').where({ session_uid: uid }).first();
    return r ? toSession(r) : null;
  }

  async transition(uid: string, p: SessionPatch, allowedFrom: number[]): Promise<boolean> {
    const patch: Row = { status: p.status };
    if (p.failReason !== undefined) patch.fail_reason = p.failReason.slice(0, 32);
    if (p.relayNode !== undefined) patch.relay_node = p.relayNode.slice(0, 64);
    if (p.authedAt) patch.authed_at = p.authedAt;
    if (p.endedAt) patch.ended_at = p.endedAt;
    if (p.bytesC2h !== undefined) patch.bytes_c2h = Math.max(0, Math.floor(p.bytesC2h));
    if (p.bytesH2c !== undefined) patch.bytes_h2c = Math.max(0, Math.floor(p.bytesH2c));
    const n = await this.db('sessions').where({ session_uid: uid }).whereIn('status', allowedFrom).update(patch);
    return n > 0;
  }

  async list(q: { deviceId?: number; status?: number; since?: Date; limit: number; offset: number }): Promise<SessionRecord[]> {
    const b = this.db('sessions');
    if (q.deviceId !== undefined) b.where((w) => w.where({ controller_device_id: q.deviceId }).orWhere({ host_device_id: q.deviceId }));
    if (q.status !== undefined) b.where({ status: q.status });
    if (q.since) b.where('created_at', '>=', q.since);
    const rows = await b.orderBy('created_at', 'desc').limit(q.limit).offset(q.offset);
    return rows.map(toSession);
  }

  async countSince(since: Date): Promise<{ total: number; authed: number }> {
    const r = await this.db('sessions')
      .where('created_at', '>=', since)
      .select(this.db.raw('COUNT(*) AS total'), this.db.raw('SUM(authed_at IS NOT NULL) AS authed'))
      .first();
    return { total: num(r?.total), authed: num(r?.authed) };
  }
}

const toEvent = (r: Row): SecurityEventRecord => ({
  id: num(r.id),
  type: r.type,
  targetDeviceId: r.target_device_id === null ? null : num(r.target_device_id),
  sourceDeviceId: r.source_device_id === null ? null : num(r.source_device_id),
  sourceIp: buf(r.source_ip),
  sessionUid: r.session_uid,
  detail: typeof r.detail === 'string' ? safeJson(r.detail) : r.detail,
  createdAt: date(r.created_at)!,
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export class KnexSecurityEventsRepo implements SecurityEventsRepo {
  constructor(private db: Knex) {}

  async add(e: NewSecurityEvent): Promise<void> {
    await this.db('security_events').insert({
      type: e.type,
      target_device_id: e.targetDeviceId ?? null,
      source_device_id: e.sourceDeviceId ?? null,
      source_ip: e.sourceIp ?? null,
      session_uid: e.sessionUid ?? null,
      detail: e.detail === undefined || e.detail === null ? null : JSON.stringify(e.detail),
    });
  }

  async list(q: { type?: string; deviceId?: number; limit: number; offset: number }): Promise<SecurityEventRecord[]> {
    const b = this.db('security_events');
    if (q.type) b.where({ type: q.type });
    if (q.deviceId !== undefined) b.where((w) => w.where({ target_device_id: q.deviceId }).orWhere({ source_device_id: q.deviceId }));
    const rows = await b.orderBy('id', 'desc').limit(q.limit).offset(q.offset);
    return rows.map(toEvent);
  }

  async deleteOlderThan(d: Date): Promise<number> {
    return this.db('security_events').where('created_at', '<', d).delete();
  }
}

const toBan = (r: Row): BanRecord => ({
  id: num(r.id),
  kind: r.kind,
  value: r.value,
  reason: r.reason,
  source: r.source,
  expiresAt: date(r.expires_at),
  createdBy: r.created_by,
  createdAt: date(r.created_at)!,
});

export class KnexBansRepo implements BansRepo {
  constructor(private db: Knex) {}

  async add(b: NewBan): Promise<BanRecord> {
    await this.db('bans')
      .insert({
        kind: b.kind,
        value: b.value,
        reason: b.reason.slice(0, 255),
        source: b.source,
        expires_at: b.expiresAt,
        created_by: b.createdBy.slice(0, 64),
      })
      .onConflict()
      .merge(['reason', 'source', 'expires_at', 'created_by']);
    const r = await this.db('bans').where({ kind: b.kind, value: b.value }).first();
    return toBan(r!);
  }

  async remove(id: number): Promise<boolean> {
    return (await this.db('bans').where({ id }).delete()) > 0;
  }

  removeByValue(kind: BanRecord['kind'], value: string): Promise<number> {
    return this.db('bans').where({ kind, value }).delete();
  }

  async list(opts: { includeExpired?: boolean }): Promise<BanRecord[]> {
    const b = this.db('bans');
    if (!opts.includeExpired) b.where((w) => w.whereNull('expires_at').orWhere('expires_at', '>', new Date()));
    return (await b.orderBy('id', 'desc')).map(toBan);
  }

  async findActive(q: { deviceUid?: string; ip?: string }): Promise<BanRecord | null> {
    const now = new Date();
    const alive = (w: Knex.QueryBuilder): Knex.QueryBuilder => w.whereNull('expires_at').orWhere('expires_at', '>', now);
    if (q.deviceUid) {
      const r = await this.db('bans').where({ kind: 'device', value: q.deviceUid }).where(alive).first();
      if (r) return toBan(r);
    }
    if (q.ip) {
      const r = await this.db('bans').where({ kind: 'ip', value: q.ip }).where(alive).first();
      if (r) return toBan(r);
      // CIDR 封禁条数很少，取出来在内存里匹配
      const cidrs = await this.db('bans').where({ kind: 'cidr' }).where(alive);
      const hit = cidrs.find((c: Row) => ipInCidr(q.ip!, c.value));
      if (hit) return toBan(hit);
    }
    return null;
  }

  deleteExpired(): Promise<number> {
    return this.db('bans').whereNotNull('expires_at').where('expires_at', '<=', new Date()).delete();
  }
}

const toRelease = (r: Row): ReleaseRecord => ({
  id: num(r.id),
  version: r.version,
  kind: r.kind,
  platform: r.platform,
  arch: r.arch,
  channel: r.channel,
  downloadUrl: r.download_url,
  signature: r.signature,
  notes: r.notes,
  rolloutPercent: num(r.rollout_percent),
  status: num(r.status),
  publishedAt: date(r.published_at)!,
});

export class KnexReleasesRepo implements ReleasesRepo {
  constructor(private db: Knex) {}

  async insert(r: NewRelease): Promise<ReleaseRecord> {
    let id: number;
    try {
      const res = await this.db('app_releases').insert({
        version: r.version,
        kind: r.kind,
        platform: r.platform,
        arch: r.arch,
        channel: r.channel,
        download_url: r.downloadUrl,
        signature: r.signature,
        notes: r.notes,
        rollout_percent: r.rolloutPercent,
        status: r.status,
        ...(r.publishedAt ? { published_at: r.publishedAt } : {}),
      });
      id = num(res[0]);
    } catch (e) {
      if (isDup(e)) throw new DuplicateError('other');
      throw e;
    }
    return (await this.findById(id))!;
  }

  async findById(id: number): Promise<ReleaseRecord | null> {
    const r = await this.db('app_releases').where({ id }).first();
    return r ? toRelease(r) : null;
  }

  async update(id: number, v: { rolloutPercent?: number; status?: number; notes?: string | null }): Promise<boolean> {
    const patch: Row = {};
    if (v.rolloutPercent !== undefined) patch.rollout_percent = v.rolloutPercent;
    if (v.status !== undefined) patch.status = v.status;
    if (v.notes !== undefined) patch.notes = v.notes;
    if (Object.keys(patch).length === 0) return (await this.findById(id)) !== null;
    // 影响行数为 0 可能只是值没变，所以先确认记录存在
    if (!(await this.findById(id))) return false;
    await this.db('app_releases').where({ id }).update(patch);
    return true;
  }

  async list(q: { kind?: string; platform?: string; arch?: string; channel?: string; limit: number }): Promise<ReleaseRecord[]> {
    const b = this.db('app_releases');
    for (const k of ['kind', 'platform', 'arch', 'channel'] as const) if (q[k]) b.where({ [k]: q[k] });
    return (await b.orderBy('published_at', 'desc').orderBy('id', 'desc').limit(q.limit)).map(toRelease);
  }

  async findActive(q: { kind: string; platform: string; arch: string; channel: string }): Promise<ReleaseRecord[]> {
    return (await this.db('app_releases').where({ ...q, status: 1 })).map(toRelease);
  }
}

export class KnexConfigRepo implements ConfigRepo {
  constructor(private db: Knex) {}

  async getAll(): Promise<ConfigEntry[]> {
    const rows = await this.db('app_config');
    return rows.map((r: Row) => ({
      key: r.cfg_key,
      value: typeof r.cfg_value === 'string' ? safeJson(r.cfg_value) : r.cfg_value,
      remark: r.remark,
      updatedBy: r.updated_by,
      updatedAt: date(r.updated_at)!,
    }));
  }

  async set(key: string, value: unknown, remark: string, by: string): Promise<void> {
    await this.db('app_config')
      .insert({ cfg_key: key, cfg_value: JSON.stringify(value), remark: remark.slice(0, 255), updated_by: by.slice(0, 64) })
      .onConflict()
      .merge(['cfg_value', 'remark', 'updated_by']);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.db('app_config').where({ cfg_key: key }).delete()) > 0;
  }
}

const toNode = (r: Row): RelayNodeRecord => ({
  id: num(r.id),
  name: r.name,
  region: r.region,
  publicUrl: r.public_url,
  status: num(r.status),
  capacity: num(r.capacity),
});

export class KnexRelayNodesRepo implements RelayNodesRepo {
  constructor(private db: Knex) {}

  async list(): Promise<RelayNodeRecord[]> {
    return (await this.db('relay_nodes').orderBy('id')).map(toNode);
  }

  async upsert(n: Omit<RelayNodeRecord, 'id'>): Promise<RelayNodeRecord> {
    await this.db('relay_nodes')
      .insert({ name: n.name, region: n.region, public_url: n.publicUrl, status: n.status, capacity: n.capacity })
      .onConflict()
      .merge(['region', 'public_url', 'status', 'capacity']);
    return toNode((await this.db('relay_nodes').where({ name: n.name }).first())!);
  }

  async remove(name: string): Promise<boolean> {
    return (await this.db('relay_nodes').where({ name }).delete()) > 0;
  }
}

export class KnexAuditRepo implements AuditRepo {
  constructor(private db: Knex) {}

  async add(a: { adminId: number; action: string; target: string; detail?: unknown; ip?: Buffer | null }): Promise<void> {
    await this.db('admin_audit_logs').insert({
      admin_id: a.adminId,
      action: a.action.slice(0, 64),
      target: a.target.slice(0, 128),
      detail: a.detail === undefined ? null : JSON.stringify(a.detail),
      ip: a.ip ?? null,
    });
  }

  async list(q: { limit: number; offset: number }): Promise<AuditRecord[]> {
    const rows = await this.db('admin_audit_logs').orderBy('id', 'desc').limit(q.limit).offset(q.offset);
    return rows.map((r: Row) => ({
      id: num(r.id),
      adminId: num(r.admin_id),
      action: r.action,
      target: r.target,
      detail: typeof r.detail === 'string' ? safeJson(r.detail) : r.detail,
      ip: buf(r.ip),
      createdAt: date(r.created_at)!,
    }));
  }

  deleteOlderThan(d: Date): Promise<number> {
    return this.db('admin_audit_logs').where('created_at', '<', d).delete();
  }
}

export class KnexStatsRepo implements StatsRepo {
  constructor(private db: Knex) {}

  async apply(
    dateStr: string,
    add: Partial<Omit<DailyStat, 'statDate' | 'peakOnline' | 'peakSessions' | 'activeDevices'>>,
    max: { peakOnline?: number; peakSessions?: number; activeDevices?: number },
  ): Promise<void> {
    const v = {
      nd: Math.floor(add.newDevices ?? 0),
      st: Math.floor(add.sessionsTotal ?? 0),
      sa: Math.floor(add.sessionsAuthed ?? 0),
      af: Math.floor(add.authFailures ?? 0),
      br: Math.floor(add.bytesRelayed ?? 0),
      po: Math.floor(max.peakOnline ?? 0),
      ps: Math.floor(max.peakSessions ?? 0),
      ad: Math.floor(max.activeDevices ?? 0),
    };
    await this.db.raw(
      `INSERT INTO daily_stats (stat_date, new_devices, active_devices, sessions_total, sessions_authed, auth_failures, bytes_relayed, peak_online, peak_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         new_devices = new_devices + VALUES(new_devices),
         active_devices = GREATEST(active_devices, VALUES(active_devices)),
         sessions_total = sessions_total + VALUES(sessions_total),
         sessions_authed = sessions_authed + VALUES(sessions_authed),
         auth_failures = auth_failures + VALUES(auth_failures),
         bytes_relayed = bytes_relayed + VALUES(bytes_relayed),
         peak_online = GREATEST(peak_online, VALUES(peak_online)),
         peak_sessions = GREATEST(peak_sessions, VALUES(peak_sessions))`,
      [dateStr, v.nd, v.ad, v.st, v.sa, v.af, v.br, v.po, v.ps],
    );
  }

  async range(from: string, to: string): Promise<DailyStat[]> {
    const rows = await this.db('daily_stats').whereBetween('stat_date', [from, to]).orderBy('stat_date');
    return rows.map((r: Row) => ({
      statDate: r.stat_date instanceof Date ? r.stat_date.toISOString().slice(0, 10) : String(r.stat_date).slice(0, 10),
      newDevices: num(r.new_devices),
      activeDevices: num(r.active_devices),
      sessionsTotal: num(r.sessions_total),
      sessionsAuthed: num(r.sessions_authed),
      authFailures: num(r.auth_failures),
      bytesRelayed: num(r.bytes_relayed),
      peakOnline: num(r.peak_online),
      peakSessions: num(r.peak_sessions),
    }));
  }
}

export class KnexTrafficRepo implements TrafficRepo {
  constructor(private db: Knex) {}

  async add(dateStr: string, rows: TrafficDelta[]): Promise<void> {
    if (rows.length === 0) return;
    const f = (n: number): number => Math.max(0, Math.floor(n));
    const values = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = rows.flatMap((r) => [r.deviceId, dateStr, f(r.bytesIn), f(r.bytesOut), f(r.framesIn), f(r.framesOut)]);
    await this.db.raw(
      `INSERT INTO device_traffic (device_id, stat_date, bytes_in, bytes_out, frames_in, frames_out)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         bytes_in = bytes_in + VALUES(bytes_in),
         bytes_out = bytes_out + VALUES(bytes_out),
         frames_in = frames_in + VALUES(frames_in),
         frames_out = frames_out + VALUES(frames_out)`,
      params,
    );
  }

  async range(q: { from: string; to: string; deviceId?: number; limit: number }): Promise<DeviceTraffic[]> {
    const qb = this.db('device_traffic').whereBetween('stat_date', [q.from, q.to]);
    if (q.deviceId !== undefined) qb.andWhere('device_id', q.deviceId);
    const rows = await qb.orderBy('stat_date', 'desc').orderBy('device_id').limit(q.limit);
    return rows.map((r: Row) => ({
      deviceId: num(r.device_id),
      statDate: r.stat_date instanceof Date ? r.stat_date.toISOString().slice(0, 10) : String(r.stat_date).slice(0, 10),
      bytesIn: num(r.bytes_in),
      bytesOut: num(r.bytes_out),
      framesIn: num(r.frames_in),
      framesOut: num(r.frames_out),
    }));
  }
}

export function createKnexRepos(db: Knex): Repos {
  return {
    devices: new KnexDevicesRepo(db),
    sessions: new KnexSessionsRepo(db),
    events: new KnexSecurityEventsRepo(db),
    bans: new KnexBansRepo(db),
    releases: new KnexReleasesRepo(db),
    appConfig: new KnexConfigRepo(db),
    relayNodes: new KnexRelayNodesRepo(db),
    audit: new KnexAuditRepo(db),
    stats: new KnexStatsRepo(db),
    traffic: new KnexTrafficRepo(db),
    async close() {
      await db.destroy();
    },
  };
}
