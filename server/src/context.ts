import type { Knex } from 'knex';
import type { Config } from './config.js';
import { createRepos, type Repos } from './db/repos/index.js';
import type { WriteQueue } from './db/repos/resilient.js';
import type { Log } from './logger.js';
import { Metrics, type Counter, type Gauge, type Summary } from './metrics.js';
import { ConfigService } from './service/config-service.js';
import { DeviceDirectory } from './service/device-directory.js';
import { Guard } from './service/guard.js';
import { RelayPicker } from './service/relay-picker.js';
import { StatsCollector } from './service/stats.js';
import { createStores, type Stores } from './store/index.js';
import { createTrustChecker, type TrustChecker } from './util/ip.js';

export interface AppMetrics {
  httpDuration: Summary;
  registerTotal: Counter;
  signalMessages: Counter;
  authResults: Counter;
  connectResults: Counter;
  passwordFailures: Counter;
  pairTimeouts: Counter;
  relayBytes: Counter;
  relayCloses: Counter;
  signalConns: Gauge;
  onlineDevices: Gauge;
  relaySessions: Gauge;
}

/** 中继进程只需要这些 */
export interface BaseCtx {
  cfg: Config;
  log: Log;
  metrics: Metrics;
  m: AppMetrics;
  stores: Stores;
  trust: TrustChecker;
}

/** 信令 / API 进程需要的完整上下文 */
export interface Ctx extends BaseCtx {
  repos: Repos;
  knex: Knex | null;
  writeQueue: WriteQueue | null;
  collector: StatsCollector;
  configService: ConfigService;
  relays: RelayPicker;
  guard: Guard;
  devices: DeviceDirectory;
}

export function createMetrics(): { metrics: Metrics; m: AppMetrics } {
  const metrics = new Metrics();
  const m: AppMetrics = {
    httpDuration: metrics.summary('rterm_http_request_duration_seconds', 'HTTP 请求耗时'),
    registerTotal: metrics.counter('rterm_register_total', '设备注册请求，按结果'),
    signalMessages: metrics.counter('rterm_signal_messages_total', '收到的信令消息，按类型'),
    authResults: metrics.counter('rterm_signal_auth_total', '信令认证结果'),
    connectResults: metrics.counter('rterm_connect_requests_total', '连接请求结果分布：ok / unavailable / rejected / rate_limited ...'),
    passwordFailures: metrics.counter('rterm_password_failures_total', '被控端上报的密码失败次数'),
    pairTimeouts: metrics.counter('rterm_relay_pair_timeouts_total', '中继配对超时次数'),
    relayBytes: metrics.counter('rterm_relay_bytes_total', '中继转发的字节数，按方向'),
    relayCloses: metrics.counter('rterm_relay_closes_total', '中继关闭连接，按关闭码'),
    signalConns: metrics.gauge('rterm_signal_connections', '当前信令连接数'),
    onlineDevices: metrics.gauge('rterm_online_devices', '本实例上已认证的在线设备数'),
    relaySessions: metrics.gauge('rterm_relay_sessions', '中继当前已配对的会话数'),
  };
  return { metrics, m };
}

/** 中继进程的上下文：不连接 MySQL，只用 Redis（或内存）存储 */
export async function createRelayContext(cfg: Config, log: Log, stores?: Stores): Promise<BaseCtx> {
  const { metrics, m } = createMetrics();
  return { cfg, log, metrics, m, stores: stores ?? (await createStores(cfg, log)), trust: createTrustChecker(cfg.trustProxy) };
}

export interface ContextOverrides {
  stores?: Stores;
  repos?: Repos;
}

/** 信令 / API 进程的上下文。overrides 用于测试和 dev:all 共享存储 */
export async function createContext(cfg: Config, log: Log, overrides: ContextOverrides = {}): Promise<Ctx> {
  const base = await createRelayContext(cfg, log, overrides.stores);
  let repos = overrides.repos;
  let knex: Knex | null = null;
  let writeQueue: WriteQueue | null = null;
  if (!repos) {
    const b = createRepos(cfg, log);
    repos = b.repos;
    knex = b.knex;
    writeQueue = b.writeQueue;
  }
  return {
    ...base,
    repos,
    knex,
    writeQueue,
    collector: new StatsCollector(repos, log),
    configService: new ConfigService(cfg, repos, log),
    relays: new RelayPicker(cfg, base.stores, repos, log),
    guard: new Guard(base.stores.kv),
    devices: new DeviceDirectory(repos.devices, log, cfg.tunables.deviceCacheMs),
  };
}

/** 释放上下文占用的资源（连接池、定时器、指标采样） */
export async function closeCtx(ctx: BaseCtx & Partial<Pick<Ctx, 'repos'>>): Promise<void> {
  await ctx.repos?.close().catch(() => {});
  await ctx.stores.close().catch(() => {});
  ctx.metrics.stop();
}
