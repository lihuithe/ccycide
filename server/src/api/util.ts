import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BaseCtx } from '../context.js';
import { clientIp, rateKeyIp } from '../util/ip.js';

/** 统一错误格式：{ "error": { "code", "message", "retry_after"? } } */
export function sendError(reply: FastifyReply, status: number, code: string, message: string, retryAfterSec?: number): FastifyReply {
  const error: { code: string; message: string; retry_after?: number } = { code, message };
  if (retryAfterSec !== undefined) {
    error.retry_after = retryAfterSec;
    void reply.header('Retry-After', String(retryAfterSec));
  }
  return reply.code(status).send({ error });
}

/** 客户端真实 IP：只有直连对端是受信任代理时才采用 X-Forwarded-For */
export function ipOf(ctx: BaseCtx, req: FastifyRequest): string {
  return clientIp(req.raw.socket.remoteAddress, req.headers['x-forwarded-for'], ctx.trust);
}

/**
 * 公开只读接口的按来源限流（IPv6 按 /64 归一）。返回 true 表示已经回复了 429/503，调用方直接返回。
 * 限流存储出错时 fail-closed（503），与其余路径一致。
 */
export async function publicRateLimited(ctx: BaseCtx, req: FastifyRequest, reply: FastifyReply, name: string): Promise<boolean> {
  try {
    const r = await ctx.stores.limiter.hit(`pub:${name}:${rateKeyIp(ipOf(ctx, req))}`, ctx.cfg.tunables.publicPerMinIp, 60_000);
    if (r.allowed) return false;
    sendError(reply, 429, 'RATE_LIMITED', '请求过于频繁', Math.ceil(r.retryAfterMs / 1000));
  } catch (err) {
    req.log.error({ err: (err as Error).message }, '限流存储不可用');
    sendError(reply, 503, 'UNAVAILABLE', '服务暂时不可用，请稍后重试', 5);
  }
  return true;
}
