import { signerFromSeed, type ConfigSigner } from '../config-sign.js';
import type { Config } from '../config.js';
import type { Log } from '../logger.js';
import type { Repos } from '../db/repos/index.js';
import { withTimeout } from '../util/time.js';
import { compareVersions } from '../util/version.js';

/** 输入适配器默认规则，见《实现方案.md》5.5.4。与客户端内置规则（adapter.rs 的 builtin）保持一致 */
export const DEFAULT_ADAPTERS = [
  {
    id: 'claude-code',
    match: { profile: 'CLAUDE' },
    paste: 'bracketed',
    newline_in_paste: '\n',
    submit_delay_ms: 80,
    submit_key: '\r',
    fallback_newline: '\\\r',
    auto_passthrough_on_alt_screen: false,
    attach_separate: true,
    attach_gap_ms: 150,
  },
  {
    id: 'generic',
    match: {},
    paste: 'auto',
    newline_in_paste: '\r',
    submit_delay_ms: 30,
    submit_key: '\r',
    fallback_newline: '\r',
    auto_passthrough_on_alt_screen: true,
    attach_separate: false,
    attach_gap_ms: 150,
  },
];

export interface PublicConfig {
  signal_url: string;
  min_app_version: string;
  latest_app_version: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  adapters: unknown[];
  claude_catalog: unknown[];
  /** adapters 与 claude_catalog 的 Ed25519 签名（base64，见 config-sign.ts）；未配置签名密钥时没有这个字段 */
  config_sig?: string;
  notice: { level: string; text: string } | null;
}

/** app_config 里允许设置的键及其校验。校验失败返回错误说明，通过返回 null */
export const CONFIG_KEYS: Record<string, (v: unknown) => string | null> = {
  min_app_version: (v) => (typeof v === 'string' && compareVersions(v, '0.0.0') !== null ? null : '必须是版本号字符串，如 "1.0.0"'),
  latest_app_version: (v) => (typeof v === 'string' && compareVersions(v, '0.0.0') !== null ? null : '必须是版本号字符串，如 "1.2.0"'),
  features: (v) => (isObj(v) ? null : '必须是对象'),
  limits: (v) => (isObj(v) ? null : '必须是对象'),
  adapters: (v) => adaptersError(v),
  claude_catalog: (v) => catalogError(v),
  notice: (v) =>
    v === null || (isObj(v) && typeof (v as Record<string, unknown>).text === 'string' && typeof (v as Record<string, unknown>).level === 'string')
      ? null
      : '必须是 null 或 {"level": "...", "text": "..."}',
};

/**
 * 输入适配器里会原样写进被控端 PTY 的三个字符串只允许这几种取值（与客户端 adapter.rs 的白名单一致）。
 * 任意字符串（例如 "\r;id>x;\r"）一旦下发，等于在被控端注入命令（安全审查 H1）。
 */
export const NEWLINE_WHITELIST = ['\r', '\n', '\r\n', '\\\r'];

function adaptersError(v: unknown): string | null {
  const shape = '必须是数组（1–32 项），每项是带 id（字符串）和 match（对象）的适配器规则';
  if (!Array.isArray(v) || v.length === 0 || v.length > 32) return shape;
  for (const x of v) {
    if (!isObj(x) || typeof x.id !== 'string' || !x.id || !isObj(x.match)) return shape;
    for (const k of ['newline_in_paste', 'submit_key', 'fallback_newline']) {
      if (x[k] !== undefined && !(typeof x[k] === 'string' && NEWLINE_WHITELIST.includes(x[k] as string))) {
        return `${x.id}：${k} 只允许 CR、LF、CRLF、反斜杠加 CR 这四种取值`;
      }
    }
    if (x.paste !== undefined && !['bracketed', 'raw', 'auto'].includes(x.paste as string)) return `${x.id}：paste 只能是 bracketed | raw | auto`;
    for (const k of ['submit_delay_ms', 'attach_gap_ms']) {
      const n = x[k];
      if (n !== undefined && !(typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 5000)) return `${x.id}：${k} 必须是 0–5000 的整数`;
    }
  }
  return null;
}

const CATALOG_MAX_BYTES = 256 * 1024;

