/**
 * 设备身份与注册（协议见 server/tools/rterm-client.ts 顶部注释）：
 * Ed25519 密钥对存在浏览器本地；注册时用私钥对 "rterm-register-v1\n<pk b64>\n<platform>\n<arch>\n<kind>\n<ts>" 签名。
 */
import { publicKeyOf, randomBytes, signMessage } from './crypto';
import { kvGet, kvSet } from './storage';
import { CodedError, b64encode } from './util';

export const APP_VERSION = '0.1.0';
const enc = new TextEncoder();

export interface Identity {
  /** 32 字节私钥种子 */
  seed: Uint8Array;
  publicKey: Uint8Array;
  deviceId: string;
  deviceCode: string;
}

interface Stored {
  seed: Uint8Array;
  deviceId: string;
  deviceCode: string;
  apiUrl: string;
}

const KEY = 'identity';

function detectPlatform(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'macos';
  return 'linux';
}

function osVersion(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const m = /(Edg|Chrome|Firefox|Safari)\/([\d.]+)/.exec(ua);
  return `Web (${m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'browser'})`.slice(0, 120);
}

/** 对 API 的 HTTP 请求：网络失败统一成 NETWORK 错误 */
async function api(apiUrl: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, { ...init, cache: 'no-store' });
  } catch {
    throw new CodedError('NETWORK', `无法连接服务器 ${apiUrl}`);
  }
}

/** 用给定私钥注册（已注册的设备服务端按公钥识别，原样返回同一个设备码） */
export async function registerDevice(apiUrl: string, seed: Uint8Array): Promise<{ deviceId: string; deviceCode: string }> {
  const pk = b64encode(publicKeyOf(seed));
  const platform = detectPlatform();
  const ts = Math.floor(Date.now() / 1000);
  const signString = `rterm-register-v1\n${pk}\n${platform}\nx86_64\ndesktop\n${ts}`;
  const signature = b64encode(signMessage(seed, enc.encode(signString)));
  const res = await api(apiUrl, '/v1/devices/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: pk, platform, arch: 'x86_64', os_version: osVersion(), app_version: APP_VERSION, kind: 'desktop', ts, signature }),
  });
  const body = (await res.json().catch(() => ({}))) as { device_id?: string; device_code?: string; error?: { code?: string; message?: string } };
  if (!res.ok || !body.device_id || !body.device_code) {
    throw new CodedError(body.error?.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NETWORK', body.error?.message ?? `注册失败（HTTP ${res.status}）`);
  }
  return { deviceId: body.device_id, deviceCode: body.device_code };
}

/** 读取已保存的身份；没有（或服务器地址变了）就新生成密钥并注册 */
export async function loadOrCreateIdentity(apiUrl: string): Promise<Identity> {
  const saved = await kvGet<Stored>(KEY);
  if (saved && saved.apiUrl === apiUrl) {
    return { seed: saved.seed, publicKey: publicKeyOf(saved.seed), deviceId: saved.deviceId, deviceCode: saved.deviceCode };
  }
  const seed = saved?.seed ?? randomBytes(32);
  const { deviceId, deviceCode } = await registerDevice(apiUrl, seed);
  await kvSet(KEY, { seed, deviceId, deviceCode, apiUrl } satisfies Stored);
  return { seed, publicKey: publicKeyOf(seed), deviceId, deviceCode };
}

/** 服务端重置（信令认证返回 UNKNOWN_DEVICE）后：用同一把密钥重新注册，设备码可能变化 */
export async function reRegister(apiUrl: string, old: Identity): Promise<Identity> {
  const { deviceId, deviceCode } = await registerDevice(apiUrl, old.seed);
  await kvSet(KEY, { seed: old.seed, deviceId, deviceCode, apiUrl } satisfies Stored);
  return { ...old, deviceId, deviceCode };
}

/** 导出身份（备份用）：JSON 文本，包含私钥，务必保密 */
export function exportIdentity(id: Identity, apiUrl: string): string {
  return JSON.stringify({ v: 1, seed: b64encode(id.seed), deviceId: id.deviceId, deviceCode: id.deviceCode, apiUrl });
}

export interface ServerConfig {
  signalUrl: string;
}

/** 取服务端配置，得到信令地址；失败时由 API 地址推导 */
export async function fetchSignalUrl(apiUrl: string): Promise<string> {
  const derived = `${apiUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/signal`;
  try {
    const res = await api(apiUrl, '/v1/config');
    if (!res.ok) return derived;
    const cfg = (await res.json()) as { signal_url?: string };
    const u = cfg.signal_url;
    if (typeof u !== 'string') return derived;
    const loopback = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
    return u.startsWith('wss://') || loopback ? u : derived;
  } catch {
    return derived;
  }
}
