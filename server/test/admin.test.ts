import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerNew } from '../tools/rterm-client.js';
import { onlineDevice, startStack, type Stack } from './helpers.js';

const H = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };

describe('管理接口鉴权（6.8）', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  it('没有令牌 / 令牌错误：401；正确令牌：200', async () => {
    expect((await fetch(`${s.http}/v1/admin/stats`)).status).toBe(401);
    expect((await fetch(`${s.http}/v1/admin/stats`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${s.http}/v1/admin/stats`, { headers: { authorization: 'test-admin-token' } })).status).toBe(401);
    const ok = await fetch(`${s.http}/v1/admin/stats`, { headers: H });
    expect(ok.status).toBe(200);
  });

  it('反复猜令牌会被限流', async () => {
    let last = 0;
    for (let i = 0; i < 15; i++) last = (await fetch(`${s.http}/v1/admin/stats`, { headers: { authorization: `Bearer guess-${i}` } })).status;
    expect(last).toBe(429);
  });

  it('未配置 ADMIN_TOKEN 时整个管理接口关闭（404）', async () => {
    const s2 = await startStack({ cfg: { adminToken: '' } });
    try {
      expect((await fetch(`${s2.http}/v1/admin/stats`, { headers: H })).status).toBe(404);
    } finally {
      await s2.stop();
    }
  });
});

describe('管理接口功能', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());
  const get = async (p: string) => (await fetch(`${s.http}/v1/admin${p}`, { headers: H })).json() as Promise<any>;
  const send = (method: string, p: string, body?: unknown) =>
    fetch(`${s.http}/v1/admin${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

  it('设备查询：列表、按设备码或设备 ID 查询、在线状态', async () => {
    const a = await onlineDevice(s);
    const b = await registerNew(s.http);
    const byCode = await get(`/devices/${a.identity.deviceCode}`);
    expect(byCode).toMatchObject({ device_id: a.identity.deviceId, device_code: a.identity.deviceCode, platform: 'windows', online: true, status: 0, register_ip: '127.0.0.1' });
    const byUid = await get(`/devices/${b.identity.deviceId}`);
    expect(byUid).toMatchObject({ device_code: b.identity.deviceCode, online: false });
    const list = await get(`/devices?q=${a.identity.deviceCode}`);
    expect(list.total).toBe(1);
    expect((await get('/devices')).total).toBeGreaterThanOrEqual(2);
    expect((await send('GET', '/devices/000000000')).status).toBe(404);
    a.sig.close();
  });

  it('封禁 / 解封设备、到期时间；封禁列表与手动封禁 IP / CIDR', async () => {
    const d = await registerNew(s.http);
    expect((await send('POST', `/devices/${d.identity.deviceCode}/ban`, { reason: 'x', duration_sec: 3600 })).status).toBe(200);
    // 限时封禁不改 devices.status，只写 bans
    expect((await s.repos.devices.findByUid(d.identity.deviceId))!.status).toBe(0);
    const bans = await get('/bans');
    const mine = bans.items.find((b: any) => b.value === d.identity.deviceId);
    expect(mine).toMatchObject({ kind: 'device', source: 'manual', reason: 'x' });
    expect(new Date(mine.expires_at).getTime() - Date.now()).toBeGreaterThan(3500_000);
    expect((await send('POST', `/devices/${d.identity.deviceId}/unban`)).status).toBe(200);
    expect((await get('/bans')).items.find((b: any) => b.value === d.identity.deviceId)).toBeUndefined();

    // 手动封禁 IP 与 CIDR，参数校验
    expect((await send('POST', '/bans', { kind: 'ip', value: '203.0.113.5', reason: 'abuse' })).status).toBe(200);
    expect((await send('POST', '/bans', { kind: 'cidr', value: '198.51.100.0/24', duration_sec: 60 })).status).toBe(200);
    expect((await send('POST', '/bans', { kind: 'ip', value: 'garbage' })).status).toBe(400);
    expect((await send('POST', '/bans', { kind: 'cidr', value: '1.2.3.4' })).status).toBe(400);
    expect((await send('POST', '/bans', { kind: 'cidr', value: '1.2.3.0/99' })).status).toBe(400);
    expect((await send('POST', '/bans', { kind: 'what', value: 'x' })).status).toBe(400);
    expect(await s.repos.bans.findActive({ ip: '198.51.100.77' })).not.toBeNull();
    const ipBan = (await get('/bans')).items.find((b: any) => b.value === '203.0.113.5');
    expect((await send('DELETE', `/bans/${ipBan.id}`)).status).toBe(200);
    expect((await send('DELETE', `/bans/${ipBan.id}`)).status).toBe(404);
  });

  it('会话记录与安全事件查询', async () => {
    const host = await onlineDevice(s);
    const ctl = await onlineDevice(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    host.sig.accept(inc.session_id);
    await resP;
    host.sig.report(inc.session_id, 'auth_failed');
    await new Promise((r) => setTimeout(r, 100));
    const sessions = await get(`/sessions?device=${host.identity.deviceCode}`);
    expect(sessions.items[0]).toMatchObject({ session_id: inc.session_id, controller_code: ctl.identity.deviceCode, host_code: host.identity.deviceCode, status: 'failed', fail_reason: 'auth_failed', controller_ip: '127.0.0.1' });
    expect((await get('/sessions?status=failed')).items.length).toBeGreaterThan(0);
    const ev = await get(`/security-events?type=auth_failed&device=${host.identity.deviceCode}`);
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0]).toMatchObject({ type: 'auth_failed', session_id: inc.session_id, source_ip: '127.0.0.1' });
  });

  it('统计：在线数、设备总数、24 小时会话、中继节点', async () => {
    const st = await get('/stats');
    expect(st.online_devices).toBeGreaterThanOrEqual(0);
    expect(st.devices_total).toBeGreaterThan(0);
    expect(st.sessions_24h.total).toBeGreaterThan(0);
    expect(st.relay_nodes[0]).toMatchObject({ name: 'relay-test', status: 'up' });
    await s.ctx.collector.flush();
    const st2 = await get('/stats');
    expect(st2.daily.length).toBeGreaterThan(0);
    expect(st2.daily[st2.daily.length - 1].newDevices).toBeGreaterThan(0);
  });

  it('中继节点登记：停用 / 排空的节点不会被分配', async () => {
    const before = await s.ctx.relays.pick();
    expect(before?.name).toBe('relay-test');
    expect((await send('PUT', '/relay-nodes/relay-test', { region: 'dev', public_url: s.cfg.relay.publicUrl, status: 2, capacity: 100 })).status).toBe(200);
    expect(await s.ctx.relays.pick()).toBeNull();
    expect((await send('PUT', '/relay-nodes/relay-test', { region: 'dev', public_url: s.cfg.relay.publicUrl, status: 1, capacity: 100 })).status).toBe(200);
    expect((await s.ctx.relays.pick())?.name).toBe('relay-test');
    expect((await send('PUT', '/relay-nodes/bad name', { region: 'x', public_url: 'wss://x' })).status).toBe(400);
    expect((await send('PUT', '/relay-nodes/n1', { region: 'x', public_url: 'http://x' })).status).toBe(400);
    const nodes = await get('/relay-nodes');
    expect(nodes.registered.map((n: any) => n.name)).toContain('relay-test');
    expect((await send('DELETE', '/relay-nodes/relay-test')).status).toBe(200);
  });

  it('发布版本的参数校验', async () => {
    const bad = (over: object) => send('POST', '/releases', { version: '1.0.0', platform: 'windows', arch: 'x86_64', download_url: 'https://x/y', signature: 's', ...over });
    expect((await bad({ version: 'abc' })).status).toBe(400);
    expect((await bad({ platform: 'beos' })).status).toBe(400);
    expect((await bad({ arch: 'z80' })).status).toBe(400);
    expect((await bad({ download_url: 'ftp://x' })).status).toBe(400);
    expect((await bad({ signature: '' })).status).toBe(400);
    expect((await bad({ rollout_percent: 101 })).status).toBe(400);
    expect((await bad({})).status).toBe(200);
    expect((await send('PATCH', '/releases/999', { status: 0 })).status).toBe(404);
  });

  it('操作写入审计日志', async () => {
    const logs = await get('/audit-logs');
    const actions = logs.items.map((l: any) => l.action);
    expect(actions).toContain('device.ban');
    expect(actions).toContain('release.publish');
    expect(logs.items[0].ip).toBe('127.0.0.1');
  });
});
