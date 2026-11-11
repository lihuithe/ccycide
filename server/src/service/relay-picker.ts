import type { Config } from '../config.js';
import type { Log } from '../logger.js';
import type { Repos, RelayNodeRecord } from '../db/repos/index.js';
import type { RelayNodeReport, Stores } from '../store/index.js';
import { withTimeout } from '../util/time.js';

export interface PickedRelay {
  name: string;
  publicUrl: string;
  region: string;
}

/**
 * 中继节点选择（实现方案 6.5）：
 * 过滤掉下线、排空、停用、已满的节点；优先同地区；同地区内选负载最低的。
 * 内存模式下（没有 Redis，信令与中继可能是两个互不相通的进程）如果没有任何上报，退回到本进程配置里的节点。
 */
export class RelayPicker {
  private tableCache: { at: number; rows: RelayNodeRecord[] } | null = null;

  constructor(
    private cfg: Config,
    private stores: Stores,
    private repos: Repos,
    private log: Log,
  ) {}

  invalidate(): void {
    this.tableCache = null;
  }

  private async table(): Promise<RelayNodeRecord[]> {
    const now = Date.now();
    if (this.tableCache && now - this.tableCache.at < 30_000) return this.tableCache.rows;
    try {
      const rows = await withTimeout(this.repos.relayNodes.list(), 3000, 'relay_nodes 查询');
      this.tableCache = { at: now, rows };
      return rows;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, '读取 relay_nodes 失败');
      return this.tableCache?.rows ?? [];
    }
  }

  /** 全部在线节点（含登记状态），给管理接口用 */
  async nodes(): Promise<Array<RelayNodeReport & { registered: RelayNodeRecord | null }>> {
    const [reports, table] = await Promise.all([this.stores.registry.list(), this.table()]);
    return reports.map((r) => ({ ...r, registered: table.find((t) => t.name === r.name) ?? null }));
  }

  /** 失败（Redis 不可用）时抛出，由调用方降级 */
  async pick(preferRegion?: string): Promise<PickedRelay | null> {
    const reports = await this.stores.registry.list();
    if (reports.length === 0 && !this.stores.isRedis) {
      const r = this.cfg.relay;
      return { name: r.nodeName, publicUrl: r.publicUrl, region: r.region };
    }
    const table = await this.table();
    const candidates = reports
      .map((r) => {
        const reg = table.find((t) => t.name === r.name);
        return { r, reg, capacity: reg?.capacity ?? r.capacity };
      })
      .filter((c) => c.r.status === 'up' && (!c.reg || c.reg.status === 1) && c.r.sessions < c.capacity);
    if (candidates.length === 0) return null;
    const load = (c: (typeof candidates)[number]): number => c.r.sessions / Math.max(1, c.capacity) + c.r.bandwidth * 0.1;
    candidates.sort((a, b) => {
      const ra = preferRegion && a.r.region === preferRegion ? 0 : 1;
      const rb = preferRegion && b.r.region === preferRegion ? 0 : 1;
      return ra - rb || load(a) - load(b);
    });
    const best = candidates[0]!.r;
    return { name: best.name, publicUrl: best.publicUrl, region: best.region };
  }
}
