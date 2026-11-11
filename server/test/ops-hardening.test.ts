import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { newUlid } from '../src/crypto.js';
import { signTicket } from '../src/relay/ticket.js';
import { Guard, GUARD } from '../src/service/guard.js';
import { MemoryKvStore } from '../src/store/kv.js';
import { banTargetFor, ipInCidr, rateKeyIp } from '../src/util/ip.js';
import { registerNew } from '../tools/rterm-client.js';
import { onlineDevice, sleep, startStack, until, type Stack } from './helpers.js';

const H = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };

function tk(s: Stack, sid: string, role: 'c' | 'h', did: string): string {
  return signTicket({ sid, role, did, node: 'relay-test' }, s.cfg.ticketSecret, 30);
}

interface Raw {
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<number>;
}

/** 直接用 ws 连中继，可以带 X-Forwarded-For；连接被拒（429）时 opened 会 reject */
function rawRelay(s: Stack, ticket: string, headers: Record<string, string> = {}): Raw {
  const ws = new WebSocket(`${s.relayUrl}/v1/relay?ticket=${encodeURIComponent(ticket)}`, { headers, perMessageDeflate: false });
  ws.on('error', () => {});
  return {
    ws,
    opened: new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
      ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    }),
    closed: new Promise<number>((res) => ws.once('close', (c) => res(c))),
  };
}

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});
async function stack(o: Parameters<typeof startStack>[0]): Promise<Stack> {
  const s = await startStack(o);
  stacks.push(s);
  return s;
}

