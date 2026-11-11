import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError, DEFAULT_TUNABLES } from '../src/config.js';
import { authSignString, decodeB64Exact, isTooRegular, newDeviceCode, registerSignString, verifyEd25519 } from '../src/crypto.js';
import { planPartitionChanges } from '../src/jobs/partitions.js';
import { TokenBucket } from '../src/relay/limiter.js';
import { signTicket, verifyTicket } from '../src/relay/ticket.js';
import { rolloutBucket, pickRelease } from '../src/api/update.js';
import { bufferToIp, clientIp, createTrustChecker, ipInCidr, ipToBuffer, normalizeIp } from '../src/util/ip.js';
import { compareVersions, versionLt } from '../src/util/version.js';
import { protoCompatible, parseMsg } from '../src/signal/protocol.js';
import { tokenMatches } from '../src/api/admin.js';

describe('设备码生成（T3）', () => {
  it('生成 1 万个：都是 9 位、首位非 0、没有规律号', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const c = newDeviceCode();
      expect(c).toMatch(/^[1-9]\d{8}$/);
      expect(isTooRegular(c)).toBe(false);
      seen.add(c);
    }
    // 9 亿空间里抽 1 万个，基本不会重复
    expect(seen.size).toBeGreaterThan(9990);
  });

  it('规律号码被识别', () => {
    for (const c of ['111111111', '222222222', '123456789', '987654321', '234567890', '876543210']) {
      expect(isTooRegular(c)).toBe(true);
    }
    for (const c of ['123456780', '482913675', '100000000']) expect(isTooRegular(c)).toBe(false);
  });
});

describe('Ed25519 签名校验', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  const msg = Buffer.from('rterm-auth-v1\nnonce\ndev', 'utf8');
  const sig = sign(null, msg, privateKey);

  it('正确签名通过', () => expect(verifyEd25519(raw, msg, sig)).toBe(true));
  it('改动任意一个字节都失败', () => {
    for (const i of [0, 31, 63]) {
      const bad = Buffer.from(sig);
      bad[i] = bad[i]! ^ 1;
      expect(verifyEd25519(raw, msg, bad)).toBe(false);
    }
    expect(verifyEd25519(raw, Buffer.from('rterm-auth-v1\nnonce\ndex'), sig)).toBe(false);
  });
  it('公钥或签名长度不对返回 false 而不是抛异常', () => {
    expect(verifyEd25519(raw.subarray(0, 31), msg, sig)).toBe(false);
    expect(verifyEd25519(raw, msg, sig.subarray(0, 63))).toBe(false);
    expect(verifyEd25519(Buffer.alloc(32, 7), msg, sig)).toBe(false);
  });
  it('签名串格式与文档一致', () => {
    expect(registerSignString({ publicKeyB64: 'PK', platform: 'windows', arch: 'x86_64', kind: 'desktop', ts: 1731300000 })).toBe(
      'rterm-register-v1\nPK\nwindows\nx86_64\ndesktop\n1731300000',
    );
    expect(authSignString('N', 'D')).toBe('rterm-auth-v1\nN\nD');
  });
  it('base64 解码严格检查长度', () => {
    expect(decodeB64Exact(Buffer.alloc(32, 1).toString('base64'), 32)).not.toBeNull();
    expect(decodeB64Exact(Buffer.alloc(31, 1).toString('base64'), 32)).toBeNull();
    expect(decodeB64Exact('不是base64', 32)).toBeNull();
    expect(decodeB64Exact(123, 32)).toBeNull();
  });
});

