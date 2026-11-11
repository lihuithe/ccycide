import type { Log } from '../logger.js';
import type { DeviceRecord, DevicesRepo } from '../db/repos/index.js';
import { withTimeout } from '../util/time.js';

/**
 * 设备记录的进程内缓存（默认 5 分钟），信令认证每次都要用公钥验签，不能每次都查库。
 * 数据库不可用时，即使缓存已过期也继续使用旧记录（实现方案 10.1：公钥缓存延长有效期）。
 */
export class DeviceDirectory {
  private cache = new Map<string, { rec: DeviceRecord; at: number }>();

  constructor(
    private repo: DevicesRepo,
    private log: Log,
    private ttlMs = 5 * 60_000,
    private maxEntries = 200_000,
  ) {}

  async getByUid(uid: string): Promise<DeviceRecord | null> {
    const hit = this.cache.get(uid);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.rec;
    try {
      // 超时较短：库卡住时尽快落到“使用过期缓存”的分支
      const rec = await withTimeout(this.repo.findByUid(uid), 3000, '设备查询');
      if (rec) {
        if (this.cache.size >= this.maxEntries) this.cache.clear();
        this.cache.set(uid, { rec, at: now });
      } else {
        this.cache.delete(uid);
      }
      return rec;
    } catch (err) {
      if (hit) {
        this.log.warn({ err: (err as Error).message }, '设备查询失败，使用过期缓存');
        return hit.rec;
      }
      throw err;
    }
  }

  invalidate(uid: string): void {
    this.cache.delete(uid);
  }
}
