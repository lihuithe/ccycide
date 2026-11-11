import type { Knex } from 'knex';

export interface PartitionInfo {
  name: string;
  /** 上界（不含），如 2026-12-01；MAXVALUE 分区为 null */
  bound: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const firstOfMonth = (y: number, m0: number): Date => new Date(Date.UTC(y, m0, 1));
const iso = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
const pname = (d: Date): string => `p${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;

/**
 * 计算 sessions 表分区的维护语句（实现方案 7.2：每月新建下月分区，删除 6 个月前的分区）。
 * 纯函数，不连库，方便单元测试。返回要依次执行的 SQL。
 */
export function planPartitionChanges(existing: PartitionInfo[], now: Date, aheadMonths = 2, keepMonths = 6): string[] {
  const sql: string[] = [];
  const bounded = existing.filter((p) => p.bound !== null).sort((a, b) => a.bound!.localeCompare(b.bound!));

  // 新建：从现有最大上界所在月份开始，一直建到“当前月 + aheadMonths”
  let next: Date;
  if (bounded.length > 0) {
    const [y, m] = bounded[bounded.length - 1]!.bound!.split('-').map(Number) as [number, number];
    next = firstOfMonth(y, m - 1);
  } else {
    next = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth());
  }
  const target = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + aheadMonths);
  const hasMax = existing.some((p) => p.bound === null);
  while (next <= target && hasMax) {
    const upper = firstOfMonth(next.getUTCFullYear(), next.getUTCMonth() + 1);
    sql.push(
      `ALTER TABLE sessions REORGANIZE PARTITION pmax INTO (PARTITION ${pname(next)} VALUES LESS THAN ('${iso(upper)}'), PARTITION pmax VALUES LESS THAN (MAXVALUE))`,
    );
    next = upper;
  }

  // 删除：上界不晚于“当前月第一天往前 keepMonths 个月”的分区
  const cutoff = iso(firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() - keepMonths));
  for (const p of bounded) {
    if (p.bound! <= cutoff) sql.push(`ALTER TABLE sessions DROP PARTITION ${p.name}`);
  }
  return sql;
}

/** 读取 sessions 表现有的分区 */
export async function listSessionPartitions(knex: Knex): Promise<PartitionInfo[]> {
  const res = await knex.raw(
    `SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS bound
       FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND PARTITION_NAME IS NOT NULL
      ORDER BY PARTITION_ORDINAL_POSITION`,
  );
  const rows = (res[0] ?? []) as Array<{ name?: string; bound?: string; NAME?: string; BOUND?: string }>;
  return rows.map((r) => {
    const raw = String(r.bound ?? r.BOUND ?? '');
    const m = /(\d{4}-\d{2}-\d{2})/.exec(raw);
    return { name: String(r.name ?? r.NAME), bound: m ? m[1]! : null };
  });
}

export async function maintainSessionPartitions(knex: Knex, now = new Date()): Promise<string[]> {
  const stmts = planPartitionChanges(await listSessionPartitions(knex), now);
  for (const s of stmts) await knex.raw(s);
  return stmts;
}
