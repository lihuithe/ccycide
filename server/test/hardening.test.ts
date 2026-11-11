import { createPublicKey, verify } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalError, generateSeedB64, signedConfigBytes, signerFromSeed } from '../src/config-sign.js';
import { DEV_TICKET_SECRET, loadConfig, ConfigError } from '../src/config.js';
import { Counter, MAX_SERIES } from '../src/metrics.js';
import { registerDevice } from '../src/service/registration.js';
import { GUARD, Guard } from '../src/service/guard.js';
import { MemoryKvStore } from '../src/store/kv.js';
import { metricMsgType } from '../src/signal/protocol.js';
import { rateKeyIp } from '../src/util/ip.js';
import { sleep, startStack, until, onlineDevice, type Stack } from './helpers.js';

/** 与 Rust 端（crates/rterm-core/src/config_sig.rs）共用的测试向量 */
const VEC = {
  seed: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  pub: 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
  adapters: [{ id: 'a', match: { profile: 'CLAUDE' }, paste: 'bracketed', newline_in_paste: '\n', submit_delay_ms: 80, submit_key: '\r', fallback_newline: '\\\r' }],
  catalog: [{ catalog_ver: 't1', app: 'claude', actions: [{ id: 'x.y', title: '标题 \u{1F600}', steps: [{ submit: '/clear' }] }] }],
  canonical:
    '{"adapters":[{"fallback_newline":"\\\\\\r","id":"a","match":{"profile":"CLAUDE"},"newline_in_paste":"\\n","paste":"bracketed","submit_delay_ms":80,"submit_key":"\\r"}],"claude_catalog":[{"actions":[{"id":"x.y","steps":[{"submit":"/clear"}],"title":"标题 😀"}],"app":"claude","catalog_ver":"t1"}]}',
  sig: 'Ns39bjnoajMv83LcqiBd2QJGzdoRhj/bQHb8bKHTDJc6+HEbIhYh5uK6ljj7pomhqniLLDH9rQb5Yd6N4b1pDQ==',
};

function verifyRaw(pubB64: string, msg: Buffer, sigB64: string): boolean {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubB64, 'base64')]);
  return verify(null, msg, createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sigB64, 'base64'));
}

