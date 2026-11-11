import type { Log } from '../../logger.js';
import type {
  NewSecurityEvent,
  NewSession,
  SecurityEventsRepo,
  SessionPatch,
  SessionsRepo,
} from './types.js';

type Op = () => Promise<unknown>;

/** 数据库返回的“重试也不会成功”的错误：约束冲突、数据不合法、SQL 错误等。连接/超时/死锁/只读/关机这类暂时性错误不算 */
const TRANSIENT_SQL = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN', 'ER_QUERY_INTERRUPTED', 'ER_OPTION_PREVENTS_STATEMENT', 'ER_TOO_MANY_USER_CONNECTIONS', 'ER_ABORTING_CONNECTION', 'ER_NET_READ_ERROR', 'ER_NET_WRITE_ERROR', 'ER_NET_READ_INTERRUPTED', 'ER_NET_WRITE_INTERRUPTED']);

export function isPermanentWriteError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  if (e?.name === 'DuplicateError') return true;
  return typeof e?.code === 'string' && e.code.startsWith('ER_') && !TRANSIENT_SQL.has(e.code);
}

/**
 * 写操作的内存补写队列（实现方案 10.1：MySQL 不可用时，会话记录进入内存队列，恢复后补写，队列满了丢弃并告警）。
 * 队列非空时新的写操作也排队，保证同一会话的 create -> transition 顺序不乱。
 */
export class WriteQueue {
  private queue: Op[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout;
  dropped = 0;

  constructor(
    private log: Log,
    private max = 10_000,
    retryMs = 5_000,
    /** 单次写操作的超时：数据库挂起（连接在但不回包）时不能让调用方一直等 */
    private opTimeoutMs = 5_000,
  ) {
    this.timer = setInterval(() => void this.flush(), retryMs);
    this.timer.unref();
  }

  get size(): number {
    return this.queue.length;
  }

  /** 执行写操作；失败或队列非空则入队，返回 false 表示已排队（而不是已写入） */
  async run(op: Op, what: string): Promise<boolean> {
    if (this.queue.length === 0) {
      try {
        await this.exec(op);
        return true;
      } catch (err) {
        if (isPermanentWriteError(err)) {
          // 比如重放时撞上唯一索引（上一次写入其实已经成功，只是连接断开时客户端没收到确认）：重试没有意义
          this.dropped++;
          this.log.error({ err: (err as Error).message, what }, '数据库拒绝了这次写入（非暂时性错误），已丢弃');
          return false;
        }
        this.log.warn({ err: (err as Error).message, what }, '数据库写入失败，进入补写队列');
      }
    }
    if (this.queue.length >= this.max) {
      this.dropped++;
      this.log.error({ what, dropped: this.dropped }, '补写队列已满，丢弃一条写操作');
      return false;
    }
    this.queue.push(op);
    return false;
  }

  private exec(op: Op): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`数据库写入超过 ${this.opTimeoutMs}ms 没有响应`)), this.opTimeoutMs);
      op().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        try {
          await this.exec(this.queue[0]!);
        } catch (err) {
          if (isPermanentWriteError(err)) {
            // 队首永远写不进去会堵死后面所有的写入：丢弃它继续
            this.dropped++;
            this.log.error({ err: (err as Error).message, pending: this.queue.length }, '补写被数据库拒绝（非暂时性错误），已丢弃');
          } else {
            this.log.warn({ err: (err as Error).message, pending: this.queue.length }, '补写仍然失败，稍后重试');
            return;
          }
        }
        this.queue.shift();
      }
      this.log.info('补写队列已清空');
    } finally {
      this.flushing = false;
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export class ResilientSessionsRepo implements SessionsRepo {
  constructor(
    private inner: SessionsRepo,
    private q: WriteQueue,
  ) {}

  async create(s: NewSession): Promise<void> {
    await this.q.run(() => this.inner.create(s), 'sessions.create');
  }

  get(uid: string): ReturnType<SessionsRepo['get']> {
    return this.inner.get(uid);
  }

  async transition(uid: string, patch: SessionPatch, allowedFrom: number[]): Promise<boolean> {
    // 入队时无法知道结果，乐观返回 true；回放时仍按 allowedFrom 判断
    let result = true;
    const done = await this.q.run(async () => {
      result = await this.inner.transition(uid, patch, allowedFrom);
    }, 'sessions.transition');
    return done ? result : true;
  }

  list(q: Parameters<SessionsRepo['list']>[0]): ReturnType<SessionsRepo['list']> {
    return this.inner.list(q);
  }

  countSince(since: Date): ReturnType<SessionsRepo['countSince']> {
    return this.inner.countSince(since);
  }
}

export class ResilientEventsRepo implements SecurityEventsRepo {
  constructor(
    private inner: SecurityEventsRepo,
    private q: WriteQueue,
  ) {}

  async add(e: NewSecurityEvent): Promise<void> {
    await this.q.run(() => this.inner.add(e), 'security_events.add');
  }

  list(q: Parameters<SecurityEventsRepo['list']>[0]): ReturnType<SecurityEventsRepo['list']> {
    return this.inner.list(q);
  }

  deleteOlderThan(d: Date): Promise<number> {
    return this.inner.deleteOlderThan(d);
  }
}
