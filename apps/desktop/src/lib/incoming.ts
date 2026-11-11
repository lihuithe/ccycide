/** 被控端来访请求队列：待确认的请求按到达先后排队，没有超时 */
import type { IncomingSession } from '../backend/types';

export function pendingQueue(list: IncomingSession[]): IncomingSession[] {
  return list.filter((i) => i.pendingConfirm).sort((a, b) => a.startedAt - b.startedAt);
}

/** 已等待的毫秒数（不为负） */
export function waitedMs(i: IncomingSession, now: number): number {
  return Math.max(0, now - i.startedAt);
}