describe('H1：配置签名', () => {
  it('规范化：键排序、紧凑、字符串转义、只允许整数', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x"y\\z\n'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x\\"y\\\\z\\n"],"b":1,"c":{"y":2,"z":1}}');
    expect(canonicalJson({ k: undefined, a: 1 })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalError);
    // 与 UTF-16 码元顺序一致（JCS）
    expect(canonicalJson({ '\u{1F600}': 1, '\uffff': 2 })).toBe('{"\u{1F600}":1,"\uffff":2}');
  });

  it('测试向量：规范化结果、公钥和签名与 Rust 端共用的值一致', () => {
    expect(canonicalJson({ adapters: VEC.adapters, claude_catalog: VEC.catalog })).toBe(VEC.canonical);
    const s = signerFromSeed(VEC.seed);
    expect(s.publicKeyB64).toBe(VEC.pub);
    expect(s.sign(VEC.adapters, VEC.catalog)).toBe(VEC.sig);
    expect(signedConfigBytes(VEC.adapters, VEC.catalog).toString('utf8')).toBe('rterm-config-v1\n' + VEC.canonical);
  });

  it('seed 长度不对抛错；generateSeedB64 是 32 字节', () => {
    expect(() => signerFromSeed('AAAA')).toThrow();
    expect(Buffer.from(generateSeedB64(), 'base64')).toHaveLength(32);
  });

  describe('/v1/config', () => {
    let s: Stack;
    let plain: Stack;
    beforeAll(async () => {
      s = await startStack({ cfg: { configSigningKey: VEC.seed } });
      plain = await startStack();
    });
    afterAll(async () => {
      await s.stop();
      await plain.stop();
    });

    it('配置了密钥：config_sig 对 adapters + claude_catalog 的规范化 JSON 验签通过', async () => {
      const c = (await (await fetch(`${s.http}/v1/config`)).json()) as { adapters: unknown[]; claude_catalog: unknown[]; config_sig: string };
      expect(typeof c.config_sig).toBe('string');
      expect(verifyRaw(VEC.pub, signedConfigBytes(c.adapters, c.claude_catalog), c.config_sig)).toBe(true);
      // 内容被改动就验不过
      const tampered = structuredClone(c.adapters) as Array<Record<string, unknown>>;
      tampered[0]!.submit_key = '\n';
      expect(verifyRaw(VEC.pub, signedConfigBytes(tampered, c.claude_catalog), c.config_sig)).toBe(false);
    });

    it('通过管理接口改了目录，签名随之变化且仍然有效', async () => {
      const auth = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      const before = (await (await fetch(`${s.http}/v1/config`)).json()) as { config_sig: string };
      const cat = [{ catalog_ver: 'x', app: 'claude', actions: [] }];
      expect((await fetch(`${s.http}/v1/admin/config/claude_catalog`, { method: 'PUT', headers: auth, body: JSON.stringify({ value: cat, remark: 't' }) })).status).toBe(200);
      const after = (await (await fetch(`${s.http}/v1/config`)).json()) as { adapters: unknown[]; claude_catalog: unknown[]; config_sig: string };
      expect(after.config_sig).not.toBe(before.config_sig);
      expect(verifyRaw(VEC.pub, signedConfigBytes(after.adapters, after.claude_catalog), after.config_sig)).toBe(true);
    });

    it('没配置密钥：不带 config_sig（客户端据此只用内置规则）', async () => {
      const c = (await (await fetch(`${plain.http}/v1/config`)).json()) as Record<string, unknown>;
      expect('config_sig' in c).toBe(false);
    });

    it('管理接口拒绝危险的适配器规则与目录（纵深防御）', async () => {
      const auth = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      const put = (key: string, value: unknown) => fetch(`${s.http}/v1/admin/config/${key}`, { method: 'PUT', headers: auth, body: JSON.stringify({ value, remark: 't' }) });
      const rule = (over: object) => [{ id: 'x', match: {}, ...over }];
      // 报告 H1 的两个复现点
      expect((await put('adapters', rule({ fallback_newline: '\r;id>x;\r' }))).status).toBe(400);
      expect((await put('adapters', rule({ newline_in_paste: '\u001b[20' }))).status).toBe(400);
      expect((await put('adapters', rule({ submit_key: '\r;calc\r' }))).status).toBe(400);
      expect((await put('adapters', rule({ submit_delay_ms: 99999 }))).status).toBe(400);
      expect((await put('adapters', rule({ paste: 'weird' }))).status).toBe(400);
      // 白名单内的取值通过
      for (const v of ['\r', '\n', '\r\n', '\\\r']) expect((await put('adapters', rule({ newline_in_paste: v, submit_key: '\r', fallback_newline: v }))).status).toBe(200);
      // 目录里的控制字符（含 ESC）被拒
      expect((await put('claude_catalog', [{ catalog_ver: 'x', app: 'claude', actions: [{ steps: [{ submit: '!\u001b[201~calc' }] }] }])).status).toBe(400);
      expect((await put('claude_catalog', [{ catalog_ver: 'x', app: 'claude', actions: [{ steps: [{ submit: 'a\rb' }] }] }])).status).toBe(400);
      expect((await put('claude_catalog', [{ catalog_ver: 'x', app: 'claude', actions: [] }])).status).toBe(200);
    });
  });

  it('CONFIG_SIGNING_KEY 格式不对：启动报错', () => {
    expect(() => loadConfig({ STORE: 'memory', CONFIG_SIGNING_KEY: 'not-32-bytes' })).toThrow(ConfigError);
    expect(loadConfig({ STORE: 'memory', CONFIG_SIGNING_KEY: VEC.seed }).configSigningKey).toBe(VEC.seed);
  });
});

