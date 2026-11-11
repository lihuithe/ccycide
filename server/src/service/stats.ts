import type { Log } from '../logger.js';
import type { Repos } from '../db/repos/index.js';
import { utcDate } from '../util/time.js';

/**
 * 每日统计的内存累加器。事件发生时只改内存，定时 flush 到 daily_stats，
 * 避免每条事件都写一次库。flush 失败时增量保留，下次再试。
 */
export class StatsCollector {
  private add = { newDevices: 0, sessionsTotal: 0, sessionsAuthed: 0, authFailures: 0, bytesRelayed: 0 };
  private peakOnline = 0;
  private peakSessions = 0;

  constructor(
    private repos: Repos,
    private log: Log,
  ) {}

  inc(k: keyof StatsCollector['add'], n = 1): void {
    this.add[k] += n;
  }

  observeOnline(n: number): void {
    if (n > this.peakOnline) this.peakOnline = n;
  }

  observeSessions(n: number): void {
    if (n > this.peakSessions) this.peakSessions = n;
  }

  async flush(): Promise<void> {
    const snapshot = { ...this.add };
    const peaks = { peakOnline: this.peakOnline, peakSessions: this.peakSessions };
    const empty = Object.values(snapshot).every((v) => v === 0) && peaks.peakOnline === 0 && peaks.peakSessions === 0;
    if (empty) return;
    const now = new Date();
    try {
      const dayStart = new Date(`${utcDate(now)}T00:00:00.000Z`);
      const activeDevices = await this.repos.devices.countSeenSince(dayStart);
      await this.repos.stats.apply(utcDate(now), snapshot, { ...peaks, activeDevices });
      for (const k of Object.keys(snapshot) as Array<keyof typeof snapshot>) this.add[k] -= snapshot[k];
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, '写入每日统计失败，稍后重试');
    }
  }
}
