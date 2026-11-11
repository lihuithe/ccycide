import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { registerDevice, type RegisterInput } from '../service/registration.js';
import { ipOf, sendError } from './util.js';

const bodySchema = {
  type: 'object',
  required: ['public_key', 'platform', 'arch', 'kind', 'ts', 'signature'],
  properties: {
    public_key: { type: 'string', maxLength: 64 },
    platform: { type: 'string', maxLength: 16 },
    arch: { type: 'string', maxLength: 16 },
    os_version: { type: 'string', maxLength: 128 },
    app_version: { type: 'string', maxLength: 64 },
    kind: { type: 'string', maxLength: 16 },
    ts: { type: 'integer' },
    signature: { type: 'string', maxLength: 128 },
  },
};

/** POST /v1/devices/register */
export function registerDeviceRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post<{ Body: RegisterInput }>('/v1/devices/register', { schema: { body: bodySchema }, bodyLimit: 8 * 1024 }, async (req, reply) => {
    const r = await registerDevice(ctx, req.body, ipOf(ctx, req));
    ctx.m.registerTotal.inc({ result: r.ok ? (r.created ? 'created' : 'existing') : r.code.toLowerCase() });
    if (!r.ok) return sendError(reply, r.status, r.code, r.message, r.retryAfter);
    return { device_id: r.device.uid, device_code: r.device.code };
  });
}
