import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { DuplicateError, type BanRecord, type DeviceRecord, type SessionRecord } from '../db/repos/index.js';
import type { SignalControl } from '../signal/server.js';
import { CONFIG_KEYS } from '../service/config-service.js';
import { banTargetFor, bufferToIp, ipToBuffer, isValidIpOrCidr, normalizeIp, rateKeyIp } from '../util/ip.js';
import { compareVersions } from '../util/version.js';
import { utcDate } from '../util/time.js';
import { ARCHS, KINDS, PLATFORMS } from '../service/registration.js';
import { ipOf, sendError } from './util.js';

type Body = Record<string, unknown>;

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/** 常数时间比较令牌（先哈希成定长再比，避免长度泄露） */
export function tokenMatches(given: string, expected: string): boolean {
  return expected.length > 0 && timingSafeEqual(sha(given), sha(expected));
}

function intQ(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'string' && v !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const deviceView = (d: DeviceRecord, online?: boolean) => ({
  device_id: d.uid,
  device_code: d.code,
  kind: d.kind,
  platform: d.platform,
  arch: d.arch,
  os_version: d.osVersion,
  app_version: d.appVersion,
  status: d.status,
  register_ip: bufferToIp(d.registerIp),
  last_ip: bufferToIp(d.lastIp),
  last_seen_at: d.lastSeenAt,
  created_at: d.createdAt,
  ...(online === undefined ? {} : { online }),
});

const banView = (b: BanRecord) => ({
  id: b.id,
  kind: b.kind,
  value: b.value,
  reason: b.reason,
  source: b.source,
  expires_at: b.expiresAt,
  created_by: b.createdBy,
  created_at: b.createdAt,
});

const STATUS_NAMES = ['pending', 'accepted', 'paired', 'authed', 'ended', 'failed'];

/**
 * 管理接口（实现方案 6.8）：Bearer ADMIN_TOKEN 鉴权，只应在内网开放（Caddy 在公网入口直接返回 404）。
 * 未配置 ADMIN_TOKEN 时整个管理接口关闭（404）。
 */
export function adminRoutes(app: FastifyInstance, ctx: Ctx, signal: SignalControl | null): void {
  app.register(
    async (admin) => {
      admin.addHook('onRequest', async (req, reply) => {
        if (!ctx.cfg.adminToken) return sendError(reply, 404, 'NOT_FOUND', 'not found');
        const ip = ipOf(ctx, req);
        const rl = await ctx.stores.limiter.hit(`admin:ip:${rateKeyIp(ip)}`, 120, 60_000);
        if (!rl.allowed) return sendError(reply, 429, 'RATE_LIMITED', '请求过于频繁', Math.ceil(rl.retryAfterMs / 1000));
        const h = req.headers.authorization ?? '';
        const m = /^Bearer (.+)$/.exec(h);
        if (!m || !tokenMatches(m[1]!, ctx.cfg.adminToken)) {
          // 令牌错误额外限流，防暴力猜测
          const f = await ctx.stores.limiter.hit(`admin:fail:${rateKeyIp(ip)}`, 10, 60_000);
          if (!f.allowed) return sendError(reply, 429, 'RATE_LIMITED', '请求过于频繁', Math.ceil(f.retryAfterMs / 1000));
          return sendError(reply, 401, 'UNAUTHORIZED', '管理令牌无效');
        }
      });

      const audit = (req: FastifyRequest, action: string, target: string, detail?: unknown): Promise<void> =>
        ctx.repos.audit.add({ adminId: 0, action, target, detail, ip: ipToBuffer(ipOf(ctx, req)) }).catch((e) => {
          ctx.log.warn({ err: (e as Error).message }, '写入管理审计失败');
        });

      const findDevice = async (ref: string): Promise<DeviceRecord | null> =>
        /^\d{9,12}$/.test(ref) ? ctx.repos.devices.findByCode(ref) : ctx.repos.devices.findByUid(ref);

      const bad = (reply: FastifyReply, msg: string): FastifyReply => sendError(reply, 400, 'BAD_REQUEST', msg);

      // ----- 统计 -----
      admin.get('/stats', async () => {
        const dayStart = new Date(`${utcDate()}T00:00:00.000Z`);
        const since24h = new Date(Date.now() - 24 * 3600_000);
        const [online, sessions24h, devicesTotal, newToday, nodes] = await Promise.all([
          ctx.stores.presence.count().catch(() => null),
          ctx.repos.sessions.countSince(since24h),
          ctx.repos.devices.search({ limit: 1, offset: 0 }),
          ctx.repos.devices.countCreatedSince(dayStart),
          ctx.relays.nodes().catch(() => []),
        ]);
        const from = utcDate(new Date(Date.now() - 6 * 24 * 3600_000));
        const daily = await ctx.repos.stats.range(from, utcDate());
        return {
          online_devices: online,
          signal_connections_local: signal?.localConnCount() ?? 0,
          devices_total: devicesTotal.total,
          devices_new_today: newToday,
          sessions_24h: sessions24h,
          relay_nodes: nodes.map((n) => ({
            name: n.name, region: n.region, public_url: n.publicUrl, sessions: n.sessions, capacity: n.capacity,
            bandwidth: n.bandwidth, status: n.status, registered: n.registered ? { status: n.registered.status, capacity: n.registered.capacity } : null,
          })),
          daily,
        };
      });

      // ----- 设备 -----
      admin.get<{ Querystring: Body }>('/devices', async (req) => {
        const q = req.query;
        const status = q.status === '0' || q.status === '1' ? Number(q.status) : undefined;
        const r = await ctx.repos.devices.search({
          text: typeof q.q === 'string' && q.q ? q.q : undefined,
          status,
          limit: intQ(q.limit, 50, 1, 200),
          offset: intQ(q.offset, 0, 0, 1_000_000),
        });
        return { total: r.total, items: r.items.map((d) => deviceView(d)) };
      });

      admin.get<{ Params: { ref: string } }>('/devices/:ref', async (req, reply) => {
        const d = await findDevice(req.params.ref);
        if (!d) return sendError(reply, 404, 'NOT_FOUND', '设备不存在');
        const p = await ctx.stores.presence.get(d.code).catch(() => null);
        const ban = await ctx.repos.bans.findActive({ deviceUid: d.uid });
        const lock = await ctx.guard.getLock(d.code).catch(() => null);
        return { ...deviceView(d, p !== null), presence: p && { accept: p.accept, platform: p.platform, app_version: p.appVersion, ip: p.ip }, ban: ban && banView(ban), lock };
      });

      admin.post<{ Params: { ref: string }; Body: Body }>('/devices/:ref/ban', async (req, reply) => {
        const d = await findDevice(req.params.ref);
        if (!d) return sendError(reply, 404, 'NOT_FOUND', '设备不存在');
        const body = req.body ?? {};
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 255) : '';
        const dur = body.duration_sec;
        if (dur !== undefined && (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0)) return bad(reply, 'duration_sec 必须是正数');
        const expiresAt = dur === undefined ? null : new Date(Date.now() + dur * 1000);
        const ban = await ctx.repos.bans.add({ kind: 'device', value: d.uid, reason, source: 'manual', expiresAt, createdBy: 'admin' });
        if (expiresAt === null) await ctx.repos.devices.setStatus(d.id, 1);
        ctx.devices.invalidate(d.uid);
        await signal?.kickDevice(d.code, 'banned').catch(() => {});
        await audit(req, 'device.ban', d.uid, { reason, duration_sec: dur ?? null });
        return { ok: true, ban: banView(ban) };
      });

      admin.post<{ Params: { ref: string } }>('/devices/:ref/unban', async (req, reply) => {
        const d = await findDevice(req.params.ref);
        if (!d) return sendError(reply, 404, 'NOT_FOUND', '设备不存在');
        await ctx.repos.devices.setStatus(d.id, 0);
        const n = await ctx.repos.bans.removeByValue('device', d.uid);
        await ctx.guard.unlockHost(d.code).catch(() => {});
        ctx.devices.invalidate(d.uid);
        await audit(req, 'device.unban', d.uid);
        return { ok: true, removed_bans: n };
      });

      // ----- 封禁列表（设备 / IP / CIDR） -----
      admin.get<{ Querystring: Body }>('/bans', async (req) => {
        const list = await ctx.repos.bans.list({ includeExpired: req.query.include_expired === 'true' });
        return { items: list.map(banView) };
      });

      admin.post<{ Body: Body }>('/bans', async (req, reply) => {
        const b = req.body ?? {};
        if (b.kind !== 'device' && b.kind !== 'ip' && b.kind !== 'cidr') return bad(reply, 'kind 只能是 device | ip | cidr');
        let kind: 'device' | 'ip' | 'cidr' = b.kind;
        if (typeof b.value !== 'string' || !b.value || b.value.length > 64) return bad(reply, 'value 必须是非空字符串');
        let value = b.value.trim();
        if (kind === 'ip') {
          if (!isValidIpOrCidr(value) || value.includes('/')) return bad(reply, 'value 不是合法的 IP');
          value = normalizeIp(value);
          // IPv6 单个地址换一个就能绕过，统一封所在的 /64
          const t = banTargetFor(value);
          kind = t.kind;
          value = t.value;
        } else if (kind === 'cidr') {
          if (!isValidIpOrCidr(value) || !value.includes('/')) return bad(reply, 'value 不是合法的 CIDR');
        }
        const dur = b.duration_sec;
        if (dur !== undefined && (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0)) return bad(reply, 'duration_sec 必须是正数');
        const ban = await ctx.repos.bans.add({
          kind,
          value,
          reason: typeof b.reason === 'string' ? b.reason.slice(0, 255) : '',
          source: 'manual',
          expiresAt: dur === undefined ? null : new Date(Date.now() + (dur as number) * 1000),
          createdBy: 'admin',
        });
        await audit(req, 'ban.add', `${kind}:${value}`, { reason: b.reason, duration_sec: dur ?? null });
        return { ok: true, ban: banView(ban) };
      });

      admin.delete<{ Params: { id: string } }>('/bans/:id', async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return bad(reply, 'id 不合法');
        const ok = await ctx.repos.bans.remove(id);
        if (!ok) return sendError(reply, 404, 'NOT_FOUND', '封禁记录不存在');
        await audit(req, 'ban.remove', String(id));
        return { ok: true };
      });

      // ----- 会话与安全事件 -----
      admin.get<{ Querystring: Body }>('/sessions', async (req) => {
        const q = req.query;
        let deviceId: number | undefined;
        if (typeof q.device === 'string' && q.device) {
          const d = await findDevice(q.device);
          if (!d) return { items: [] };
          deviceId = d.id;
        }
        const statusIdx = typeof q.status === 'string' ? STATUS_NAMES.indexOf(q.status) : -1;
        const list = await ctx.repos.sessions.list({
          deviceId,
          status: statusIdx >= 0 ? statusIdx : undefined,
          limit: intQ(q.limit, 50, 1, 200),
          offset: intQ(q.offset, 0, 0, 1_000_000),
        });
        const cache = new Map<number, string>();
        const code = async (id: number): Promise<string> => {
          if (!cache.has(id)) cache.set(id, (await ctx.repos.devices.findById(id))?.code ?? '');
          return cache.get(id)!;
        };
        const items = [];
        for (const s of list) items.push(await sessionView(s, code));
        return { items };
      });

      admin.get<{ Querystring: Body }>('/security-events', async (req) => {
        const q = req.query;
        let deviceId: number | undefined;
        if (typeof q.device === 'string' && q.device) {
          const d = await findDevice(q.device);
          if (!d) return { items: [] };
          deviceId = d.id;
        }
        const list = await ctx.repos.events.list({
          type: typeof q.type === 'string' && q.type ? q.type : undefined,
          deviceId,
          limit: intQ(q.limit, 50, 1, 200),
          offset: intQ(q.offset, 0, 0, 1_000_000),
        });
        return {
          items: list.map((e) => ({
            id: e.id, type: e.type, target_device_id: e.targetDeviceId, source_device_id: e.sourceDeviceId,
            source_ip: bufferToIp(e.sourceIp), session_id: e.sessionUid, detail: e.detail, created_at: e.createdAt,
          })),
        };
      });

      admin.get<{ Querystring: Body }>('/audit-logs', async (req) => {
        const list = await ctx.repos.audit.list({ limit: intQ(req.query.limit, 50, 1, 200), offset: intQ(req.query.offset, 0, 0, 1_000_000) });
        return { items: list.map((a) => ({ id: a.id, action: a.action, target: a.target, detail: a.detail, ip: bufferToIp(a.ip), created_at: a.createdAt })) };
      });

      // ----- 中继节点 -----
      admin.get('/relay-nodes', async () => {
        const [online, registered] = await Promise.all([ctx.relays.nodes().catch(() => []), ctx.repos.relayNodes.list()]);
        return {
          online: online.map((n) => ({ name: n.name, region: n.region, public_url: n.publicUrl, sessions: n.sessions, capacity: n.capacity, bandwidth: n.bandwidth, status: n.status })),
          registered: registered.map((n) => ({ name: n.name, region: n.region, public_url: n.publicUrl, status: n.status, capacity: n.capacity })),
        };
      });

      admin.put<{ Params: { name: string }; Body: Body }>('/relay-nodes/:name', async (req, reply) => {
        const b = req.body ?? {};
        const name = req.params.name;
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return bad(reply, '节点名只能包含字母、数字、点、下划线、连字符');
        if (typeof b.region !== 'string' || !b.region || b.region.length > 32) return bad(reply, 'region 必须是 1–32 字符的字符串');
        if (typeof b.public_url !== 'string' || !/^wss?:\/\/.{1,240}$/.test(b.public_url)) return bad(reply, 'public_url 必须是 ws:// 或 wss:// 地址');
        const status = b.status === undefined ? 1 : b.status;
        if (status !== 0 && status !== 1 && status !== 2) return bad(reply, 'status 只能是 0 停用 | 1 启用 | 2 排空');
        const capacity = b.capacity === undefined ? 5000 : b.capacity;
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) return bad(reply, 'capacity 必须是正整数');
        const rec = await ctx.repos.relayNodes.upsert({ name, region: b.region, publicUrl: b.public_url, status, capacity });
        ctx.relays.invalidate();
        await audit(req, 'relay_node.upsert', name, b);
        return { ok: true, node: { name: rec.name, region: rec.region, public_url: rec.publicUrl, status: rec.status, capacity: rec.capacity } };
      });

      admin.delete<{ Params: { name: string } }>('/relay-nodes/:name', async (req, reply) => {
        const ok = await ctx.repos.relayNodes.remove(req.params.name);
        if (!ok) return sendError(reply, 404, 'NOT_FOUND', '节点未登记');
        ctx.relays.invalidate();
        await audit(req, 'relay_node.remove', req.params.name);
        return { ok: true };
      });

      // ----- 版本发布 -----
      admin.get<{ Querystring: Body }>('/releases', async (req) => {
        const q = req.query;
        const list = await ctx.repos.releases.list({
          kind: typeof q.kind === 'string' ? q.kind : undefined,
          platform: typeof q.platform === 'string' ? q.platform : undefined,
          arch: typeof q.arch === 'string' ? q.arch : undefined,
          channel: typeof q.channel === 'string' ? q.channel : undefined,
          limit: intQ(q.limit, 100, 1, 500),
        });
        return { items: list.map(releaseView) };
      });

      admin.post<{ Body: Body }>('/releases', async (req, reply) => {
        const b = req.body ?? {};
        if (typeof b.version !== 'string' || compareVersions(b.version, '0.0.0') === null || b.version.length > 32) return bad(reply, 'version 必须是版本号');
        const kind = b.kind ?? 'desktop';
        if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return bad(reply, 'kind 只能是 desktop | cli');
        if (typeof b.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(b.platform)) return bad(reply, 'platform 只能是 windows | macos | linux');
        if (typeof b.arch !== 'string' || !(ARCHS as readonly string[]).includes(b.arch)) return bad(reply, 'arch 只能是 x86_64 | aarch64');
        const channel = b.channel ?? 'stable';
        if (channel !== 'stable' && channel !== 'beta') return bad(reply, 'channel 只能是 stable | beta');
        if (typeof b.download_url !== 'string' || !/^https:\/\/.{1,500}$/.test(b.download_url)) return bad(reply, 'download_url 必须是 https 地址');
        if (typeof b.signature !== 'string' || !b.signature) return bad(reply, 'signature 不能为空（Tauri 更新包签名）');
        const rollout = b.rollout_percent === undefined ? 100 : b.rollout_percent;
        if (typeof rollout !== 'number' || !Number.isInteger(rollout) || rollout < 0 || rollout > 100) return bad(reply, 'rollout_percent 必须是 0–100 的整数');
        try {
          const rec = await ctx.repos.releases.insert({
            version: b.version, kind, platform: b.platform, arch: b.arch, channel,
            downloadUrl: b.download_url, signature: b.signature,
            notes: typeof b.notes === 'string' ? b.notes : null,
            rolloutPercent: rollout, status: 1,
          });
          ctx.configService.invalidate();
          await audit(req, 'release.publish', `${b.version}/${kind}/${b.platform}/${b.arch}/${channel}`, { rollout_percent: rollout });
          return { ok: true, release: releaseView(rec) };
        } catch (e) {
          if (e instanceof DuplicateError) return sendError(reply, 409, 'CONFLICT', '该版本已存在');
          throw e;
        }
      });

      admin.patch<{ Params: { id: string }; Body: Body }>('/releases/:id', async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        if (!Number.isInteger(id)) return bad(reply, 'id 不合法');
        const patch: { rolloutPercent?: number; status?: number; notes?: string | null } = {};
        if (b.rollout_percent !== undefined) {
          if (typeof b.rollout_percent !== 'number' || !Number.isInteger(b.rollout_percent) || b.rollout_percent < 0 || b.rollout_percent > 100) return bad(reply, 'rollout_percent 必须是 0–100 的整数');
          patch.rolloutPercent = b.rollout_percent;
        }
        if (b.status !== undefined) {
          if (b.status !== 0 && b.status !== 1) return bad(reply, 'status 只能是 0 撤回 | 1 生效');
          patch.status = b.status;
        }
        if (b.notes !== undefined) patch.notes = typeof b.notes === 'string' ? b.notes : null;
        const ok = await ctx.repos.releases.update(id, patch);
        if (!ok) return sendError(reply, 404, 'NOT_FOUND', '发布记录不存在');
        ctx.configService.invalidate();
        await audit(req, 'release.update', String(id), patch);
        return { ok: true, release: releaseView((await ctx.repos.releases.findById(id))!) };
      });

      // ----- 下发配置 -----
      admin.get('/config', async () => {
        const entries = await ctx.repos.appConfig.getAll();
        return {
          effective: await ctx.configService.get(),
          entries: entries.map((e) => ({ key: e.key, value: e.value, remark: e.remark, updated_by: e.updatedBy, updated_at: e.updatedAt })),
          allowed_keys: Object.keys(CONFIG_KEYS),
        };
      });

      admin.put<{ Params: { key: string }; Body: Body }>('/config/:key', async (req, reply) => {
        const key = req.params.key;
        const validate = CONFIG_KEYS[key];
        if (!validate) return bad(reply, `不支持的配置键，可用：${Object.keys(CONFIG_KEYS).join(' / ')}`);
        const b = req.body ?? {};
        if (!('value' in b)) return bad(reply, '请求体需要 value 字段');
        const err = validate(b.value);
        if (err) return bad(reply, `${key} ${err}`);
        await ctx.repos.appConfig.set(key, b.value, typeof b.remark === 'string' ? b.remark : '', 'admin');
        ctx.configService.invalidate();
        await audit(req, 'config.set', key);
        return { ok: true };
      });

      admin.delete<{ Params: { key: string } }>('/config/:key', async (req, reply) => {
        const ok = await ctx.repos.appConfig.delete(req.params.key);
        if (!ok) return sendError(reply, 404, 'NOT_FOUND', '配置键不存在');
        ctx.configService.invalidate();
        await audit(req, 'config.delete', req.params.key);
        return { ok: true };
      });

      // ----- 运营通知 -----
      admin.post<{ Body: Body }>('/notice', async (req, reply) => {
        const b = req.body ?? {};
        if (typeof b.text !== 'string' || !b.text || b.text.length > 500) return bad(reply, 'text 必须是 1–500 字符的字符串');
        const level = b.level ?? 'info';
        if (typeof level !== 'string' || !/^[a-z_]{1,16}$/.test(level)) return bad(reply, 'level 不合法');
        if (!signal) return sendError(reply, 503, 'UNAVAILABLE', '信令服务未运行');
        await signal.sendNotice(level, b.text, typeof b.device_code === 'string' ? b.device_code : undefined);
        await audit(req, 'notice.send', typeof b.device_code === 'string' ? b.device_code : '*', { level });
        return { ok: true };
      });
    },
    { prefix: '/v1/admin' },
  );
}

function releaseView(r: import('../db/repos/index.js').ReleaseRecord) {
  return {
    id: r.id, version: r.version, kind: r.kind, platform: r.platform, arch: r.arch, channel: r.channel,
    download_url: r.downloadUrl, notes: r.notes, rollout_percent: r.rolloutPercent, status: r.status, published_at: r.publishedAt,
  };
}

async function sessionView(s: SessionRecord, code: (id: number) => Promise<string>) {
  return {
    session_id: s.uid,
    controller_code: await code(s.controllerDeviceId),
    host_code: await code(s.hostDeviceId),
    relay_node: s.relayNode,
    status: STATUS_NAMES[s.status] ?? String(s.status),
    fail_reason: s.failReason,
    controller_ip: bufferToIp(s.controllerIp),
    host_ip: bufferToIp(s.hostIp),
    bytes_c2h: s.bytesC2h,
    bytes_h2c: s.bytesH2c,
    created_at: s.createdAt,
    authed_at: s.authedAt,
    ended_at: s.endedAt,
  };
}
