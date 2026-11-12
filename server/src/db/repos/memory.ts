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

export class MemoryDevicesRepo implements DevicesRepo {
  private rows: DeviceRecord[] = [];
  private seq = 0;

  async create(d: NewDevice): Promise<DeviceRecord> {
    if (this.rows.some((r) => r.publicKey.equals(d.publicKey))) throw new DuplicateError('public_key');
    if (this.rows.some((r) => r.code === d.code)) throw new DuplicateError('device_code');
    if (this.rows.some((r) => r.uid === d.uid)) throw new DuplicateError('other');
    const rec: DeviceRecord = {
      id: ++this.seq,
      uid: d.uid,
      code: d.code,
      publicKey: Buffer.from(d.publicKey),
      kind: d.kind,
      platform: d.platform,
      arch: d.arch,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      status: 0,
      registerIp: d.registerIp,
      lastIp: d.registerIp,
      lastSeenAt: null,
      createdAt: new Date(),
    };
    this.rows.push(rec);
    return { ...rec };
  }

  private clone(r: DeviceRecord | undefined): DeviceRecord | null {
    return r ? { ...r } : null;
  }

  async findById(id: number): Promise<DeviceRecord | null> {
    return this.clone(this.rows.find((r) => r.id === id));
  }
  async findByUid(uid: string): Promise<DeviceRecord | null> {
    return this.clone(this.rows.find((r) => r.uid === uid));
  }
  async findByCode(code: string): Promise<DeviceRecord | null> {
    return this.clone(this.rows.find((r) => r.code === code));
  }
  async findByPublicKey(pk: Buffer): Promise<DeviceRecord | null> {
    return this.clone(this.rows.find((r) => r.publicKey.equals(pk)));
  }

  async updateInfo(id: number, v: { platform: string; osVersion: string; appVersion: string }): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, v);
  }

  async touchSeen(id: number, ip: Buffer | null, at: Date, appVersion?: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    r.lastSeenAt = at;
    if (ip) r.lastIp = ip;
    if (appVersion) r.appVersion = appVersion;
  }

  async setStatus(id: number, status: number): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = status;
  }

  async search(q: { text?: string; status?: number; limit: number; offset: number }): Promise<{ items: DeviceRecord[]; total: number }> {
    let rows = this.rows;
    if (q.status !== undefined) rows = rows.filter((r) => r.status === q.status);
    if (q.text) rows = rows.filter((r) => r.code === q.text || r.uid === q.text);
    const sorted = [...rows].sort((a, b) => b.id - a.id);
    return { items: sorted.slice(q.offset, q.offset + q.limit).map((r) => ({ ...r })), total: rows.length };
  }

  async countCreatedSince(since: Date): Promise<number> {
    return this.rows.filter((r) => r.createdAt >= since).length;
  }

  async countSeenSince(since: Date): Promise<number> {
    return this.rows.filter((r) => r.lastSeenAt && r.lastSeenAt >= since).length;
  }
}

export class MemorySessionsRepo implements SessionsRepo {
  private rows = new Map<string, SessionRecord>();

  async create(s: NewSession): Promise<void> {
    this.rows.set(s.uid, {
      uid: s.uid,
      controllerDeviceId: s.controllerDeviceId,
      hostDeviceId: s.hostDeviceId,
      relayNode: s.relayNode,
      status: 0,
      failReason: '',
      controllerIp: s.controllerIp,
      hostIp: s.hostIp,
      bytesC2h: 0,
      bytesH2c: 0,
      createdAt: new Date(),
      authedAt: null,
      endedAt: null,
    });
  }

  async get(uid: string): Promise<SessionRecord | null> {
    const r = this.rows.get(uid);
    return r ? { ...r } : null;
  }

  async transition(uid: string, p: SessionPatch, allowedFrom: number[]): Promise<boolean> {
    const r = this.rows.get(uid);
    if (!r || !allowedFrom.includes(r.status)) return false;
    r.status = p.status;
    if (p.failReason !== undefined) r.failReason = p.failReason;
    if (p.relayNode !== undefined) r.relayNode = p.relayNode;
    if (p.authedAt) r.authedAt = p.authedAt;
    if (p.endedAt) r.endedAt = p.endedAt;
    if (p.bytesC2h !== undefined) r.bytesC2h = p.bytesC2h;
    if (p.bytesH2c !== undefined) r.bytesH2c = p.bytesH2c;
    return true;
  }

  async list(q: { deviceId?: number; status?: number; since?: Date; limit: number; offset: number }): Promise<SessionRecord[]> {
    let rows = [...this.rows.values()];
    if (q.deviceId !== undefined) rows = rows.filter((r) => r.controllerDeviceId === q.deviceId || r.hostDeviceId === q.deviceId);
    if (q.status !== undefined) rows = rows.filter((r) => r.status === q.status);
    if (q.since) rows = rows.filter((r) => r.createdAt >= q.since!);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.slice(q.offset, q.offset + q.limit).map((r) => ({ ...r }));
  }

