import type { Knex } from 'knex';
import type { Config } from '../../config.js';
import type { Log } from '../../logger.js';
import { createKnex } from '../knex.js';
import { withTimeout } from '../../util/time.js';
import { createMemoryRepos } from './memory.js';
import { createKnexRepos } from './mysql.js';
import { ResilientEventsRepo, ResilientSessionsRepo, WriteQueue } from './resilient.js';
import type { Repos } from './types.js';

export * from './types.js';

export interface RepoBundle {
  repos: Repos;
  /** MySQL 模式下的 knex 实例（迁移、分区维护用），内存模式为 null */
  knex: Knex | null;
  writeQueue: WriteQueue | null;
}

/** 单次仓储调用的上限。MySQL 挂起（连接在但不回包）时，调用方在这个时间后得到错误并走降级，而不是无限等待 */
export const DB_QUERY_TIMEOUT_MS = 10_000;

/** 给每个仓储对象上返回 Promise 的方法加超时（close 除外） */
export function withQueryTimeout<T extends Repos>(repos: T, ms: number): T {
  const wrapRepo = (name: string, repo: object): object =>
    new Proxy(repo, {
      get(target, key, recv) {
        const v = Reflect.get(target, key, recv) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]): unknown => {
          const r = (v as (...a: unknown[]) => unknown).apply(target, args);
          return r instanceof Promise ? withTimeout(r, ms, `${name}.${String(key)}`) : r;
        };
      },
    });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(repos)) {
    out[k] = v && typeof v === 'object' ? wrapRepo(k, v) : v;
  }
  return out as T;
}

/** 按 STORE 创建：memory 完全不需要 MySQL；mysql 模式下会话和安全事件的写入带补写队列 */
export function createRepos(cfg: Config, log: Log): RepoBundle {
  if (cfg.store === 'memory') {
    return { repos: createMemoryRepos(), knex: null, writeQueue: null };
  }
  const knex = createKnex(cfg.mysqlUrl);
  const raw = withQueryTimeout(createKnexRepos(knex), DB_QUERY_TIMEOUT_MS);
  const q = new WriteQueue(log);
  const repos: Repos = {
    ...raw,
    sessions: new ResilientSessionsRepo(raw.sessions, q),
    events: new ResilientEventsRepo(raw.events, q),
    async close() {
      q.stop();
      await q.flush();
      await raw.close();
    },
  };
  return { repos, knex, writeQueue: q };
}
