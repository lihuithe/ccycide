import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, postRegister, registerNew } from '../tools/rterm-client.js';
import { startStack, type Stack } from './helpers.js';

const auth = { authorization: 'Bearer test-admin-token' };

describe('设备注册接口 POST /v1/devices/register（T3）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  it('用 Node 生成密钥对、签名、调用接口：返回 9 位设备码，库里多了一行', async () => {
    const kp = generateKeyPair();
    const r = await postRegister(s.http, kp);
    expect(r.status).toBe(200);
    expect(r.body.device_code).toMatch(/^[1-9]\d{8}$/);
    expect(r.body.device_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    const row = await s.repos.devices.findByUid(r.body.device_id!);
    expect(row).toMatchObject({ code: r.body.device_code, platform: 'windows', arch: 'x86_64', kind: 'desktop' });
    expect(row!.publicKey.equals(kp.publicKeyRaw)).toBe(true);
    expect(row!.registerIp).toEqual(Buffer.from([127, 0, 0, 1]));
  });

  it('同一公钥再调一次：返回相同的 device_id 和设备码，不新增行，并更新版本信息', async () => {
    const kp = generateKeyPair();
    const a = await postRegister(s.http, kp, { appVersion: '1.0.0', osVersion: '10.0.1' });
    const before = (await s.repos.devices.search({ limit: 1, offset: 0 })).total;
    const b = await postRegister(s.http, kp, { appVersion: '1.1.0', osVersion: '10.0.2', platform: 'linux' });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await s.repos.devices.search({ limit: 1, offset: 0 })).total).toBe(before);
    const row = await s.repos.devices.findByUid(a.body.device_id!);
    expect(row).toMatchObject({ appVersion: '1.1.0', osVersion: '10.0.2', platform: 'linux' });
  });

  it('并发注册同一公钥：全部得到同一个设备码', async () => {
    const kp = generateKeyPair();
    const rs = await Promise.all(Array.from({ length: 5 }, () => postRegister(s.http, kp)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.device_code)).size).toBe(1);
  });

  it('签名改错一个字节：401 BAD_SIGNATURE，统一错误格式', async () => {
    const r = await postRegister(s.http, generateKeyPair(), { tamperSignature: true });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(typeof r.body.error!.message).toBe('string');
  });

  it('用别人的签名（签名与公钥不匹配）被拒', async () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    const ts = Math.floor(Date.now() / 1000);
    // 公钥填 A，但让 B 去签
    const { registerSignString } = await import('../src/crypto.js');
    const { signB64 } = await import('../tools/rterm-client.js');
    const pk = kpA.publicKeyRaw.toString('base64');
    const signature = signB64(kpB.privateKey, registerSignString({ publicKeyB64: pk, platform: 'windows', arch: 'x86_64', kind: 'desktop', ts }));
    const res = await fetch(`${s.http}/v1/devices/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_key: pk, platform: 'windows', arch: 'x86_64', kind: 'desktop', ts, signature }),
    });
    expect(res.status).toBe(401);
  });

  it('ts 改成一小时前 / 一小时后：400 BAD_TIMESTAMP', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const ts of [now - 3600, now + 3600, now - 301]) {
      const r = await postRegister(s.http, generateKeyPair(), { ts });
      expect(r.status).toBe(400);
      expect(r.body.error!.code).toBe('BAD_TIMESTAMP');
    }
    // 边界内可以
    expect((await postRegister(s.http, generateKeyPair(), { ts: now - 290 })).status).toBe(200);
  });

  it('字段不合法：400 BAD_REQUEST', async () => {
    for (const o of [{ platform: 'plan9' }, { arch: 'mips' }, { kind: 'phone' }]) {
      const r = await postRegister(s.http, generateKeyPair(), o);
      expect(r.status).toBe(400);
      expect(r.body.error!.code).toBe('BAD_REQUEST');
    }
    // 缺字段、公钥长度不对、不是 JSON
    const post = (body: string, ct = 'application/json') => fetch(`${s.http}/v1/devices/register`, { method: 'POST', headers: { 'content-type': ct }, body });
    expect((await post('{}')).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    const kp = generateKeyPair();
    const short = await post(JSON.stringify({ public_key: Buffer.alloc(31).toString('base64'), platform: 'windows', arch: 'x86_64', kind: 'desktop', ts: Math.floor(Date.now() / 1000), signature: Buffer.alloc(64).toString('base64') }));
    expect(short.status).toBe(400);
    void kp;
    const j = (await (await post('{}')).json()) as { error: { code: string } };
    expect(j.error.code).toBe('BAD_REQUEST');
  });

  it('请求体过大被拒（413）', async () => {
    const res = await fetch(`${s.http}/v1/devices/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(20_000) }) });
    expect(res.status).toBe(413);
  });
});

