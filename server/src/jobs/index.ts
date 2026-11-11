import type { Ctx } from '../context.js';
import { every } from '../util/time.js';
import { maintainSessionPartitions } from './partitions.js';

/** 多实例时同一任务只让一个实例执行：用 KV 的 SETNX 抢锁 */
async function withLock(ctx: Ctx, name: string, ttlMs: number, fn: () => Promise<void>): Promise<void> {
  try {
    if (!(await ctx.stores.kv.setNx(`job:${name}`, ctx.cfg.relay.nodeName, ttlMs))) return;
    await fn();
  } catch (err) {
    ctx.log.error({ err: (err as Error).message, job: name }, '定时任务失败');
  }
}

/**
 * 定时任务（实现方案 6.2 jobs/）：
 *  - 每分钟：把内存里的每日统计累加器写入 daily_stats
 *  - 每 10 分钟：清理过期封禁
 *  - 每 6 小时：安全事件（6 个月）、管理审计（2 年）的保留期清理；MySQL 下维护 sessions 分区
 * 内存存储的过期清理在各 store 内部自带定时器。
 */
export function startJobs(ctx: Ctx): () => void {
  const timers: NodeJS.Timeout[] = [];

  timers.push(every(60_000, () => void ctx.collector.flush()));

  timers.push(
    every(10 * 60_000, () =>
      void withLock(ctx, 'bans-gc', 9 * 60_000, async () => {
        const n = await ctx.repos.bans.deleteExpired();
        if (n > 0) ctx.log.info({ n }, '已清理过期封禁');
      }),
    ),
  );

  const retention = async (): Promise<void> => {
    await withLock(ctx, 'retention', 5 * 3600_000, async () => {
      const now = Date.now();
      const e = await ctx.repos.events.deleteOlderThan(new Date(now - 183 * 86400_000));
      const a = await ctx.repos.audit.deleteOlderThan(new Date(now - 730 * 86400_000));
      if (e + a > 0) ctx.log.info({ events: e, audit: a }, '已清理过期记录');
      if (ctx.knex) {
        const stmts = await maintainSessionPartitions(ctx.knex);
        if (stmts.length > 0) ctx.log.info({ stmts }, 'sessions 分区已维护');
      }
    });
  };
  timers.push(every(6 * 3600_000, () => void retention()));
  // 启动后稍等再跑一次，保证新库尽快有未来分区
  const first = setTimeout(() => void retention(), 15_000);
  first.unref();
  timers.push(first);

  return () => {
    for (const t of timers) clearInterval(t);
  };
}