  async countSince(since: Date): Promise<{ total: number; authed: number }> {
    let total = 0;
    let authed = 0;
    for (const r of this.rows.values()) {
      if (r.createdAt < since) continue;
      total++;
      if (r.authedAt) authed++;
    }
    return { total, authed };
  }
}

export class MemorySecurityEventsRepo implements SecurityEventsRepo {
  private rows: SecurityEventRecord[] = [];
  private seq = 0;

  async add(e: NewSecurityEvent): Promise<void> {
    this.rows.push({
      id: ++this.seq,
      type: e.type,
      targetDeviceId: e.targetDeviceId ?? null,
      sourceDeviceId: e.sourceDeviceId ?? null,
      sourceIp: e.sourceIp ?? null,
      sessionUid: e.sessionUid ?? null,
      detail: e.detail ?? null,
      createdAt: new Date(),
    });
    // 内存模式下限制条数，避免无限增长
    if (this.rows.length > 20_000) this.rows.splice(0, this.rows.length - 20_000);
  }

  async list(q: { type?: string; deviceId?: number; limit: number; offset: number }): Promise<SecurityEventRecord[]> {
    let rows = this.rows;
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.deviceId !== undefined) rows = rows.filter((r) => r.targetDeviceId === q.deviceId || r.sourceDeviceId === q.deviceId);
    return [...rows].reverse().slice(q.offset, q.offset + q.limit);
  }

  async deleteOlderThan(d: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.createdAt >= d);
    return before - this.rows.length;
  }
}

export class MemoryBansRepo implements BansRepo {
  private rows: BanRecord[] = [];
  private seq = 0;

  async add(b: NewBan): Promise<BanRecord> {
    const i = this.rows.findIndex((r) => r.kind === b.kind && r.value === b.value);
    const rec: BanRecord = { id: i >= 0 ? this.rows[i]!.id : ++this.seq, ...b, createdAt: new Date() };
    if (i >= 0) this.rows[i] = rec;
    else this.rows.push(rec);
    return { ...rec };
  }

  async remove(id: number): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }

  async removeByValue(kind: BanRecord['kind'], value: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.kind === kind && r.value === value));
    return before - this.rows.length;
  }

  async list(opts: { includeExpired?: boolean }): Promise<BanRecord[]> {
    const now = Date.now();
    return this.rows.filter((r) => opts.includeExpired || !r.expiresAt || r.expiresAt.getTime() > now).map((r) => ({ ...r }));
  }

  async findActive(q: { deviceUid?: string; ip?: string }): Promise<BanRecord | null> {
    const now = Date.now();
    for (const r of this.rows) {
      if (r.expiresAt && r.expiresAt.getTime() <= now) continue;
      if (r.kind === 'device' && q.deviceUid && r.value === q.deviceUid) return { ...r };
      if (r.kind === 'ip' && q.ip && r.value === q.ip) return { ...r };
      if (r.kind === 'cidr' && q.ip && ipInCidr(q.ip, r.value)) return { ...r };
    }
    return null;
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !r.expiresAt || r.expiresAt.getTime() > now);
    return before - this.rows.length;
  }
}

export class MemoryReleasesRepo implements ReleasesRepo {
  private rows: ReleaseRecord[] = [];
  private seq = 0;

  async insert(r: NewRelease): Promise<ReleaseRecord> {
    const dup = this.rows.find(
      (x) => x.version === r.version && x.kind === r.kind && x.platform === r.platform && x.arch === r.arch && x.channel === r.channel,
    );
    if (dup) throw new DuplicateError('other');
    const rec: ReleaseRecord = { ...r, id: ++this.seq, publishedAt: r.publishedAt ?? new Date() };
    this.rows.push(rec);
    return { ...rec };
  }

  async findById(id: number): Promise<ReleaseRecord | null> {
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  async update(id: number, v: { rolloutPercent?: number; status?: number; notes?: string | null }): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return false;
    if (v.rolloutPercent !== undefined) r.rolloutPercent = v.rolloutPercent;
    if (v.status !== undefined) r.status = v.status;
    if (v.notes !== undefined) r.notes = v.notes;
    return true;
  }

  async list(q: { kind?: string; platform?: string; arch?: string; channel?: string; limit: number }): Promise<ReleaseRecord[]> {
    return this.rows
      .filter((r) => (!q.kind || r.kind === q.kind) && (!q.platform || r.platform === q.platform) && (!q.arch || r.arch === q.arch) && (!q.channel || r.channel === q.channel))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || b.id - a.id)
      .slice(0, q.limit)
      .map((r) => ({ ...r }));
  }

  async findActive(q: { kind: string; platform: string; arch: string; channel: string }): Promise<ReleaseRecord[]> {
    return this.rows
      .filter((r) => r.status === 1 && r.kind === q.kind && r.platform === q.platform && r.arch === q.arch && r.channel === q.channel)
      .map((r) => ({ ...r }));
  }
}

export class MemoryConfigRepo implements ConfigRepo {
  private map = new Map<string, ConfigEntry>();

