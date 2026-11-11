import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './api/app.js';
import { closeCtx, type BaseCtx, type Ctx } from './context.js';
import { RelayServer } from './relay/server.js';
import { SignalServer } from './signal/server.js';

export interface SignalApp {
  app: FastifyInstance;
  signal: SignalServer;
  port: number;
  stop(): Promise<void>;
}

/** 启动 API + 信令（同一个 HTTP 端口：HTTP 路由 + /v1/signal 的 WebSocket 升级） */
export async function startSignalApp(ctx: Ctx, port: number = ctx.cfg.port, host: string = ctx.cfg.host): Promise<SignalApp> {
  const signal = new SignalServer(ctx);
  const app = await buildApp(ctx, signal);
  signal.attach(app.server);
  await signal.start();
  await app.listen({ port, host });
  const bound = (app.server.address() as AddressInfo).port;
  return {
    app,
    signal,
    port: bound,
    async stop() {
      // 先停信令（通知并关闭客户端连接），再停 HTTP，最后把统计写盘
      await signal.stop();
      await app.close();
      await ctx.collector.flush();
    },
  };
}

export interface RelayApp {
  relay: RelayServer;
  port: number;
  stop(): Promise<void>;
}

export async function startRelayApp(ctx: BaseCtx, port: number, host: string): Promise<RelayApp> {
  const relay = new RelayServer(ctx);
  const bound = await relay.listen(port, host);
  return { relay, port: bound, stop: () => relay.shutdown() };
}

/** 安装进程级兜底：未处理的 Promise 拒绝只记日志，不让进程退出 */
export function installProcessGuards(log: { error: (o: object, m: string) => void }): void {
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason.message : String(reason) }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, '未捕获的异常，进程退出');
    process.exit(1);
  });
}

export { closeCtx };
