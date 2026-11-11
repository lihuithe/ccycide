import { decodeB64Exact, newDeviceCode, newUlid, registerSignString, verifyEd25519 } from '../crypto.js';
import type { Ctx } from '../context.js';
import { DuplicateError, type DeviceRecord } from '../db/repos/index.js';
import { ipToBuffer, rateKeyIp } from '../util/ip.js';

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export const ARCHS = ['x86_64', 'aarch64'] as const;
export const KINDS = ['desktop', 'cli'] as const;

export interface RegisterInput {
  public_key: string;
  platform: string;
  arch: string;
  os_version?: string;
  app_version?: string;
  kind: string;
  ts: number;
  signature: string;
}

export type RegisterResult =
  | { ok: true; device: DeviceRecord; created: boolean }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number };

const MAX_SKEW_SEC = 300;
const MAX_CODE_RETRY = 5;

/**
 * 设备注册（开发指南 T3）：
 * 限流 -> 字段校验 -> 时间戳 -> Ed25519 签名 -> 幂等查找 / 插入（设备码冲突重试 5 次）
 */
export async function registerDevice(ctx: Ctx, input: RegisterInput, ip: string): Promise<RegisterResult> {
  const fail = (status: number, code: string, message: string, retryAfter?: number): RegisterResult => ({ ok: false, status, code, message, retryAfter });

  const ban = await ctx.repos.bans.findActive({ ip });
  if (ban) return fail(403, 'BANNED', '该 IP 已被封禁');

  let rl;
  try {
    rl = await ctx.stores.limiter.hit(`reg:ip:${rateKeyIp(ip)}`, ctx.cfg.tunables.registerPerHourPerIp, 3600_000);
  } catch (err) {
    // 限流存储（Redis）不可用：注册失败关闭（不放行，避免被刷），但要明确告诉客户端是暂时性故障，而不是 500
    ctx.log.error({ err: (err as Error).message }, '限流存储不可用，注册暂时拒绝');
    return fail(503, 'UNAVAILABLE', '服务暂时不可用，请稍后重试', 5);
  }
  if (!rl.allowed) return fail(429, 'RATE_LIMITED', '注册过于频繁，请稍后再试', Math.ceil(rl.retryAfterMs / 1000));

  if (!(PLATFORMS as readonly string[]).includes(input.platform)) return fail(400, 'BAD_REQUEST', 'platform 只能是 windows | macos | linux');
  if (!(ARCHS as readonly string[]).includes(input.arch)) return fail(400, 'BAD_REQUEST', 'arch 只能是 x86_64 | aarch64');
  if (!(KINDS as readonly string[]).includes(input.kind)) return fail(400, 'BAD_REQUEST', 'kind 只能是 desktop | cli');
  const publicKey = decodeB64Exact(input.public_key, 32);
  if (!publicKey) return fail(400, 'BAD_REQUEST', 'public_key 必须是 32 字节的 base64');
  const signature = decodeB64Exact(input.signature, 64);
  if (!signature) return fail(400, 'BAD_REQUEST', 'signature 必须是 64 字节的 base64');
  if (!Number.isInteger(input.ts)) return fail(400, 'BAD_REQUEST', 'ts 必须是整数秒');

  const skew = Math.abs(Math.floor(Date.now() / 1000) - input.ts);
  if (skew > MAX_SKEW_SEC) return fail(400, 'BAD_TIMESTAMP', '客户端时间与服务器相差超过 5 分钟，请校准系统时间');

  const msg = registerSignString({ publicKeyB64: input.public_key, platform: input.platform, arch: input.arch, kind: input.kind, ts: input.ts });
  if (!verifyEd25519(publicKey, Buffer.from(msg, 'utf8'), signature)) return fail(401, 'BAD_SIGNATURE', '签名校验失败');

  const osVersion = (input.os_version ?? '').slice(0, 64);
  const appVersion = (input.app_version ?? '').slice(0, 32);

  const existing = await ctx.repos.devices.findByPublicKey(publicKey);
  if (existing) return refreshExisting(ctx, existing, input.platform, osVersion, appVersion);

  const registerIp = ipToBuffer(ip);
  for (let i = 0; i < MAX_CODE_RETRY; i++) {
    try {
      const device = await ctx.repos.devices.create({
        uid: newUlid(),
        code: newDeviceCode(),
        publicKey,
        kind: input.kind,
        platform: input.platform,
        arch: input.arch,
        osVersion,
        appVersion,
        registerIp,
      });
      ctx.collector.inc('newDevices');
      return { ok: true, device, created: true };
    } catch (e) {
      if (!(e instanceof DuplicateError)) throw e;
      if (e.field === 'public_key') {
        // 并发注册同一公钥：查出先插入的那条返回
        const again = await ctx.repos.devices.findByPublicKey(publicKey);
        if (again) return refreshExisting(ctx, again, input.platform, osVersion, appVersion);
      }
      // device_code 冲突：换一个码重试
    }
  }
  return fail(503, 'INTERNAL', '设备码分配失败，请稍后重试');
}

async function refreshExisting(ctx: Ctx, d: DeviceRecord, platform: string, osVersion: string, appVersion: string): Promise<RegisterResult> {
  if (d.platform !== platform || d.osVersion !== osVersion || d.appVersion !== appVersion) {
    await ctx.repos.devices.updateInfo(d.id, { platform, osVersion, appVersion });
    ctx.devices.invalidate(d.uid);
    d = { ...d, platform, osVersion, appVersion };
  }
  return { ok: true, device: d, created: false };
}
