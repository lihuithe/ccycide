/** 在线状态、限流、锁定、跨实例消息等“高频易变数据”的存储接口。内存与 Redis 各有一套实现。 */

export interface PresenceInfo {
  instanceId: string;
  connId: string;
  /** devices.id */
  deviceId: number;
  /** devices.device_uid（ULID） */
  deviceUid: string;
  deviceCode: string;
  /** 是否接受连接（presence.update） */
  accept: boolean;
  protoVer: number;
  minProtoVer: number;
  platform: string;
  /** 公钥 base64 */
  publicKey: string;
  appVersion: string;
  ip: string;
  region: string;
}

export interface PresenceStore {
  /** 上线或覆盖登记，返回被覆盖的旧登记（用于踢旧连接） */
  set(code: string, info: PresenceInfo): Promise<PresenceInfo | null>;
  get(code: string): Promise<PresenceInfo | null>;
  /** 续期，仅当 connId 匹配时生效 */
  refresh(code: string, connId: string): Promise<boolean>;
  setAccept(code: string, connId: string, accept: boolean): Promise<boolean>;
  /** 仅在 connId 匹配时删除：重连时新连接先登记、旧连接后关闭，不判断会把新连接的状态删掉 */
  remove(code: string, connId: string): Promise<boolean>;
  count(): Promise<number>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** 键不存在才设置，返回是否设置成功（一次性标记） */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** 累加并返回新值；键新建时设置过期时间 */
  incrBy(key: string, n: number, ttlMs: number): Promise<number>;
  del(key: string): Promise<void>;
  /** 剩余毫秒数；键不存在返回 -2，无过期返回 -1 */
  pttl(key: string): Promise<number>;
}

export interface RateResult {
  allowed: boolean;
  /** 被拒时，最早多久之后可以再试（毫秒） */
  retryAfterMs: number;
}

/** 滑动窗口计数 */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateResult>;
}

/** 跨实例投递的消息 */
export type BusMessage =
  | { k: 'incoming'; origin: string; sid: string; hostCode: string; hostDeviceId: number; controllerCode: string; controllerConnId: string; payload: unknown }
  | { k: 'reply'; sid: string; hostDeviceId: number; action: 'accept' | 'reject'; reason?: string }
  /** 向被控端的某条连接投递 connect.go / connect.cancelled（被控端和主控端所在实例可能不同） */
  | { k: 'tohost'; code: string; connId: string; sid: string; t: string; d: unknown }
  | { k: 'kick'; code: string; connId: string; reason: string }
  | { k: 'notice'; code?: string; level: string; text: string };

export interface SignalBus {
  /** 订阅发给本实例的消息，以及广播消息。返回取消订阅函数 */
  subscribe(instanceId: string, handler: (m: BusMessage) => void): Promise<() => Promise<void>>;
  /** 返回收到消息的订阅者数；0 表示目标实例已经不在（退出或失联），调用方据此立即判定投递失败 */
  publish(instanceId: string, m: BusMessage): Promise<number>;
  /** 向所有实例广播 */
  broadcast(m: BusMessage): Promise<void>;
}

export interface RelayNodeReport {
  name: string;
  region: string;
  publicUrl: string;
  sessions: number;
  capacity: number;
  /** 带宽使用率 0–1 */
  bandwidth: number;
  status: 'up' | 'draining';
  ts: number;
}

export interface RelayRegistry {
  report(info: RelayNodeReport, ttlMs: number): Promise<void>;
  /** 返回未过期的节点 */
  list(): Promise<RelayNodeReport[]>;
  remove(name: string): Promise<void>;
}

/** 每个设备当前打开的会话（待接受 + 已配对），用来限制“单设备同时会话数” */
export interface SessionTracker {
  touch(deviceUid: string, sid: string, ttlMs: number): Promise<void>;
  remove(deviceUid: string, sid: string): Promise<void>;
  count(deviceUid: string): Promise<number>;
  /** 某个键下是否还有这个会话（未过期）。被控端所在实例用它判断主控端那边的等待是否已经结束 */
  has(deviceUid: string, sid: string): Promise<boolean>;
}

/** 中继 -> 信令的会话事件 */
export interface RelaySessionEvent {
  /** traffic：一段时间内的流量增量（不是累计），中继每 30 秒和会话结束时各发一次 */
  type: 'paired' | 'ended' | 'traffic';
  sid: string;
  node: string;
  /** ended 时的原因：pair_timeout | closed | quota | shutdown | protocol | stale */
  reason?: string;
  /** ended 时是整个会话的累计值，traffic 时是增量 */
  bytesC2h?: number;
  bytesH2c?: number;
  /** 仅 traffic：增量帧数 */
  framesC2h?: number;
  framesH2c?: number;
  ts: number;
}

export interface SessionEventChannel {
  publish(ev: RelaySessionEvent): Promise<void>;
  /** 信令侧消费事件；返回停止函数 */
  consume(handler: (ev: RelaySessionEvent) => Promise<void> | void): () => void;
}

export interface Stores {
  presence: PresenceStore;
  kv: KvStore;
  limiter: RateLimiter;
  bus: SignalBus;
  registry: RelayRegistry;
  tracker: SessionTracker;
  sessionEvents: SessionEventChannel;
  /** 是否是 Redis 实现（影响一些降级行为） */
  isRedis: boolean;
  close(): Promise<void>;
}
