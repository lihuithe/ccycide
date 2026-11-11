import { parseVersion } from './util/version.js';

/** 配置错误：启动时直接报出缺哪一项 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 可调参数，默认值来自《实现方案.md》17.1。测试里会缩短其中的计时。 */
export interface Tunables {
  /** hello 之后等待 auth 的时间 */
  authTimeoutMs: number;
  /** 超过这个时间没收到客户端任何消息就断开（45 秒） */
  idleTimeoutMs: number;
  /** 空闲扫描间隔 */
  idleSweepMs: number;
  /** 在线状态有效期（90 秒） */
  presenceTtlSec: number;
  /** 告知客户端的应用层心跳间隔（20 秒） */
  heartbeatSec: number;
  /** 被控端处理连接请求（含“连接确认”弹窗）的等待上限，仅用于防泄漏，默认 3600 秒；不再有 10 秒自动拒绝 */
  connectPendingMaxSec: number;
  /** 检查挂起请求双方是否还在线的间隔（被控端或主控端所在实例丢失、Pub/Sub 消息丢失时的兜底） */
  pendingCheckMs: number;
  /** 单台被控端同时挂起的连接请求数上限，超出对新请求返回 RATE_LIMITED(host_pending_full) */
  maxPendingPerHost: number;
  /** 票据有效期（30 秒） */
  ticketTtlSec: number;
  /** 中继配对超时（15 秒） */
  pairTimeoutMs: number;
  /** 中继 WebSocket 协议层 ping 间隔（30 秒） */
  relayPingMs: number;
  /** 中继单条消息上限（128KB） */
  relayMaxMessage: number;
  /** 中继发送缓冲高低水位 */
  relayHighWater: number;
  relayLowWater: number;
  /** 单会话带宽（4MB/s）与突发（8MB） */
  sessionBytesPerSec: number;
  sessionBurstBytes: number;
  /** 单设备每日流量（10GB） */
  dailyQuotaBytes: number;
  /** 单个主控设备同时发起的会话数（8） */
  maxSessionsPerDevice: number;
  /** 单台被控端同时接受的会话数（100） */
  maxSessionsPerHost: number;
  /** 信令连接同 IP 并发上限（50） */
  maxSignalConnsPerIp: number;
  /** 单条信令连接的消息速率上限：每 10 秒多少条 */
  maxMsgsPer10s: number;
  /** 公钥缓存时间（5 分钟）与 last_seen 写库节流（5 分钟） */
  deviceCacheMs: number;
  lastSeenThrottleMs: number;
  /** 服务端要求的最低协议版本 */
  minProtoVer: number;
  /** 限流（实现方案 6.6） */
  registerPerHourPerIp: number;
  connectPerMinDevice: number;
  connectPerHourDevice: number;
  connectPerMinIp: number;
  connectPerMinTarget: number;
  /** 公开只读接口（/v1/config、/v1/update）每个来源每分钟的请求数 */
  publicPerMinIp: number;
}

export interface Config {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  /** memory：不使用 MySQL，所有数据放进程内存（开发和联调用） */
  store: 'memory' | 'mysql';
  mysqlUrl: string;
  /** 为空使用内存实现（仅限单机） */
  redisUrl: string;
  ticketSecret: string;
  ticketSecretOld: string;
  adminToken: string;
  /** 配置签名私钥 seed（base64 的 32 字节）。为空则 /v1/config 不带 config_sig，客户端只用内置规则 */
  configSigningKey: string;
  trustProxy: string;
  /** 下发给客户端的信令地址，/v1/config 的 signal_url */
  signalPublicUrl: string;
  minAppVersion: string;
  latestAppVersion: string;
  relay: {
    nodeName: string;
    region: string;
    publicUrl: string;
    /** 本节点会话数上限 */
    capacity: number;
    /** 收到 SIGTERM 后先等多少秒让现有会话自然结束，再发 4006；0 表示立即发 4006 */
    drainWaitSec: number;
    /** 发出 4006 之后最多再等多少秒就退出 */
    drainGraceSec: number;
  };
  tunables: Tunables;
}