describe('注册接口按 IP 限流（6.6：每小时 10 次）', () => {
  it('默认阈值是 10：前 10 次通过，第 11 次 429 RATE_LIMITED 并带 retry_after', async () => {
    const s = await startStack({ tunables: { registerPerHourPerIp: 10 } });
    try {
      for (let i = 0; i < 10; i++) expect((await postRegister(s.http, generateKeyPair())).status).toBe(200);
      const r = await postRegister(s.http, generateKeyPair());
      expect(r.status).toBe(429);
      expect(r.body.error!.code).toBe('RATE_LIMITED');
      expect(r.body.error!.retry_after).toBeGreaterThan(0);
    } finally {
      await s.stop();
    }
  });
});

describe('被封禁的 IP 不能注册', () => {
  it('bans 里有 IP 封禁时返回 403 BANNED', async () => {
    const s = await startStack();
    try {
      await s.repos.bans.add({ kind: 'cidr', value: '127.0.0.0/8', reason: 'test', source: 'manual', expiresAt: null, createdBy: 't' });
      const r = await postRegister(s.http, generateKeyPair());
      expect(r.status).toBe(403);
      expect(r.body.error!.code).toBe('BANNED');
    } finally {
      await s.stop();
    }
  });
});

describe('健康检查、指标、404', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  it('GET /v1/healthz 返回 {"ok":true}', async () => {
    const res = await fetch(`${s.http}/v1/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await fetch(`${s.http}/healthz`)).status).toBe(200);
  });
  it('中继的 /healthz', async () => {
    const res = await fetch(`${s.relayUrl.replace('ws', 'http')}/healthz`);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('/metrics 是 Prometheus 文本，含内存与事件循环延迟', async () => {
    await registerNew(s.http);
    const res = await fetch(`${s.http}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const t = await res.text();
    expect(t).toContain('process_resident_memory_bytes');
    expect(t).toContain('nodejs_eventloop_lag_p99_seconds');
    expect(t).toMatch(/rterm_register_total\{result="created"\} \d+/);
  });
  it('未知路径 404，仍是统一错误格式', async () => {
    const res = await fetch(`${s.http}/v1/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('配置接口 GET /v1/config（T7、6.7、18.11）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ cfg: { signalPublicUrl: 'wss://signal.example.com/v1/signal', minAppVersion: '1.0.0', latestAppVersion: '1.2.0' } });
  });
  afterAll(() => s.stop());

  it('表里没有数据时返回代码里的默认值，字段齐全', async () => {
    const c = (await (await fetch(`${s.http}/v1/config`)).json()) as Record<string, any>;
    expect(c.signal_url).toBe('wss://signal.example.com/v1/signal');
    expect(c.min_app_version).toBe('1.0.0');
    expect(c.latest_app_version).toBe('1.2.0');
    expect(c.features).toEqual({ file_upload: true });
    expect(c.limits).toEqual({ max_file_size: 209715200 });
    expect(c.claude_catalog).toEqual([]);
    expect(c.notice).toBeNull();
    // 适配器规则：与实现方案 5.5.4 一致
    expect(c.adapters.map((a: any) => a.id)).toEqual(['claude-code', 'generic']);
    expect(c.adapters[0]).toEqual({
      id: 'claude-code', match: { profile: 'CLAUDE' }, paste: 'bracketed', newline_in_paste: '\n', submit_delay_ms: 80,
      submit_key: '\r', fallback_newline: '\\\r', auto_passthrough_on_alt_screen: false, attach_separate: true, attach_gap_ms: 150,
    });
    expect(c.adapters[1]).toMatchObject({ id: 'generic', match: {}, paste: 'auto', submit_delay_ms: 30, auto_passthrough_on_alt_screen: true });
  });

  it('通过管理接口修改后，清缓存立即生效；claude_catalog 从 app_config 读取', async () => {
    const put = (key: string, value: unknown) =>
      fetch(`${s.http}/v1/admin/config/${key}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ value, remark: 't' }) });
    expect((await put('claude_catalog', [{ app: 'claude', versions: '>=2.1.0', actions: [] }])).status).toBe(200);
    expect((await put('min_app_version', '1.5.0')).status).toBe(200);
    expect((await put('features', { file_upload: false, extra: 1 })).status).toBe(200);
    expect((await put('notice', { level: 'info', text: '维护通知' })).status).toBe(200);
    const c = (await (await fetch(`${s.http}/v1/config`)).json()) as Record<string, any>;
    expect(c.claude_catalog).toHaveLength(1);
    expect(c.min_app_version).toBe('1.5.0');
    expect(c.features).toEqual({ file_upload: false, extra: 1 });
    expect(c.notice).toEqual({ level: 'info', text: '维护通知' });
    // 非法值被拒
    expect((await put('claude_catalog', 'x')).status).toBe(400);
    expect((await put('adapters', [{ nope: 1 }])).status).toBe(400);
    expect((await put('unknown_key', 1)).status).toBe(400);
  });

  it('配置缓存 60 秒：直接改库后不清缓存则读到旧值', async () => {
    const s2 = await startStack();
    try {
      const before = (await (await fetch(`${s2.http}/v1/config`)).json()) as Record<string, any>;
      await s2.repos.appConfig.set('limits', { max_file_size: 1 }, '', 'test');
      const cached = (await (await fetch(`${s2.http}/v1/config`)).json()) as Record<string, any>;
      expect(cached.limits).toEqual(before.limits);
      s2.ctx.configService.invalidate();
      const fresh = (await (await fetch(`${s2.http}/v1/config`)).json()) as Record<string, any>;
      expect(fresh.limits.max_file_size).toBe(1);
    } finally {
      await s2.stop();
    }
  });
});

