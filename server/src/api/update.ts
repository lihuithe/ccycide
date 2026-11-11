import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import type { ReleaseRecord } from '../db/repos/index.js';
import { compareVersions } from '../util/version.js';
import { ipOf, publicRateLimited, sendError } from './util.js';

/** Tauri 的 {{target}} 取值是 windows / darwin / linux，库里存的是 windows / macos / linux */
const TARGETS: Record<string, string> = { windows: 'windows', darwin: 'macos', macos: 'macos', linux: 'linux' };
/** Tauri 的 {{arch}} 取值：x86_64 / aarch64 / i686 / armv7 */
const ARCHS: Record<string, string> = { x86_64: 'x86_64', amd64: 'x86_64', aarch64: 'aarch64', arm64: 'aarch64' };

/** 灰度：按设备标识的哈希取模（0–99），小于 rollout_percent 的设备才收到更新 */
export function rolloutBucket(deviceKey: string): number {
  return createHash('sha256').update(deviceKey).digest().readUInt32BE(0) % 100;
}

/**
 * 从生效的发布里挑出该设备应当升级到的版本：比当前版本高、灰度命中，取最高的。
 * 没有则返回 null。
 */
export function pickRelease(releases: ReleaseRecord[], current: string, deviceKey: string): ReleaseRecord | null {
  const bucket = rolloutBucket(deviceKey);
  let best: ReleaseRecord | null = null;
  for (const r of releases) {
    if (r.status !== 1) continue;
    if (compareVersions(r.version, current) !== 1) continue;
    if (bucket >= r.rolloutPercent) continue;
    if (!best || compareVersions(r.version, best.version) === 1) best = r;
  }
  return best;
}

/**
 * GET /v1/update/:target/:arch/:version
 * 有更新返回 200 + Tauri updater 要求的 JSON；没有更新返回 204。
 * 可选查询参数：kind（desktop|cli，默认 desktop）、channel（stable|beta，默认 stable）、device_id（灰度用；
 * 也可放在 X-Device-Id 请求头里，都没有就退回用 IP 哈希）。
 */
export function updateRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get<{
    Params: { target: string; arch: string; version: string };
    Querystring: { kind?: string; channel?: string; device_id?: string };
  }>('/v1/update/:target/:arch/:version', async (req, reply) => {
    if (await publicRateLimited(ctx, req, reply, 'upd')) return reply;
    const { target, arch, version } = req.params;
    const platform = TARGETS[target.toLowerCase()];
    const archN = ARCHS[arch.toLowerCase()];
    if (!platform || !archN) return reply.code(204).send();
    if (compareVersions(version, '0.0.0') === null) return sendError(reply, 400, 'BAD_REQUEST', 'version 不是合法的版本号');
    const kind = req.query.kind === 'cli' ? 'cli' : 'desktop';
    const channel = req.query.channel === 'beta' ? 'beta' : 'stable';
    const deviceKey = req.query.device_id || (req.headers['x-device-id'] as string | undefined) || ipOf(ctx, req);

    const releases = await ctx.repos.releases.findActive({ kind, platform, arch: archN, channel });
    const r = pickRelease(releases, version, deviceKey);
    if (!r) return reply.code(204).send();
    return {
      version: r.version,
      notes: r.notes ?? '',
      pub_date: r.publishedAt.toISOString(),
      url: r.downloadUrl,
      signature: r.signature,
    };
  });
}
