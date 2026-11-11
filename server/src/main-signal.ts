import { ConfigError, loadConfig } from './config.js';
import { closeCtx, createContext } from './context.js';
import { startJobs } from './jobs/index.js';
import { createLogger } from './logger.js';
import { installProcessGuards, startSignalApp } from './runtime.js';

/** 入口：HTTP API + 信令 */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const log = createLogger(cfg.logLevel, 'signal');
  installProcessGuards(log);
  const ctx = await createContext(cfg, log);
  const srv = await startSignalApp(ctx);
  const stopJobs = startJobs(ctx);
  log.info({ port: srv.port, store: cfg.store, redis: Boolean(cfg.redisUrl), instance: srv.signal.instanceId }, '信令与 API 已启动');

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, '收到终止信号，开始优雅退出');
    const hard = setTimeout(() => {
      log.error('优雅退出超时，强制退出');
      process.exit(1);
    }, 25_000);
    hard.unref();
    try {
      stopJobs();
      await srv.stop();
      await closeCtx(ctx);
      log.info('已退出');
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