describe('更新接口 GET /v1/update/:target/:arch/:version（T34、12.4）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  const publish = (over: Record<string, unknown> = {}) =>
    fetch(`${s.http}/v1/admin/releases`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.2.0', platform: 'windows', arch: 'x86_64', download_url: 'https://dl.example.com/rterm-1.2.0.exe', signature: 'SIGBASE64', notes: '修复若干问题', ...over }),
    });

  it('没有发布时返回 204', async () => {
    expect((await fetch(`${s.http}/v1/update/windows/x86_64/1.0.0`)).status).toBe(204);
  });

  it('有更新时返回 Tauri updater 要求的 JSON；已是最新或更高返回 204', async () => {
    expect((await publish()).status).toBe(200);
    const res = await fetch(`${s.http}/v1/update/windows/x86_64/1.0.0`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, string>;
    expect(j).toMatchObject({ version: '1.2.0', url: 'https://dl.example.com/rterm-1.2.0.exe', signature: 'SIGBASE64', notes: '修复若干问题' });
    expect(new Date(j.pub_date!).toString()).not.toBe('Invalid Date');
    expect((await fetch(`${s.http}/v1/update/windows/x86_64/1.2.0`)).status).toBe(204);
    expect((await fetch(`${s.http}/v1/update/windows/x86_64/1.3.0`)).status).toBe(204);
    // 其他平台没有
    expect((await fetch(`${s.http}/v1/update/linux/x86_64/1.0.0`)).status).toBe(204);
    expect((await fetch(`${s.http}/v1/update/windows/aarch64/1.0.0`)).status).toBe(204);
  });

  it('Tauri 的 target=darwin 对应库里的 macos', async () => {
    expect((await publish({ platform: 'macos', arch: 'aarch64', version: '1.2.0' })).status).toBe(200);
    expect((await fetch(`${s.http}/v1/update/darwin/aarch64/1.0.0`)).status).toBe(200);
  });

  it('撤回后不再返回；同一版本重复发布 409', async () => {
    const dup = await publish();
    expect(dup.status).toBe(409);
    const list = (await (await fetch(`${s.http}/v1/admin/releases`, { headers: auth })).json()) as { items: Array<{ id: number; platform: string }> };
    const win = list.items.find((r) => r.platform === 'windows')!;
    expect((await fetch(`${s.http}/v1/admin/releases/${win.id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ status: 0 }) })).status).toBe(200);
    expect((await fetch(`${s.http}/v1/update/windows/x86_64/1.0.0`)).status).toBe(204);
  });

  it('灰度：5% 时只有部分设备收到更新，调到 100% 后全部收到', async () => {
    expect((await publish({ version: '2.0.0', rollout_percent: 5 })).status).toBe(200);
    let got = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${s.http}/v1/update/windows/x86_64/1.0.0?device_id=dev-${i}`);
      if (res.status === 200) got++;
    }
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(40);
    const list = (await (await fetch(`${s.http}/v1/admin/releases?platform=windows`, { headers: auth })).json()) as { items: Array<{ id: number; version: string }> };
    const r2 = list.items.find((r) => r.version === '2.0.0')!;
    await fetch(`${s.http}/v1/admin/releases/${r2.id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ rollout_percent: 100 }) });
    for (let i = 0; i < 20; i++) {
      expect((await fetch(`${s.http}/v1/update/windows/x86_64/1.0.0?device_id=dev-${i}`)).status).toBe(200);
    }
  });

  it('latest_app_version 取已发布的最高版本', async () => {
    const c = (await (await fetch(`${s.http}/v1/config`)).json()) as { latest_app_version: string };
    expect(c.latest_app_version).toBe('2.0.0');
  });
});
