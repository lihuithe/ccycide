import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import type { SignalControl } from '../signal/server.js';
import { adminRoutes } from './admin.js';
import { configRoutes } from './config.js';
import { registerDeviceRoutes } from './devices.js';
import { updateRoutes } from './update.js';
import { sendError } from './util.js';

/** 构建 Fastify 应用（不监听端口，测试可直接 inject）。signal 为 null 时管理接口无法踢人 / 广播。 */
export async function buildApp(ctx: Ctx, signal: SignalControl | null): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log.child({ comp: 'http' }) as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false, // 客户端 IP 统一由 ipOf() 按 TRUST_PROXY 计算
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });

  // 空请求体按 {} 处理（例如 curl -X POST 解封接口不带 body），其余仍按严格 JSON 解析
  // 用 Fastify 自带的解析器：遇到 __proto__ / constructor.prototype 之类的键直接报 400（原型污染防护，安全审查 L10）
  const strictJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    strictJson(req, text, done);
  });

  app.addHook('onRequest', async (req) => {
    (req as unknown as { _t0: bigint })._t0 = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    const t0 = (req as unknown as { _t0?: bigint })._t0;
    if (t0 === undefined) return;
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    ctx.m.httpDuration.observe({ route: req.routeOptions?.url ?? 'unknown', method: req.method, status: reply.statusCode }, sec);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.validation) return sendError(reply, 400, 'BAD_REQUEST', err.message);
    const sc = err.statusCode;
    if (sc && sc >= 400 && sc < 500) {
      const code = sc === 413 ? 'PAYLOAD_TOO_LARGE' : sc === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST';
      return sendError(reply, sc, code, err.message);
    }
    req.log.error({ err }, '请求处理出错');
    return sendError(reply, 500, 'INTERNAL', '服务内部错误');
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'NOT_FOUND', '接口不存在'));

  const health = async (): Promise<{ ok: true }> => ({ ok: true });
  app.get('/v1/healthz', health);
  app.get('/healthz', health);
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(ctx.metrics.render()));

  registerDeviceRoutes(app, ctx);
  configRoutes(app, ctx);
  updateRoutes(app, ctx);
  adminRoutes(app, ctx, signal);
  return app;
}