describe('票据（T6）', () => {
  const secret = 'secret-a-0123456789';
  const base = { sid: '01SID', role: 'c' as const, did: '01DID', node: 'relay-01' };

  it('签发后可校验，字段完整', () => {
    const tk = signTicket(base, secret, 30, 1000);
    const v = verifyTicket(tk, [secret], 'relay-01', 1010);
    expect(v).toMatchObject({ ...base, exp: 1030 });
    expect(tk.split('.')).toHaveLength(2);
  });
  it('payload 被改动 / 签名被改动 / 密钥不对 都无效', () => {
    const tk = signTicket(base, secret, 30, 1000);
    const [p, s] = tk.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...base, role: 'h', exp: 1030 })).toString('base64url');
    expect(verifyTicket(`${forged}.${s}`, [secret], 'relay-01', 1010)).toBeNull();
    expect(verifyTicket(`${p}.${s.slice(0, -2)}AA`, [secret], 'relay-01', 1010)).toBeNull();
    expect(verifyTicket(tk, ['other-secret'], 'relay-01', 1010)).toBeNull();
  });
  it('过期、节点名不符、角色非法 都无效', () => {
    const tk = signTicket(base, secret, 30, 1000);
    expect(verifyTicket(tk, [secret], 'relay-01', 1031)).toBeNull();
    expect(verifyTicket(tk, [secret], 'relay-02', 1010)).toBeNull();
    const badRole = signTicket({ ...base, role: 'x' as 'c' }, secret, 30, 1000);
    expect(verifyTicket(badRole, [secret], 'relay-01', 1010)).toBeNull();
  });
  it('轮换：新旧密钥任一匹配都有效', () => {
    const old = signTicket(base, 'old-secret', 30, 1000);
    expect(verifyTicket(old, ['new-secret', 'old-secret'], 'relay-01', 1010)).not.toBeNull();
    expect(verifyTicket(old, ['new-secret', ''], 'relay-01', 1010)).toBeNull();
  });
  it('畸形输入返回 null 而不抛异常', () => {
    for (const t of ['', '.', 'a', 'a.b.c', 'a.', '.b', '%%%.%%%', 'x'.repeat(5000)]) {
      expect(verifyTicket(t, [secret], 'relay-01')).toBeNull();
    }
  });
});

describe('令牌桶', () => {
  it('突发额度内不等待，超出后按速率计算等待时间', () => {
    let now = 0;
    const b = new TokenBucket(1000, 2000, () => now);
    expect(b.take(2000)).toBe(0);
    expect(b.take(500)).toBe(500); // 欠 500 字节，速率 1000B/s
    now += 500;
    expect(b.take(0)).toBe(0);
    now += 10_000;
    expect(b.take(2000)).toBe(0); // 最多恢复到 burst
    expect(b.take(1)).toBeGreaterThan(0);
  });
});

