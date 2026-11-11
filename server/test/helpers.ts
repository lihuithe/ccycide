import { createServer } from 'node:net';
import { loadConfig, type Config, type Tunables } from '../src/config.js';
import { createContext, createRelayContext, closeCtx, type BaseCtx, type Ctx } from '../src/context.js';
import { silentLogger } from '../src/logger.js';
import { startRelayApp, startSignalApp, type RelayApp, type SignalApp } from '../src/runtime.js';
import { createMemoryStores, type Stores } from '../src/store/index.js';
import type { Repos } from '../src/db/repos/index.js';
import { createMemoryRepos } from '../src/db/repos/memory.js';
import { AuthError, SignalClient, registerNew, type Identity } from '../tools/rterm-client.js';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export function testConfig(over: { tunables?: Partial<Tunables>; relay?: Partial<Config['relay']> } & Partial<Omit<Config, 'tunables' | 'relay'>> = {}): Config {
  const base = loadConfig({ STORE: 'memory', TICKET_SECRET: 'test-ticket-secret-0123456789', NODE_ENV: 'test' });
  return {
    ...base,
    ...over,
    relay: { ...base.relay, ...over.relay },
    tunables: { ...base.tunables, ...over.tunables },
  };
}

export interface Stack {
  cfg: Config;
  stores: Stores;
  repos: Repos;
  ctx: Ctx;
  relayCtx: BaseCtx;
  signal: SignalApp;
  relay: RelayApp;
  http: string;
  ws: string;
  relayUrl: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  tunables?: Partial<Tunables>;
  relay?: Partial<Config['relay']>;
  cfg?: Partial<Omit<Config, 'tunables' | 'relay'>>;
  /** 使用指定的存储实现（默认内存），Redis 实现的测试用 */
  stores?: Stores;
  /** 中继使用独立的存储（独立的 Redis 连接，和多进程部署一致）；默认与信令共用 */
  relayStores?: Stores;
  /** 使用指定的数据访问实现（默认内存），MySQL 集成测试用 */
  repos?: Repos;
  /** 不启动中继（测试 NO_RELAY 之类） */
  noRelay?: boolean;
}

/** 单进程起一套完整服务（信令 + 中继 + 内存存储），端口随机 */
export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const relayPort = await freePort();
  const cfg = testConfig({
    adminToken: 'test-admin-token',
    ...o.cfg,
    relay: { publicUrl: `ws://127.0.0.1:${relayPort}`, nodeName: 'relay-test', ...o.relay },
    tunables: {
      // 测试里默认放宽按 IP 的限流，需要测限流的用例自己收紧
      registerPerHourPerIp: 10_000,
      connectPerMinIp: 10_000,
      connectPerMinDevice: 10_000,
      connectPerHourDevice: 10_000,
      connectPerMinTarget: 10_000,
      publicPerMinIp: 10_000,
      ...o.tunables,
    },
  });
  const log = silentLogger();
  const stores = o.stores ?? createMemoryStores(cfg);
  const repos = o.repos ?? createMemoryRepos();
  const ctx = await createContext(cfg, log, { stores, repos });
  const relayCtx = await createRelayContext(cfg, log, o.relayStores ?? stores);
  const signal = await startSignalApp(ctx, 0, '127.0.0.1');
  const relay = o.noRelay ? ({ relay: undefined, port: 0, stop: async () => {} } as unknown as RelayApp) : await startRelayApp(relayCtx, relayPort, '127.0.0.1');
  return {
    cfg,
    stores,
    repos,
    ctx,
    relayCtx,
    signal,
    relay,
    http: `http://127.0.0.1:${signal.port}`,
    ws: `ws://127.0.0.1:${signal.port}/v1/signal`,
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    async stop() {
      await relay.stop().catch(() => {});
      await signal.stop().catch(() => {});
      await closeCtx(relayCtx).catch(() => {});
      ctx.metrics.stop();
    },
  };
}

/** 注册一台设备并建立已认证的信令连接 */
export async function onlineDevice(s: Stack, opts: { accept?: boolean; appVersion?: string; protoVer?: number; minProtoVer?: number } = {}): Promise<{ identity: Identity; sig: SignalClient }> {
  const { identity } = await registerNew(s.http);
  const sig = await SignalClient.connect(s.ws, identity, opts);
  return { identity, sig };
}

export { AuthError };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等到条件成立（轮询），超时抛错 */
export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(10);
  }
}
