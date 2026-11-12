/** 数据访问接口。业务代码只依赖这些接口；MySQL(knex) 与内存各有一套实现。 */

/** 唯一索引冲突。field 为冲突的字段 */
export class DuplicateError extends Error {
  constructor(public field: 'public_key' | 'device_code' | 'other') {
    super(`唯一索引冲突：${field}`);
    this.name = 'DuplicateError';
  }
}

// ---------- 设备 ----------
export interface DeviceRecord {
  id: number;
  uid: string;
  code: string;
  publicKey: Buffer;
  kind: string;
  platform: string;
  arch: string;
  osVersion: string;
  appVersion: string;
  /** 0 正常 1 封禁 */
  status: number;
  registerIp: Buffer | null;
  lastIp: Buffer | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface NewDevice {
  uid: string;
  code: string;
  publicKey: Buffer;
  kind: string;
  platform: string;
  arch: string;
  osVersion: string;
  appVersion: string;
  registerIp: Buffer | null;
}

export interface DevicesRepo {
  create(d: NewDevice): Promise<DeviceRecord>;
  findById(id: number): Promise<DeviceRecord | null>;
  findByUid(uid: string): Promise<DeviceRecord | null>;
  findByCode(code: string): Promise<DeviceRecord | null>;
  findByPublicKey(pk: Buffer): Promise<DeviceRecord | null>;
  updateInfo(id: number, v: { platform: string; osVersion: string; appVersion: string }): Promise<void>;
  touchSeen(id: number, ip: Buffer | null, at: Date, appVersion?: string): Promise<void>;
  setStatus(id: number, status: number): Promise<void>;
  search(q: { text?: string; status?: number; limit: number; offset: number }): Promise<{ items: DeviceRecord[]; total: number }>;
  countCreatedSince(since: Date): Promise<number>;
  countSeenSince(since: Date): Promise<number>;
}

// ---------- 会话 ----------
/** 0 待接受 1 已接受 2 已配对 3 已认证 4 正常结束 5 失败 */
export const SessionStatus = {
  Pending: 0,
  Accepted: 1,
  Paired: 2,
  Authed: 3,
  Ended: 4,
  Failed: 5,
} as const;

export interface SessionRecord {
  uid: string;
  controllerDeviceId: number;
  hostDeviceId: number;
  relayNode: string;
  status: number;
  failReason: string;
  controllerIp: Buffer | null;
  hostIp: Buffer | null;
  bytesC2h: number;
  bytesH2c: number;
  createdAt: Date;
  authedAt: Date | null;
  endedAt: Date | null;
}

export interface NewSession {
  uid: string;
  controllerDeviceId: number;
  hostDeviceId: number;
  relayNode: string;
  controllerIp: Buffer | null;
  hostIp: Buffer | null;
}

export interface SessionPatch {
  status: number;
  failReason?: string;
  authedAt?: Date;
  endedAt?: Date;
  bytesC2h?: number;
  bytesH2c?: number;
  /** 被控端同意时重新选中继节点，写回实际使用的节点 */
  relayNode?: string;
}

export interface SessionsRepo {
  create(s: NewSession): Promise<void>;
  get(uid: string): Promise<SessionRecord | null>;
  /** 仅当当前状态在 allowedFrom 里才更新，返回是否更新 */
  transition(uid: string, patch: SessionPatch, allowedFrom: number[]): Promise<boolean>;
  list(q: { deviceId?: number; status?: number; since?: Date; limit: number; offset: number }): Promise<SessionRecord[]>;
  countSince(since: Date): Promise<{ total: number; authed: number }>;
}

// ---------- 安全事件 ----------
export type SecurityEventType = 'auth_failed' | 'host_locked' | 'enum_suspected' | 'rate_limited' | 'key_mismatch';

export interface SecurityEventRecord {
  id: number;
  type: SecurityEventType;
  targetDeviceId: number | null;
  sourceDeviceId: number | null;
  sourceIp: Buffer | null;
  sessionUid: string | null;
  detail: unknown;
  createdAt: Date;
}

export interface NewSecurityEvent {
  type: SecurityEventType;
  targetDeviceId?: number | null;
  sourceDeviceId?: number | null;
  sourceIp?: Buffer | null;
  sessionUid?: string | null;
  detail?: unknown;
}

export interface SecurityEventsRepo {
  add(e: NewSecurityEvent): Promise<void>;
  list(q: { type?: string; deviceId?: number; limit: number; offset: number }): Promise<SecurityEventRecord[]>;
  deleteOlderThan(d: Date): Promise<number>;
}

// ---------- 封禁 ----------
export interface BanRecord {
  id: number;
  kind: 'device' | 'ip' | 'cidr';
  value: string;
  reason: string;
  source: 'manual' | 'auto';
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface NewBan {
  kind: BanRecord['kind'];
  value: string;
  reason: string;
  source: BanRecord['source'];
  expiresAt: Date | null;
  createdBy: string;
}

export interface BansRepo {
  /** 同一 (kind,value) 已存在时覆盖 */
  add(b: NewBan): Promise<BanRecord>;
  remove(id: number): Promise<boolean>;
  removeByValue(kind: BanRecord['kind'], value: string): Promise<number>;
  list(opts: { includeExpired?: boolean }): Promise<BanRecord[]>;
  /** 查有效封禁：设备 uid、IP 精确匹配、CIDR 命中 */
  findActive(q: { deviceUid?: string; ip?: string }): Promise<BanRecord | null>;
  deleteExpired(): Promise<number>;
}

// ---------- 版本发布 ----------
export interface ReleaseRecord {
  id: number;
  version: string;
  kind: string;
  platform: string;
  arch: string;
  channel: string;
  downloadUrl: string;
  signature: string;
  notes: string | null;
  rolloutPercent: number;
  /** 0 撤回 1 生效 */
  status: number;
  publishedAt: Date;
}

export type NewRelease = Omit<ReleaseRecord, 'id' | 'publishedAt'> & { publishedAt?: Date };

export interface ReleasesRepo {
  insert(r: NewRelease): Promise<ReleaseRecord>;
  findById(id: number): Promise<ReleaseRecord | null>;
  update(id: number, v: { rolloutPercent?: number; status?: number; notes?: string | null }): Promise<boolean>;
  list(q: { kind?: string; platform?: string; arch?: string; channel?: string; limit: number }): Promise<ReleaseRecord[]>;
  /** 某平台生效中的所有发布 */
  findActive(q: { kind: string; platform: string; arch: string; channel: string }): Promise<ReleaseRecord[]>;
}

// ---------- 下发配置 ----------
export interface ConfigEntry {
  key: string;
  value: unknown;
  remark: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface ConfigRepo {
  getAll(): Promise<ConfigEntry[]>;
  set(key: string, value: unknown, remark: string, by: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

// ---------- 中继节点（静态登记） ----------
export interface RelayNodeRecord {
  id: number;
  name: string;
  region: string;
  publicUrl: string;
  /** 0 停用 1 启用 2 排空 */
  status: number;
  capacity: number;
}

export interface RelayNodesRepo {
  list(): Promise<RelayNodeRecord[]>;
  upsert(n: Omit<RelayNodeRecord, 'id'>): Promise<RelayNodeRecord>;
  remove(name: string): Promise<boolean>;
}

// ---------- 管理审计 ----------
export interface AuditRecord {
  id: number;
  adminId: number;
  action: string;
  target: string;
  detail: unknown;
  ip: Buffer | null;
  createdAt: Date;
}

export interface AuditRepo {
  add(a: { adminId: number; action: string; target: string; detail?: unknown; ip?: Buffer | null }): Promise<void>;
  list(q: { limit: number; offset: number }): Promise<AuditRecord[]>;
  deleteOlderThan(d: Date): Promise<number>;
}

// ---------- 每日统计 ----------
export interface DailyStat {
  statDate: string;
  newDevices: number;
  activeDevices: number;
  sessionsTotal: number;
  sessionsAuthed: number;
  authFailures: number;
  bytesRelayed: number;
  peakOnline: number;
  peakSessions: number;
}

export interface StatsRepo {
  /** 累加计数类字段，取最大值类字段（peak_*） */
  apply(date: string, add: Partial<Omit<DailyStat, 'statDate' | 'peakOnline' | 'peakSessions' | 'activeDevices'>>, max: { peakOnline?: number; peakSessions?: number; activeDevices?: number }): Promise<void>;
  range(from: string, to: string): Promise<DailyStat[]>;
}

// ---------- 设备每日流量 ----------
/** 某台设备在某天的流量。in = 该设备收到的，out = 该设备发出的（相对设备本身，不是相对服务器） */
export interface DeviceTraffic {
  deviceId: number;
  statDate: string;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
}

export type TrafficDelta = Omit<DeviceTraffic, 'statDate'>;

/** 某台设备在某一分钟的流量；minute 是该分钟起点的 Unix 秒（UTC，60 的整数倍） */
export interface DeviceTrafficMinute extends Omit<DeviceTraffic, 'statDate'> {
  minute: number;
}

export interface TrafficRepo {
  /** 一次性累加多台设备的增量（单条语句，失败重试不会重复累加一部分）。minute 不为空时同时累加到分钟表 */
  add(date: string, rows: TrafficDelta[], minute?: number): Promise<void>;
  /** 分钟级流量，[from, to) 为 Unix 秒，按时间升序；没有流量的分钟没有行 */
  rangeMinutes(q: { from: number; to: number; deviceId?: number; limit: number }): Promise<DeviceTrafficMinute[]>;
  range(q: { from: string; to: string; deviceId?: number; limit: number }): Promise<DeviceTraffic[]>;
}

export interface Repos {
  devices: DevicesRepo;
  sessions: SessionsRepo;
  events: SecurityEventsRepo;
  bans: BansRepo;
  releases: ReleasesRepo;
  appConfig: ConfigRepo;
  relayNodes: RelayNodesRepo;
  audit: AuditRepo;
  stats: StatsRepo;
  traffic: TrafficRepo;
  /** 释放连接 */
  close(): Promise<void>;
}
