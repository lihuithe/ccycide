import type { PresenceInfo, PresenceStore } from './types.js';

interface Entry {
  info: PresenceInfo;
  expiresAt: number;
}

/** 单机内存实现。有效期到了之后惰性过期，另有定时清扫。 */
export class MemoryPresenceStore implements PresenceStore {
  private map = new Map<string, Entry>();
  private timer: NodeJS.Timeout;

  constructor(
    private ttlMs = 90_000,
    private now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  private live(code: string): Entry | null {
    const e = this.map.get(code);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(code);
      return null;
    }
    return e;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.map) if (e.expiresAt <= t) this.map.delete(k);
  }

  async set(code: string, info: PresenceInfo): Promise<PresenceInfo | null> {
    const prev = this.live(code);
    this.map.set(code, { info: { ...info }, expiresAt: this.now() + this.ttlMs });
    return prev ? { ...prev.info } : null;
  }

  async get(code: string): Promise<PresenceInfo | null> {
    const e = this.live(code);
    return e ? { ...e.info } : null;
  }

  async refresh(code: string, connId: string): Promise<boolean> {
    const e = this.live(code);
    if (!e || e.info.connId !== connId) return false;
    e.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  async setAccept(code: string, connId: string, accept: boolean): Promise<boolean> {
    const e = this.live(code);
    if (!e || e.info.connId !== connId) return false;
    e.info.accept = accept;
    e.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  async remove(code: string, connId: string): Promise<boolean> {
    const e = this.live(code);
    if (!e || e.info.connId !== connId) return false;
    this.map.delete(code);
    return true;
  }

  async count(): Promise<number> {
    this.sweep();
    return this.map.size;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