export const DEV_TICKET_SECRET = 'rterm-dev-ticket-secret-do-not-use-in-production';

export const DEFAULT_TUNABLES: Tunables = {
  authTimeoutMs: 5_000,
  idleTimeoutMs: 45_000,
  idleSweepMs: 15_000,
  presenceTtlSec: 90,
  heartbeatSec: 20,
  connectPendingMaxSec: 3600,
  maxPendingPerHost: 50,
  pendingCheckMs: 10_000,
  ticketTtlSec: 30,
  pairTimeoutMs: 15_000,
  relayPingMs: 30_000,
  relayMaxMessage: 128 * 1024,
  relayHighWater: 1024 * 1024,
  relayLowWater: 256 * 1024,
  sessionBytesPerSec: 4 * 1024 * 1024,
  sessionBurstBytes: 8 * 1024 * 1024,
  dailyQuotaBytes: 10 * 1024 * 1024 * 1024,
  maxSessionsPerDevice: 8,
  maxSessionsPerHost: 100,
  maxSignalConnsPerIp: 50,
  maxMsgsPer10s: 200,
  deviceCacheMs: 5 * 60_000,
  lastSeenThrottleMs: 5 * 60_000,
  minProtoVer: 1,
  registerPerHourPerIp: 10,
  connectPerMinDevice: 10,
  connectPerHourDevice: 60,
  connectPerMinIp: 30,
  connectPerMinTarget: 120,
  publicPerMinIp: 120,
};

/** 环境变量为空字符串（compose 里  没设置时就是空）按未设置处理 */
const str = (env: NodeJS.ProcessEnv, name: string, def: string): string => (env[name] ? env[name]! : def);

function num(env: NodeJS.ProcessEnv, name: string, def: number, errors: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`环境变量 ${name} 必须是非负数字，当前值：${raw}`);
    return def;
  }
  return n;
}

