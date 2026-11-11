import { ConfigError, loadConfig } from './config.js';
import { closeCtx, createRelayContext } from './context.js';
import { createLogger } from './logger.js';
import { installProcessGuards, startRelayApp } from './runtime.js';

// 中继默认监听 8081（信令默认 8080）
process.env.PORT ??= '8081';

/** 入口：中继。不连接 MySQL，只使用 Redis（REDIS_URL 为空时用内存，仅限与信令同机同进程的开发场景） */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env, { requireMysql: false });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const log = createLogger(cfg.logLevel, 'relay');
  installProcessGuards(log);
  const ctx = await createRelayContext(cfg, log);
  const srv = await startRelayApp(ctx, cfg.port, cfg.host);
  log.info({ port: srv.port, node: cfg.relay.nodeName, region: cfg.relay.region, publicUrl: cfg.relay.publicUrl }, '中继已启动');

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, '收到终止信号，中继开始排空');
    try {
      await srv.stop();
      await closeCtx(ctx);
      process.exit(0);
    } catch (err) {
      log.error({ err: (err as Error).message }, '退出过程出错');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('启动失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
