import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryTrafficRepo } from '../src/db/repos/memory.js';
import { utcDate } from '../src/util/time.js';
import { RelayConn } from '../tools/rterm-client.js';
import { onlineDevice, startStack, until, type Stack } from './helpers.js';

const H = { authorization: 'Bearer test-admin-token' };

describe('设备流量统计', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.stop());

  const today = (): string => utcDate();

  /** 连一个会话：控制端按 c2h 里的大小逐条发，被控端按 h2c 逐条发，然后断开 */
  async function runSession(c2h: number[], h2c: number[], ctl?: Awaited<ReturnType<typeof onlineDevice>>) {
    const host = await onlineDevice(s);
    ctl ??= await onlineDevice(s);
    const incP = host.sig.waitIncoming();
    const resP = ctl.sig.connectRequest(host.identity.deviceCode);
    const inc = await incP;
    const goP = host.sig.acceptGo(inc.session_id);
    const res = await resP;
    if (!res.ok) throw new Error(res.code);
    const [h, c] = await Promise.all([RelayConn.connect((await goP).relay_url, (await goP).ticket), RelayConn.connect(res.data.relay_url, res.data.ticket)]);
    for (const n of c2h) await c.send(Buffer.alloc(n, 1));
    for (const n of h2c) await h.send(Buffer.alloc(n, 2));
    await Promise.all([h.waitCount(c2h.length), c.waitCount(h2c.length)]);
    c.close();
    await h.closed;
    const hostId = (await s.repos.devices.findByUid(host.identity.deviceId))!.id;
    const ctlId = (await s.repos.devices.findByUid(ctl.identity.deviceId))!.id;
    return { host, ctl, hostId, ctlId };
  }

  const rowOf = async (deviceId: number) => (await s.repos.traffic.range({ from: today(), to: today(), deviceId, limit: 10 }))[0];

  it('会话结束后两端设备各记一份：控制端的 out 是被控端的 in，反之亦然；字节数和帧数都对', async () => {
    const { hostId, ctlId } = await runSession([1000, 2000, 3000], [500, 700]);
    await until(async () => (await rowOf(ctlId)) !== undefined, 3000, '流量已写入');
    expect(await rowOf(ctlId)).toMatchObject({ bytesOut: 6000, bytesIn: 1200, framesOut: 3, framesIn: 2 });
    expect(await rowOf(hostId)).toMatchObject({ bytesIn: 6000, bytesOut: 1200, framesIn: 3, framesOut: 2 });
  });

  it('同一设备连接多次，同一天累加到同一行', async () => {
    const first = await runSession([100], [10]);
    await until(async () => (await rowOf(first.ctlId)) !== undefined, 3000, '第一次写入');
    await runSession([50, 50], [5], first.ctl);
    await until(async () => (await rowOf(first.ctlId))?.framesOut === 3, 3000, '第二次累加');
    expect(await rowOf(first.ctlId)).toMatchObject({ bytesOut: 200, bytesIn: 15, framesOut: 3, framesIn: 2 });
    expect(await s.repos.traffic.range({ from: today(), to: today(), deviceId: first.ctlId, limit: 10 })).toHaveLength(1);
  });

  it('管理接口 /traffic：按设备码查询，返回 in/out 与合计；参数不合法 400；设备不存在 404', async () => {
    const { ctl } = await runSession([400], [60]);
    const code = ctl.identity.deviceCode;
    let body: any;
    await until(
      async () => {
        body = await (await fetch(`${s.http}/v1/admin/traffic?device=${code}`, { headers: H })).json();
        return body.items?.length === 1;
      },
      3000,
      '接口能查到流量',
    );
    expect(body.items[0]).toMatchObject({ date: today(), device_code: code, bytes_out: 400, bytes_in: 60, frames_out: 1, frames_in: 1 });
    expect(body.total).toEqual({ bytes_in: 60, bytes_out: 400, frames_in: 1, frames_out: 1 });
    expect((await fetch(`${s.http}/v1/admin/traffic?from=abc`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.http}/v1/admin/traffic?device=000000000`, { headers: H })).status).toBe(404);
  });

  it('分钟级：会话结束后分钟表有记录，合计与日表一致；参数不合法 400', async () => {
    const { ctl } = await runSession([300, 300], [40]);
    const code = ctl.identity.deviceCode;
    let body: any;
    await until(
      async () => {
        body = await (await fetch(`${s.http}/v1/admin/traffic?granularity=minute&device=${code}`, { headers: H })).json();
        return body.items?.length >= 1;
      },
      3000,
      '分钟级能查到流量',
    );
    expect(body.total).toEqual({ bytes_in: 40, bytes_out: 600, frames_in: 1, frames_out: 2 });
    expect(body.items[0].minute).toMatch(/:00\.000Z$/);
    expect((await fetch(`${s.http}/v1/admin/traffic?granularity=minute&from=abc`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.http}/v1/admin/traffic?granularity=hour`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.http}/v1/admin/traffic?granularity=minute&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`, { headers: H })).status).toBe(400);
  });
});

describe('MemoryTrafficRepo', () => {
  it('同一设备同一天累加（含同一次调用里同一设备出现两次）；按日期和设备过滤；limit 生效', async () => {
    const r = new MemoryTrafficRepo();
    await r.add('2026-11-01', [
      { deviceId: 1, bytesIn: 10, bytesOut: 20, framesIn: 1, framesOut: 2 },
      { deviceId: 1, bytesIn: 5, bytesOut: 5, framesIn: 1, framesOut: 1 },
      { deviceId: 2, bytesIn: 1, bytesOut: 1, framesIn: 1, framesOut: 1 },
    ]);
    await r.add('2026-11-02', [{ deviceId: 1, bytesIn: 1, bytesOut: 1, framesIn: 1, framesOut: 1 }]);
    expect(await r.range({ from: '2026-11-01', to: '2026-11-01', deviceId: 1, limit: 10 })).toEqual([
      { deviceId: 1, statDate: '2026-11-01', bytesIn: 15, bytesOut: 25, framesIn: 2, framesOut: 3 },
    ]);
    expect(await r.range({ from: '2026-11-01', to: '2026-11-02', limit: 10 })).toHaveLength(3);
    expect(await r.range({ from: '2026-11-01', to: '2026-11-02', limit: 2 })).toHaveLength(2);
  });

  it('分钟表：同一分钟累加，不同分钟分开，按时间升序，[from, to) 过滤', async () => {
    const r = new MemoryTrafficRepo();
    const d = { bytesIn: 1, bytesOut: 2, framesIn: 1, framesOut: 1 };
    await r.add('2026-11-01', [{ deviceId: 1, ...d }], 600);
    await r.add('2026-11-01', [{ deviceId: 1, ...d }], 600);
    await r.add('2026-11-01', [{ deviceId: 1, ...d }], 660);
    expect(await r.rangeMinutes({ from: 600, to: 720, limit: 10 })).toEqual([
      { deviceId: 1, minute: 600, bytesIn: 2, bytesOut: 4, framesIn: 2, framesOut: 2 },
      { deviceId: 1, minute: 660, ...d },
    ]);
    expect(await r.rangeMinutes({ from: 600, to: 660, limit: 10 })).toHaveLength(1);
  });
});
