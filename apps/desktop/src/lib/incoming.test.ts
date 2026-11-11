import { describe, expect, it } from 'vitest';
import type { IncomingSession } from '../backend/types';
import { pendingQueue, waitedMs } from './incoming';

const inc = (id: string, startedAt: number, pendingConfirm: boolean): IncomingSession => ({
  sessionId: id, fromCode: '1', platform: 'macos', startedAt, pendingConfirm,
});

describe('来访请求队列', () => {
  it('只含待确认的，按到达先后排队', () => {
    const q = pendingQueue([inc('b', 200, true), inc('x', 50, false), inc('a', 100, true)]);
    expect(q.map((i) => i.sessionId)).toEqual(['a', 'b']);
  });

  it('等待时长随时间递增，没有上限也不会自动结束', () => {
    const i = inc('a', 1000, true);
    expect(waitedMs(i, 2000)).toBe(1000);
    expect(waitedMs(i, 1000 + 3600_000)).toBe(3600_000);
    expect(waitedMs(i, 500)).toBe(0);
    // 一小时后依然在队列里
    expect(pendingQueue([i])).toHaveLength(1);
  });
});