/**
 * 读取并校验环境变量。校验失败抛出 ConfigError，信息里列出所有问题。
 * 传入 env 参数是为了测试时不污染 process.env。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { requireMysql?: boolean } = {}): Config {
  const errors: string[] = [];
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  const prod = nodeEnv === 'production';

  const storeRaw = str(env, 'STORE', 'mysql').toLowerCase();
  if (storeRaw !== 'memory' && storeRaw !== 'mysql') {
    errors.push(`环境变量 STORE 只能是 memory 或 mysql，当前值：${env.STORE}`);
  }
  const store: 'memory' | 'mysql' = storeRaw === 'memory' ? 'memory' : 'mysql';

  const mysqlUrl = env.MYSQL_URL ?? '';
  // 中继不连接 MySQL（会话字节数经 Redis 回传给信令写库），所以中继入口传 requireMysql: false
  if (store === 'mysql' && !mysqlUrl && opts.requireMysql !== false) {
    errors.push('缺少环境变量 MYSQL_URL（或设置 STORE=memory 使用内存存储，仅限开发联调）');
  }

  let ticketSecret = env.TICKET_SECRET ?? '';
  if (!ticketSecret) {
    if (prod) errors.push('缺少环境变量 TICKET_SECRET（生产环境必须设置，信令和中继共用）');
    else ticketSecret = DEV_TICKET_SECRET;
  } else if (prod && ticketSecret.length < 16) {
    errors.push('TICKET_SECRET 太短，生产环境至少 16 个字符（建议 openssl rand -hex 32）');
  }
  // 公开的开发默认密钥一旦用于生产，任何人都能伪造票据（安全审查 L10）：生产环境（含旧密钥）一律拒绝启动
  if (prod && (ticketSecret === DEV_TICKET_SECRET || env.TICKET_SECRET_OLD === DEV_TICKET_SECRET)) {
    errors.push('生产环境（NODE_ENV=production）不允许使用开发默认的票据密钥，请设置随机的 TICKET_SECRET（openssl rand -hex 32）');
  }

  const configSigningKey = (env.CONFIG_SIGNING_KEY ?? '').trim();
  if (configSigningKey && Buffer.from(configSigningKey, 'base64').length !== 32) {
    errors.push('CONFIG_SIGNING_KEY 必须是 base64 编码的 32 字节 Ed25519 seed（可用 openssl rand -base64 32 生成）');
  }

  const minAppVersion = str(env, 'MIN_APP_VERSION', '0.1.0');
  const latestAppVersion = str(env, 'LATEST_APP_VERSION', minAppVersion);
  if (!parseVersion(minAppVersion)) errors.push(`MIN_APP_VERSION 不是合法的版本号：${minAppVersion}`);
  if (!parseVersion(latestAppVersion)) errors.push(`LATEST_APP_VERSION 不是合法的版本号：${latestAppVersion}`);

  const port = num(env, 'PORT', 8080, errors);
  const t = { ...DEFAULT_TUNABLES };
  t.maxSessionsPerDevice = num(env, 'MAX_SESSIONS_PER_DEVICE', t.maxSessionsPerDevice, errors);
  t.maxSessionsPerHost = num(env, 'MAX_SESSIONS_PER_HOST', t.maxSessionsPerHost, errors);
  t.connectPendingMaxSec = num(env, 'CONNECT_PENDING_MAX_SEC', t.connectPendingMaxSec, errors);
  t.maxPendingPerHost = num(env, 'MAX_PENDING_PER_HOST', t.maxPendingPerHost, errors);
  t.dailyQuotaBytes = num(env, 'DAILY_QUOTA_BYTES', t.dailyQuotaBytes, errors);
  t.sessionBytesPerSec = num(env, 'SESSION_BYTES_PER_SEC', t.sessionBytesPerSec, errors);
  t.sessionBurstBytes = num(env, 'SESSION_BURST_BYTES', t.sessionBurstBytes, errors);
  t.minProtoVer = num(env, 'MIN_PROTO_VER', t.minProtoVer, errors);
  t.registerPerHourPerIp = num(env, 'RATE_REGISTER_PER_HOUR_IP', t.registerPerHourPerIp, errors);
  t.connectPerMinIp = num(env, 'RATE_CONNECT_PER_MIN_IP', t.connectPerMinIp, errors);
  t.publicPerMinIp = num(env, 'RATE_PUBLIC_PER_MIN_IP', t.publicPerMinIp, errors);

  const relayCapacity = num(env, 'RELAY_CAPACITY', 5000, errors);
  const drainWaitSec = num(env, 'RELAY_DRAIN_WAIT_SEC', 0, errors);
  const drainGraceSec = num(env, 'RELAY_DRAIN_GRACE_SEC', 30, errors);

  if (errors.length > 0) {
    throw new ConfigError(`配置错误：\n  - ${errors.join('\n  - ')}`);
  }

  const host = str(env, 'HOST', '0.0.0.0');
  return {
    nodeEnv,
    host,
    port,
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    store,
    mysqlUrl,
    redisUrl: str(env, 'REDIS_URL', ''),
    ticketSecret,
    ticketSecretOld: env.TICKET_SECRET_OLD ?? '',
    adminToken: env.ADMIN_TOKEN ?? '',
    configSigningKey,
    trustProxy: str(env, 'TRUST_PROXY', 'false'),
    signalPublicUrl: str(env, 'SIGNAL_PUBLIC_URL', `ws://127.0.0.1:${port}/v1/signal`),
    minAppVersion,
    latestAppVersion,
    relay: {
      nodeName: str(env, 'RELAY_NODE_NAME', 'relay-dev'),
      region: str(env, 'RELAY_REGION', 'dev'),
      publicUrl: str(env, 'RELAY_PUBLIC_URL', 'ws://127.0.0.1:8081'),
      capacity: relayCapacity,
      drainWaitSec,
      drainGraceSec,
    },
    tunables: t,
  };
}

/** 票据验签用的密钥列表（新旧两个同时有效，方便轮换） */
export function ticketSecrets(cfg: Pick<Config, 'ticketSecret' | 'ticketSecretOld'>): string[] {
  return [cfg.ticketSecret, cfg.ticketSecretOld].filter(Boolean);
}
