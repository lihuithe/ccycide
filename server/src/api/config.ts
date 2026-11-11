import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { publicRateLimited } from './util.js';

/** GET /v1/config：客户端启动配置 */
export function configRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/v1/config', async (req, reply) => {
    if (await publicRateLimited(ctx, req, reply, 'cfg')) return reply;
    const cfg = await ctx.configService.get();
    // 客户端会本地缓存，这里让中间层不要缓存，由进程内 60 秒缓存负责减压
    void reply.header('Cache-Control', 'no-store');
    return cfg;
  });
}