describe('配置读取', () => {
  it('默认值来自实现方案 17.1', () => {
    const t = DEFAULT_TUNABLES;
    expect(t.authTimeoutMs).toBe(5000);
    expect(t.idleTimeoutMs).toBe(45_000);
    expect(t.presenceTtlSec).toBe(90);
    expect(t.heartbeatSec).toBe(20);
    expect(t.connectPendingMaxSec).toBe(3600); // 不再有 10 秒自动拒绝，仅兜底防泄漏
    expect(t.maxPendingPerHost).toBe(50);
    expect(t.ticketTtlSec).toBe(30);
    expect(t.pairTimeoutMs).toBe(15_000);
    expect(t.relayMaxMessage).toBe(128 * 1024);
    expect(t.sessionBytesPerSec).toBe(4 * 1024 * 1024);
    expect(t.sessionBurstBytes).toBe(8 * 1024 * 1024);
    expect(t.dailyQuotaBytes).toBe(10 * 1024 ** 3);
    expect(t.maxSessionsPerDevice).toBe(8);
    expect(t.maxSessionsPerHost).toBe(100);
    expect(t.maxSignalConnsPerIp).toBe(50);
    expect(t.registerPerHourPerIp).toBe(10);
    expect(t.connectPerMinDevice).toBe(10);
    expect(t.connectPerHourDevice).toBe(60);
    expect(t.connectPerMinIp).toBe(30);
    expect(t.connectPerMinTarget).toBe(120);
  });
  it('不设 MYSQL_URL 时给出明确的错误', () => {
    expect(() => loadConfig({ TICKET_SECRET: 'x'.repeat(20) })).toThrow(/MYSQL_URL/);
    try {
      loadConfig({});
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
    }
  });
  it('中继入口不要求 MYSQL_URL（会话字节数经 Redis 回传，中继不连 MySQL）', () => {
    expect(() => loadConfig({ TICKET_SECRET: 'x'.repeat(20) })).toThrow(/MYSQL_URL/);
    expect(loadConfig({ TICKET_SECRET: 'x'.repeat(20) }, { requireMysql: false }).ticketSecret).toHaveLength(20);
  });
  it('STORE=memory 不需要 MYSQL_URL，开发环境 TICKET_SECRET 有默认值', () => {
    const c = loadConfig({ STORE: 'memory' });
    expect(c.store).toBe('memory');
    expect(c.ticketSecret.length).toBeGreaterThan(16);
    expect(c.relay.publicUrl).toBe('ws://127.0.0.1:8081');
  });
  it('生产环境必须设置足够长的 TICKET_SECRET', () => {
    expect(() => loadConfig({ STORE: 'memory', NODE_ENV: 'production' })).toThrow(/TICKET_SECRET/);
    expect(() => loadConfig({ STORE: 'memory', NODE_ENV: 'production', TICKET_SECRET: 'short' })).toThrow(/太短/);
    expect(loadConfig({ STORE: 'memory', NODE_ENV: 'production', TICKET_SECRET: 'x'.repeat(32) }).ticketSecret).toHaveLength(32);
  });
  it('非法取值被拒绝', () => {
    expect(() => loadConfig({ STORE: 'oracle' })).toThrow(/STORE/);
    expect(() => loadConfig({ STORE: 'memory', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ STORE: 'memory', MIN_APP_VERSION: 'x' })).toThrow(/MIN_APP_VERSION/);
  });
});

describe('版本号比较', () => {
  it('数字与预发布', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('abc', '1.0.0')).toBeNull();
    expect(versionLt('0.9.0', '1.0.0')).toBe(true);
    expect(versionLt('x', '1.0.0')).toBe(false);
  });
});

describe('IP 工具', () => {
  it('IPv4 / IPv6 与二进制互转', () => {
    expect(ipToBuffer('1.2.3.4')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(bufferToIp(Buffer.from([10, 0, 0, 1]))).toBe('10.0.0.1');
    expect(ipToBuffer('::ffff:1.2.3.4')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(ipToBuffer('::1')!.length).toBe(16);
    expect(ipToBuffer('::1')![15]).toBe(1);
    expect(ipToBuffer('2001:db8::ff00:42:8329')!.toString('hex')).toBe('20010db8000000000000ff0000428329');
    expect(ipToBuffer('not-an-ip')).toBeNull();
    expect(normalizeIp('::FFFF:8.8.8.8')).toBe('8.8.8.8');
  });
  it('CIDR 匹配', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('1.2.3.4', 'garbage')).toBe(false);
  });
  it('只有受信任代理时才采用 X-Forwarded-For，且取最右一项', () => {
    const none = createTrustChecker('false');
    const all = createTrustChecker('true');
    const list = createTrustChecker('172.18.0.0/16, 10.0.0.1');
    expect(clientIp('9.9.9.9', '1.1.1.1', none)).toBe('9.9.9.9');
    expect(clientIp('9.9.9.9', '6.6.6.6, 1.1.1.1', all)).toBe('1.1.1.1');
    expect(clientIp('172.18.0.5', '1.1.1.1', list)).toBe('1.1.1.1');
    expect(clientIp('8.8.8.8', '1.1.1.1', list)).toBe('8.8.8.8');
    expect(clientIp('172.18.0.5', 'garbage', list)).toBe('172.18.0.5');
    expect(clientIp('::ffff:127.0.0.1', undefined, none)).toBe('127.0.0.1');
  });
});