  async getAll(): Promise<ConfigEntry[]> {
    return [...this.map.values()].map((e) => ({ ...e, value: structuredClone(e.value) }));
  }

  async set(key: string, value: unknown, remark: string, by: string): Promise<void> {
    this.map.set(key, { key, value: structuredClone(value), remark, updatedBy: by, updatedAt: new Date() });
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

export class MemoryRelayNodesRepo implements RelayNodesRepo {
  private rows: RelayNodeRecord[] = [];
  private seq = 0;

  async list(): Promise<RelayNodeRecord[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async upsert(n: Omit<RelayNodeRecord, 'id'>): Promise<RelayNodeRecord> {
    const i = this.rows.findIndex((r) => r.name === n.name);
    const rec = { id: i >= 0 ? this.rows[i]!.id : ++this.seq, ...n };
    if (i >= 0) this.rows[i] = rec;
    else this.rows.push(rec);
    return { ...rec };
  }

  async remove(name: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.name !== name);
    return this.rows.length < before;
  }
}

export class MemoryAuditRepo implements AuditRepo {
  private rows: AuditRecord[] = [];
  private seq = 0;

  async add(a: { adminId: number; action: string; target: string; detail?: unknown; ip?: Buffer | null }): Promise<void> {
    this.rows.push({ id: ++this.seq, adminId: a.adminId, action: a.action, target: a.target, detail: a.detail ?? null, ip: a.ip ?? null, createdAt: new Date() });
    if (this.rows.length > 5000) this.rows.splice(0, this.rows.length - 5000);
  }

  async list(q: { limit: number; offset: number }): Promise<AuditRecord[]> {
    return [...this.rows].reverse().slice(q.offset, q.offset + q.limit);
  }

  async deleteOlderThan(d: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.createdAt >= d);
    return before - this.rows.length;
  }
}

export class MemoryStatsRepo implements StatsRepo {
  private map = new Map<string, DailyStat>();

  async apply(
    date: string,
    add: Partial<Omit<DailyStat, 'statDate' | 'peakOnline' | 'peakSessions' | 'activeDevices'>>,
    max: { peakOnline?: number; peakSessions?: number; activeDevices?: number },
  ): Promise<void> {
    const s = this.map.get(date) ?? {
      statDate: date, newDevices: 0, activeDevices: 0, sessionsTotal: 0, sessionsAuthed: 0, authFailures: 0, bytesRelayed: 0, peakOnline: 0, peakSessions: 0,
    };
    s.newDevices += add.newDevices ?? 0;
    s.sessionsTotal += add.sessionsTotal ?? 0;
    s.sessionsAuthed += add.sessionsAuthed ?? 0;
    s.authFailures += add.authFailures ?? 0;
    s.bytesRelayed += add.bytesRelayed ?? 0;
    s.peakOnline = Math.max(s.peakOnline, max.peakOnline ?? 0);
    s.peakSessions = Math.max(s.peakSessions, max.peakSessions ?? 0);
    s.activeDevices = Math.max(s.activeDevices, max.activeDevices ?? 0);
    this.map.set(date, s);
  }

  async range(from: string, to: string): Promise<DailyStat[]> {
    return [...this.map.values()].filter((s) => s.statDate >= from && s.statDate <= to).sort((a, b) => a.statDate.localeCompare(b.statDate));
  }
}

export class MemoryTrafficRepo implements TrafficRepo {
  private map = new Map<string, DeviceTraffic>();

  async add(date: string, rows: TrafficDelta[]): Promise<void> {
    for (const r of rows) {
      const k = `${r.deviceId}|${date}`;
      const t = this.map.get(k) ?? { deviceId: r.deviceId, statDate: date, bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0 };
      t.bytesIn += r.bytesIn;
      t.bytesOut += r.bytesOut;
      t.framesIn += r.framesIn;
      t.framesOut += r.framesOut;
      this.map.set(k, t);
    }
  }

  async range(q: { from: string; to: string; deviceId?: number; limit: number }): Promise<DeviceTraffic[]> {
    return [...this.map.values()]
      .filter((t) => t.statDate >= q.from && t.statDate <= q.to && (q.deviceId === undefined || t.deviceId === q.deviceId))
      .sort((a, b) => b.statDate.localeCompare(a.statDate) || a.deviceId - b.deviceId)
      .slice(0, q.limit)
      .map((t) => ({ ...t }));
  }
}

export function createMemoryRepos(): Repos {
  return {
    devices: new MemoryDevicesRepo(),
    sessions: new MemorySessionsRepo(),
    events: new MemorySecurityEventsRepo(),
    bans: new MemoryBansRepo(),
    releases: new MemoryReleasesRepo(),
    appConfig: new MemoryConfigRepo(),
    relayNodes: new MemoryRelayNodesRepo(),
    audit: new MemoryAuditRepo(),
    stats: new MemoryStatsRepo(),
    traffic: new MemoryTrafficRepo(),
    async close() {},
  };
}