/** 目录里任何字符串都不允许含控制字符（包括 ESC、C1），模板长度另由客户端限制 */
function hasControl(v: unknown): boolean {
  if (typeof v === 'string') return /[\u0000-\u001f\u007f-\u009f]/.test(v);
  if (Array.isArray(v)) return v.some(hasControl);
  if (isObj(v)) return Object.entries(v).some(([k, x]) => hasControl(k) || hasControl(x));
  return false;
}

function catalogError(v: unknown): string | null {
  if (!Array.isArray(v) || !v.every(isObj)) return '必须是数组（每份目录是对象，带版本范围，见实现方案 18.5）';
  if (JSON.stringify(v).length > CATALOG_MAX_BYTES) return '目录过大（上限 256KB）';
  if (hasControl(v)) return '目录里不允许出现控制字符（含 ESC）';
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** /v1/config 的内容：app_config 表的值覆盖代码里的默认值，进程内缓存 60 秒 */
export class ConfigService {
  private cache: { at: number; value: PublicConfig } | null = null;
  private signer: ConfigSigner | null = null;

  constructor(
    private cfg: Config,
    private repos: Repos,
    private log: Log,
    private ttlMs = 60_000,
  ) {
    if (cfg.configSigningKey) {
      this.signer = signerFromSeed(cfg.configSigningKey);
      log.info({ config_pubkey: this.signer.publicKeyB64 }, '配置签名已启用（公钥应与客户端内置的一致）');
    } else log.warn('未配置 CONFIG_SIGNING_KEY：/v1/config 不带 config_sig，客户端会忽略下发的 adapters / claude_catalog，只用内置规则');
  }

  /** 签名公钥（base64），未配置密钥时为 null；启动日志里打印，方便写进客户端常量 */
  get signingPublicKey(): string | null {
    return this.signer?.publicKeyB64 ?? null;
  }

  private signed(value: PublicConfig): PublicConfig {
    if (!this.signer) return value;
    return { ...value, config_sig: this.signer.sign(value.adapters, value.claude_catalog) };
  }

  invalidate(): void {
    this.cache = null;
  }

  defaults(): PublicConfig {
    return {
      signal_url: this.cfg.signalPublicUrl,
      min_app_version: this.cfg.minAppVersion,
      latest_app_version: this.cfg.latestAppVersion,
      features: { file_upload: true },
      limits: { max_file_size: 200 * 1024 * 1024 },
      adapters: structuredClone(DEFAULT_ADAPTERS),
      claude_catalog: [],
      notice: null,
    };
  }

  async get(): Promise<PublicConfig> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.value;
    const value = this.defaults();
    try {
      const entries = await withTimeout(this.repos.appConfig.getAll(), 3000, 'app_config 查询');
      const m = new Map(entries.map((e) => [e.key, e.value]));
      if (typeof m.get('min_app_version') === 'string') value.min_app_version = m.get('min_app_version') as string;
      if (isObj(m.get('features'))) value.features = { ...value.features, ...(m.get('features') as object) };
      if (isObj(m.get('limits'))) value.limits = { ...value.limits, ...(m.get('limits') as object) };
      if (Array.isArray(m.get('adapters'))) value.adapters = m.get('adapters') as unknown[];
      if (Array.isArray(m.get('claude_catalog'))) value.claude_catalog = m.get('claude_catalog') as unknown[];
      if (m.has('notice')) value.notice = (m.get('notice') as PublicConfig['notice']) ?? null;
      // 最新版本：显式配置 > 已发布版本里最高的 > 默认
      if (typeof m.get('latest_app_version') === 'string') {
        value.latest_app_version = m.get('latest_app_version') as string;
      } else {
        const rels = await withTimeout(this.repos.releases.list({ kind: 'desktop', channel: 'stable', limit: 200 }), 3000, 'app_releases 查询');
        let best = value.latest_app_version;
        for (const r of rels) if (r.status === 1 && compareVersions(r.version, best) === 1) best = r.version;
        value.latest_app_version = best;
      }
    } catch (err) {
      // 数据库不可用：继续用旧缓存，没有就用默认值
      this.log.warn({ err: (err as Error).message }, '读取 app_config 失败，使用缓存或默认配置');
      if (this.cache) return this.cache.value;
    }
    const out = this.signed(value);
    this.cache = { at: now, value: out };
    return out;
  }
}