describe('M1：IPv6 限流按 /64 归一', () => {
  it('rateKeyIp', () => {
    expect(rateKeyIp('1.2.3.4')).toBe('1.2.3.4');
    expect(rateKeyIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(rateKeyIp('::ffff:102:304')).toBe('1.2.3.4');
    expect(rateKeyIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateKeyIp('2001:db8:1:2::1')).toBe(rateKeyIp('2001:DB8:1:2:ffff::2'));
    expect(rateKeyIp('2001:db8:1:3::1')).not.toBe(rateKeyIp('2001:db8:1:2::1'));
    expect(rateKeyIp('2001:db8::1%eth0')).toBe('2001:db8:0:0::/64');
    expect(rateKeyIp('fe80::1')).toBe('fe80:0:0:0::/64');
  });

  it('同一 /64 内换地址不能绕过注册限流；IPv4 不受影响', async () => {
    const s = await startStack({ tunables: { registerPerHourPerIp: 2 } });
    try {
      const input = { public_key: '', signature: '', platform: 'x', arch: 'x', kind: 'x', ts: 0 } as never;
      const codes: number[] = [];
      for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:dead:beef:0:3', '2001:db8:1:2:ffff:ffff:ffff:ffff']) {
        const r = await registerDevice(s.ctx, input, ip);
        codes.push(r.ok ? 200 : r.status);
      }
      // 前两次通过限流（随后因字段非法返回 400），第三、四次同一 /64 被限流
      expect(codes).toEqual([400, 400, 429, 429]);
      // 另一个 /64 和 IPv4 各有各的额度
      expect((await registerDevice(s.ctx, input, '2001:db8:1:9::1')).ok).toBe(false);
      expect(((await registerDevice(s.ctx, input, '9.9.9.9')) as { status: number }).status).toBe(400);
    } finally {
      await s.stop();
    }
  });
});

describe('M2：信令消息类型指标', () => {
  it('metricMsgType 白名单', () => {
    for (const t of ['auth', 'ping', 'presence.update', 'connect.request', 'connect.accept', 'connect.reject', 'connect.cancel', 'session.report']) {
      expect(metricMsgType(t)).toBe(t);
    }
    expect(metricMsgType('random-123')).toBe('other');
    expect(metricMsgType('')).toBe('other');
  });

  it('Counter 序列数有上限，超出合并到 overflow', () => {
    const c = new Counter('x', 'x');
    for (let i = 0; i < MAX_SERIES + 50; i++) c.inc({ t: `k${i}` });
    const lines = c.render().filter((l) => !l.startsWith('#'));
    expect(lines.length).toBe(MAX_SERIES + 1);
    expect(c.get({ overflow: 'true' })).toBe(50);
    c.inc({ t: 'k0' });
    expect(c.get({ t: 'k0' })).toBe(2);
  });

  describe('端到端', () => {
    let s: Stack;
    beforeAll(async () => {
      s = await startStack();
    });
    afterAll(() => s.stop());

    it('认证前发任意类型：不产生指标序列；认证后未知类型归为 other', async () => {
      const ws = new WebSocket(s.ws);
      ws.on('error', () => {});
      await new Promise<void>((res) => ws.once('open', () => res()));
      ws.send(JSON.stringify({ t: 'zz_pre_auth_type_1' }));
      await until(() => ws.readyState === WebSocket.CLOSED, 3000, '未认证消息导致断开');
      const { sig } = await onlineDevice(s);
      sig.sendRaw({ t: 'zz_post_auth_type_2' });
      sig.sendRaw({ t: 'ping' });
      await until(() => /rterm_signal_messages_total\{t="other"\} [1-9]/.test(s.ctx.metrics.render()), 3000, 'other 计数');
      const text = s.ctx.metrics.render();
      expect(text).not.toContain('zz_pre_auth_type_1');
      expect(text).not.toContain('zz_post_auth_type_2');
      expect(text).toMatch(/rterm_signal_messages_total\{t="ping"\} [1-9]/);
      // 认证消息本身（认证前）不按类型计数
      expect(text).not.toMatch(/rterm_signal_messages_total\{t="auth"\}/);
      sig.close();
    });
  });
});