describe('中继并发连接限制（安全审查建议 11）', () => {
  it('同一来源并发连接数超限：握手之前就以 429 拒绝；连接关闭后计数释放', async () => {
    const s = await stack({ tunables: { maxRelayConnsPerIp: 3 } });
    const open = [0, 1, 2].map((i) => rawRelay(s, tk(s, newUlid(), 'c', `d${i}`)));
    await Promise.all(open.map((c) => c.opened));
    const fourth = rawRelay(s, tk(s, newUlid(), 'c', 'd3'));
    await expect(fourth.opened).rejects.toThrow(/429/);
    open[0]!.ws.close();
    await open[0]!.closed;
    await until(() => s.relay.relay.connCounters.ips === 2, 3000, '计数释放');
    const fifth = rawRelay(s, tk(s, newUlid(), 'c', 'd4'));
    await fifth.opened;
    for (const c of [...open, fifth]) c.ws.close();
    await until(() => s.relay.relay.connCounters.ips === 0, 3000, '全部释放');
  });

  it('无效票据的连接同样占用来源计数，关闭后释放（没有计数泄漏）', async () => {
    const s = await stack({ tunables: { maxRelayConnsPerIp: 2 } });
    for (let i = 0; i < 6; i++) {
      const c = rawRelay(s, 'not-a-ticket');
      await c.opened;
      expect(await c.closed).toBe(4001);
    }
    await until(() => s.relay.relay.connCounters.ips === 0, 3000, '计数归零');
  });

  it('TRUST_PROXY 打开时按 X-Forwarded-For 的最右一项计数；IPv6 按 /64 归一', async () => {
    const s = await stack({ cfg: { trustProxy: 'true' }, tunables: { maxRelayConnsPerIp: 2 } });
    const t = (): string => tk(s, newUlid(), 'c', `d-${newUlid()}`);
    // 同一 /64 里的两个不同地址算同一来源
    const a = rawRelay(s, t(), { 'x-forwarded-for': '2001:db8:1:2::1' });
    const b = rawRelay(s, t(), { 'x-forwarded-for': '2001:db8:1:2:ffff:ffff:ffff:ffff' });
    await Promise.all([a.opened, b.opened]);
    await expect(rawRelay(s, t(), { 'x-forwarded-for': '2001:db8:1:2:1234::9' }).opened).rejects.toThrow(/429/);
    // 客户端自己伪造的左边几项没有用：取最右一项
    await expect(rawRelay(s, t(), { 'x-forwarded-for': '198.51.100.9, 2001:db8:1:2::77' }).opened).rejects.toThrow(/429/);
    // 另一个 /64 不受影响
    const other = rawRelay(s, t(), { 'x-forwarded-for': '2001:db8:1:3::1' });
    await other.opened;
    for (const c of [a, b, other]) c.ws.close();
  });

  it('TRUST_PROXY 关闭时忽略 X-Forwarded-For（伪造头不能绕过限制）', async () => {
    const s = await stack({ tunables: { maxRelayConnsPerIp: 2 } });
    const t = (): string => tk(s, newUlid(), 'c', `d-${newUlid()}`);
    const a = rawRelay(s, t(), { 'x-forwarded-for': '203.0.113.1' });
    const b = rawRelay(s, t(), { 'x-forwarded-for': '203.0.113.2' });
    await Promise.all([a.opened, b.opened]);
    await expect(rawRelay(s, t(), { 'x-forwarded-for': '203.0.113.3' }).opened).rejects.toThrow(/429/);
    a.ws.close();
    b.ws.close();
  });

  it('同一设备并发连接数超限：多出来的以 4004 关闭；其他设备不受影响；关闭后释放', async () => {
    const s = await stack({ tunables: { maxRelayConnsPerDevice: 2 } });
    const c1 = rawRelay(s, tk(s, newUlid(), 'h', 'dev-x'));
    const c2 = rawRelay(s, tk(s, newUlid(), 'h', 'dev-x'));
    await Promise.all([c1.opened, c2.opened]);
    const c3 = rawRelay(s, tk(s, newUlid(), 'h', 'dev-x'));
    await c3.opened;
    expect(await c3.closed).toBe(4004);
    const ok = rawRelay(s, tk(s, newUlid(), 'h', 'dev-y'));
    await ok.opened;
    expect(c1.ws.readyState).toBe(WebSocket.OPEN);
    c1.ws.close();
    await c1.closed;
    await until(() => s.relay.relay.connCounters.devices === 2, 3000, '设备计数释放');
    const c4 = rawRelay(s, tk(s, newUlid(), 'h', 'dev-x'));
    await c4.opened;
    await sleep(200);
    expect(c4.ws.readyState).toBe(WebSocket.OPEN);
    for (const c of [c2, c4, ok]) c.ws.close();
    await until(() => s.relay.relay.connCounters.devices === 0, 3000, '全部释放');
  });

  it('等待配对的连接总数有上限：超出的以 4004 关闭；配对完成后名额释放', async () => {
    const s = await stack({ tunables: { maxRelayWaiting: 2 } });
    const sids = [newUlid(), newUlid(), newUlid()];
    const w = sids.slice(0, 2).map((sid, i) => rawRelay(s, tk(s, sid, 'c', `wc${i}`)));
    await Promise.all(w.map((c) => c.opened));
    await until(() => s.relay.relay.waitingCount === 2, 3000, '两个在等待');
    const third = rawRelay(s, tk(s, sids[2]!, 'c', 'wc2'));
    await third.opened;
    expect(await third.closed).toBe(4004);
    // 第一个会话的另一端到了，配对完成，名额让出来
    const peer = rawRelay(s, tk(s, sids[0]!, 'h', 'wh0'));
    await peer.opened;
    await until(() => s.relay.relay.waitingCount === 1, 3000, '配对后名额释放');
    const again = rawRelay(s, tk(s, newUlid(), 'c', 'wc3'));
    await again.opened;
    await until(() => s.relay.relay.waitingCount === 2, 3000, '新的等待者');
    for (const c of [...w, peer, again]) c.ws.close();
  });

  it('默认值：来源 256、设备 128、等待 1000', async () => {
    const s = await stack({});
    expect(s.cfg.tunables).toMatchObject({ maxRelayConnsPerIp: 256, maxRelayConnsPerDevice: 128, maxRelayWaiting: 1000 });
  });
});

