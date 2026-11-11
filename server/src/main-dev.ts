/**
 * 联调入口：单进程同时启动信令（默认 8080）和中继（默认 8081），数据全部放内存，不需要 MySQL / Redis。
 *
 *   npm run dev:all
 *
 * 默认值（都可以用环境变量覆盖）：
 *   STORE=memory   TICKET_SECRET=开发默认值   RELAY_PUBLIC_URL=ws://127.0.0.1:8081
 *   CONFIG_SIGNING_KEY：未设置时自动生成一把临时密钥并在日志里打印对应公钥（客户端用 RTERM_CONFIG_PUBKEY=<公钥> 才会采用下发的规则）
 *   PORT=8080（信令 + API，healthz 在 /v1/healthz）   RELAY_PORT=8081（中继，healthz 在 /healthz）   HOST=127.0.0.1（只监听本机）
 * 本机联调时所有客户端来自同一个 IP，所以把按 IP 的限流放宽了（注册每小时 10000 次、连接请求每分钟 600 次）。
 */
process.env.STORE ??= 'memory';
process.env.RELAY_PUBLIC_URL ??= 'ws://127.0.0.1:8081';
process.env.RATE_REGISTER_PER_HOUR_IP ??= '10000';
process.env.RATE_CONNECT_PER_MIN_IP ??= '600';
process.env.PORT ??= '8080';
process.env.HOST ??= '127.0.0.1'; // 联调模式只监听本机
const { generateSeedB64, signerFromSeed } = await import('./config-sign.js');
const generatedSigningKey = !process.env.CONFIG_SIGNING_KEY;
if (generatedSigningKey) process.env.CONFIG_SIGNING_KEY = generateSeedB64();

const { ConfigError, loadConfig } = await import('./config.js');
const { closeCtx, createContext, createRelayContext } = await import('./context.js');
const { startJobs } = await import('./jobs/index.js');
const { createLogger } = await import('./logger.js');
const { installProcessGuards, startRelayApp, startSignalApp } = await import('./runtime.js');
const { createStores } = await import('./store/index.js');

try {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, 'dev');
  installProcessGuards(log);
  const relayPort = Number(process.env.RELAY_PORT ?? 8081);

  // 信令与中继共用同一套存储（内存），这样节点注册、票据一次性标记、会话事件都能互通
  const stores = await createStores(cfg, log);
  const ctx = await createContext(cfg, log, { stores });
  const relayCtx = await createRelayContext(cfg, log, stores);
  const signal = await startSignalApp(ctx);
  const relay = await startRelayApp(relayCtx, relayPort, cfg.host);
  const stopJobs = startJobs(ctx);

  log.info(
    {
      config_pubkey: signerFromSeed(process.env.CONFIG_SIGNING_KEY!).publicKeyB64,
      config_pubkey_hint: generatedSigningKey ? '临时生成的配置签名密钥：客户端需设置 RTERM_CONFIG_PUBKEY=<config_pubkey> 才会采用下发的 adapters/claude_catalog' : undefined,
      signal: `ws://127.0.0.1:${signal.port}/v1/signal`,
      api: `http://127.0.0.1:${signal.port}/v1`,
      healthz: `http://127.0.0.1:${signal.port}/v1/healthz`,
      relay: `${cfg.relay.publicUrl}/v1/relay`,
      relayHealthz: `http://127.0.0.1:${relay.port}/healthz`,
      store: cfg.store,
    },
    'dev:all 已启动（STORE=memory，重启后数据清空）',
  );

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, '正在退出');
    stopJobs();
    await relay.stop().catch(() => {});
    await signal.stop().catch(() => {});
    await closeCtx(relayCtx).catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} catch (e) {
  if (e instanceof ConfigError) console.error(e.message);
  else console.error('启动失败：', e instanceof Error ? e.message : e);
  process.exit(1);
}