describe('信令协议辅助', () => {
  it('parseMsg：合法与非法', () => {
    expect(parseMsg('{"t":"ping","id":"1","d":{"a":1}}')).toEqual({ t: 'ping', id: '1', d: { a: 1 } });
    expect(parseMsg('{"t":"ping"}')).toEqual({ t: 'ping', d: {} });
    for (const bad of ['', 'not json', '[]', '123', 'null', '{"d":{}}', '{"t":""}', '{"t":5}']) expect(parseMsg(bad)).toBeNull();
  });
  it('协议版本区间必须有交集', () => {
    expect(protoCompatible({ ver: 1, min: 1 }, { ver: 1, min: 1 })).toBe(true);
    expect(protoCompatible({ ver: 3, min: 2 }, { ver: 1, min: 1 })).toBe(false);
    expect(protoCompatible({ ver: 3, min: 1 }, { ver: 2, min: 2 })).toBe(true);
  });
});

describe('更新接口辅助', () => {
  const rel = (version: string, rollout = 100, status = 1) =>
    ({ id: 1, version, kind: 'desktop', platform: 'windows', arch: 'x86_64', channel: 'stable', downloadUrl: 'u', signature: 's', notes: null, rolloutPercent: rollout, status, publishedAt: new Date() }) as const;

  it('选最高的、比当前新的、灰度命中的版本', () => {
    expect(pickRelease([rel('1.1.0'), rel('1.2.0'), rel('1.0.0')], '1.0.0', 'dev')?.version).toBe('1.2.0');
    expect(pickRelease([rel('1.0.0')], '1.0.0', 'dev')).toBeNull();
    expect(pickRelease([rel('1.2.0', 100, 0)], '1.0.0', 'dev')).toBeNull();
    expect(pickRelease([rel('1.2.0', 0)], '1.0.0', 'dev')).toBeNull();
  });
  it('灰度按设备哈希取模：比例 5% 时命中约 5%，且比例上调只会增加命中的设备', () => {
    let hit5 = 0;
    for (let i = 0; i < 4000; i++) {
      const b = rolloutBucket(`device-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
      if (b < 5) hit5++;
      if (b < 5) expect(b < 50).toBe(true);
    }
    expect(hit5).toBeGreaterThan(80);
    expect(hit5).toBeLessThan(330);
    expect(rolloutBucket('x')).toBe(rolloutBucket('x'));
  });
});

describe('管理令牌比较', () => {
  it('常数时间比较，空令牌永远不匹配', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});

describe('sessions 分区维护计划', () => {
  const initial = [
    { name: 'p202611', bound: '2026-12-01' },
    { name: 'p202612', bound: '2027-01-01' },
    { name: 'pmax', bound: null },
  ];
  it('新建到当前月 + 2 个月，不重复建已有的', () => {
    const sql = planPartitionChanges(initial, new Date('2026-11-11T00:00:00Z'));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('PARTITION p202701 VALUES LESS THAN (\'2027-02-01\')');
    expect(sql[0]).toContain('REORGANIZE PARTITION pmax');
  });
  it('跨月后连续补建并删除 6 个月前的分区', () => {
    const sql = planPartitionChanges(initial, new Date('2027-06-15T00:00:00Z'));
    expect(sql.some((s) => s.includes('PARTITION p202706'))).toBe(true);
    expect(sql.some((s) => s.includes('PARTITION p202708'))).toBe(true);
    expect(sql).toContain('ALTER TABLE sessions DROP PARTITION p202611');
    expect(sql.some((s) => s.includes('DROP PARTITION p202612'))).toBe(false);
  });
  it('新建语句的上界严格递增', () => {
    const sql = planPartitionChanges(initial, new Date('2027-03-01T00:00:00Z')).filter((s) => s.includes('REORGANIZE'));
    const bounds = sql.map((s) => /LESS THAN \('(\d{4}-\d{2}-\d{2})'\)/.exec(s)![1]!);
    expect([...bounds].sort()).toEqual(bounds);
    expect(new Set(bounds).size).toBe(bounds.length);
  });
});