describe('封禁与枚举计数按来源前缀统一', () => {
  it('banTargetFor：IPv4 封单个地址，IPv6 封 /64，IPv4 映射还原为 IPv4', () => {
    expect(banTargetFor('203.0.113.5')).toEqual({ kind: 'ip', value: '203.0.113.5' });
    expect(banTargetFor('::ffff:203.0.113.5')).toEqual({ kind: 'ip', value: '203.0.113.5' });
    expect(banTargetFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toEqual({ kind: 'cidr', value: '2001:db8:1:2::/64' });
    expect(ipInCidr('2001:db8:1:2:1::9', banTargetFor('2001:db8:1:2::1').value)).toBe(true);
    expect(ipInCidr('2001:db8:1:3::1', banTargetFor('2001:db8:1:2::1').value)).toBe(false);
    expect(rateKeyIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
  });

  it('Guard.recordMiss：同一来源下多个设备合计达到来源阈值也触发封禁，不同来源互不影响', async () => {
    const kv = new MemoryKvStore();
    const g = new Guard(kv);
    const src = '2001:db8:1:2::/64';
    let banned = 0;
    // 每个设备只请求 GUARD.missThreshold - 1 次（自己不会触发），多个设备合计超过来源阈值
    const devices = Math.ceil(GUARD.missSourceThreshold / (GUARD.missThreshold - 1)) + 1;
    for (let d = 0; d < devices; d++) {
      for (let i = 0; i < GUARD.missThreshold - 1; i++) {
        const r = await g.recordMiss(`UID${d}`, src);
        if (r.ban) banned++;
        expect(r.sourceCount).toBeGreaterThan(0);
      }
    }
    expect(banned).toBeGreaterThanOrEqual(1);
    // 另一个来源的计数独立
    expect((await g.recordMiss('UIDX', '2001:db8:9:9::/64')).ban).toBe(false);
    kv.stop();
  });

  it('枚举封禁同时封来源：新注册的设备在封禁期内认证被拒、注册被拒', async () => {
    const s = await stack({});
    const ctl = await onlineDevice(s);
    for (let i = 0; i < 30 && ctl.sig.ws.readyState === 1; i++) {
      ctl.sig.sendRaw({ t: 'connect.request', id: String(100 + i), d: { target_code: String(600000000 + i * 104729) } });
      await sleep(5);
    }
    expect(await ctl.sig.closed).toBe(4403);
    const src = await s.repos.bans.findActive({ ip: '127.0.0.1' });
    expect(src).toMatchObject({ kind: 'ip', value: '127.0.0.1', source: 'auto' });
    const ttl = src!.expiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(3500_000);
    await expect(registerNew(s.http)).rejects.toThrow();
    const row = (await s.repos.devices.findByUid(ctl.identity.deviceId))!;
    const ev = await s.repos.events.list({ type: 'enum_suspected', deviceId: row.id, limit: 5, offset: 0 });
    expect(ev[0]!.detail).toMatchObject({ source_ban: '127.0.0.1' });
  });

  it('管理接口封 IPv6 单个地址：落成所在 /64 的 cidr 封禁', async () => {
    const s = await stack({});
    const r = await fetch(`${s.http}/v1/admin/bans`, { method: 'POST', headers: H, body: JSON.stringify({ kind: 'ip', value: '2001:db8:aa:bb:1:2:3:4', reason: 'abuse' }) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ban: { kind: string; value: string } };
    expect(body.ban).toMatchObject({ kind: 'cidr', value: '2001:db8:aa:bb::/64' });
    expect(await s.repos.bans.findActive({ ip: '2001:db8:aa:bb:ffff::1' })).not.toBeNull();
    expect(await s.repos.bans.findActive({ ip: '2001:db8:aa:cc::1' })).toBeNull();
    // IPv4 仍是单个地址
    const r4 = await fetch(`${s.http}/v1/admin/bans`, { method: 'POST', headers: H, body: JSON.stringify({ kind: 'ip', value: '203.0.113.5' }) });
    expect(((await r4.json()) as { ban: { kind: string } }).ban.kind).toBe('ip');
  });
});