describe('M4（服务端侧）：锁定级别封顶后不归零', () => {
  it('levelResetMs 远大于封顶锁定时长；封顶锁定结束后再触发仍是 24 小时', async () => {
    expect(GUARD.levelResetMs).toBeGreaterThanOrEqual(7 * 24 * 3600_000);
    let now = 1_000_000;
    const kv = new MemoryKvStore(() => now);
    try {
      const g = new Guard(kv);
      const round = async (): Promise<number> => {
        let r = { locked: false, lockSec: 0 };
        for (let i = 0; i < GUARD.failThreshold; i++) r = await g.recordAuthFailure('111222333');
        return r.lockSec;
      };
      const secs: number[] = [];
      for (let i = 0; i < 12; i++) {
        secs.push(await round());
        now += secs[secs.length - 1]! * 1000 + 1000; // 等锁定结束
      }
      expect(secs[0]).toBe(600);
      expect(Math.max(...secs)).toBe(GUARD.lockMaxSec);
      // 第 9 轮起一直是 24 小时，不会掉回 10 分钟
      expect(secs.slice(8)).toEqual([86400, 86400, 86400, 86400]);
      // 7 天没有失败：级别衰减
      now += 7 * 24 * 3600_000 + 1000;
      expect(await round()).toBe(600);
    } finally {
      kv.stop();
    }
  });
});

describe('L10：服务端细节', () => {
  it('NODE_ENV=production 使用开发默认票据密钥：拒绝启动', () => {
    const env = { STORE: 'memory', NODE_ENV: 'production' };
    expect(() => loadConfig({ ...env, TICKET_SECRET: DEV_TICKET_SECRET })).toThrow(/开发默认/);
    expect(() => loadConfig({ ...env, TICKET_SECRET: 'a-long-random-secret-value-1234', TICKET_SECRET_OLD: DEV_TICKET_SECRET })).toThrow(/开发默认/);
    expect(() => loadConfig(env)).toThrow(/TICKET_SECRET/);
    expect(loadConfig({ ...env, TICKET_SECRET: 'a-long-random-secret-value-1234' }).ticketSecret).toHaveLength(31);
    // ADMIN_TOKEN：生产环境至少 32 个字符；不设置（关闭管理接口）仍然允许
    const ok = { ...env, TICKET_SECRET: 'a-long-random-secret-value-1234' };
    expect(() => loadConfig({ ...ok, ADMIN_TOKEN: 'short-token' })).toThrow(/ADMIN_TOKEN/);
    expect(loadConfig({ ...ok, ADMIN_TOKEN: 'x'.repeat(32) }).adminToken).toHaveLength(32);
    expect(loadConfig(ok).adminToken).toBe('');
    // 开发环境仍可回落到默认密钥
    expect(loadConfig({ STORE: 'memory' }).ticketSecret).toBe(DEV_TICKET_SECRET);
  });

  describe('HTTP', () => {
    let s: Stack;
    beforeAll(async () => {
      s = await startStack({ tunables: { publicPerMinIp: 3 } });
    });
    afterAll(() => s.stop());

    it('download_url 只接受 https', async () => {
      const post = (download_url: string) =>
        fetch(`${s.http}/v1/admin/releases`, {
          method: 'POST',
          headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
          body: JSON.stringify({ version: '9.0.0', platform: 'windows', arch: 'x86_64', download_url, signature: 'sig' }),
        });
      expect((await post('http://dl.example.com/a.exe')).status).toBe(400);
      expect((await post('https://dl.example.com/a.exe')).status).toBe(200);
    });

    it('JSON 请求体含 __proto__ 键：400（原型污染防护）', async () => {
      const r = await fetch(`${s.http}/v1/devices/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"x":1},"a":1}' });
      expect(r.status).toBe(400);
      // 空请求体仍按 {} 处理
      expect((await fetch(`${s.http}/v1/admin/devices/111222333/unban`, { method: 'POST', headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' } })).status).not.toBe(400);
    });

    it('/v1/config 与 /v1/update 有按来源的限流', async () => {
      await sleep(5);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.http}/v1/config`)).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      const u: number[] = [];
      for (let i = 0; i < 5; i++) u.push((await fetch(`${s.http}/v1/update/windows/x86_64/0.1.0`)).status);
      expect(u.filter((c) => c === 429)).toHaveLength(2);
    });
  });
});
