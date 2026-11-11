import type { Redis } from 'ioredis';
import type { RelaySessionEvent, SessionEventChannel } from './types.js';

type Handler = (ev: RelaySessionEvent) => Promise<void> | void;

/** 内存版：同进程内直接回调（dev:all 模式） */
export class MemorySessionEvents implements SessionEventChannel {
  private handlers = new Set<Handler>();

  async publish(ev: RelaySessionEvent): Promise<void> {
    for (const h of this.handlers) {
      queueMicrotask(() => {
        Promise.resolve(h(ev)).catch(() => {});
      });
    }
  }

  consume(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

const LIST_KEY = 'relay:events';
/** 列表上限：防止没有信令实例消费时无限增长 */
const LIST_MAX = 50_000;
/** 本地缓冲上限：Redis 长时间不可用时最多攒这么多条，超出丢弃最旧的 */
const BUFFER_MAX = 10_000;

/**
 * Redis 版：中继 RPUSH 到列表，信令定时 LPOP 取走。
 * 中继可以部署在没有 MySQL 的机器上，所以会话的字节数和结束状态通过这里回传，由信令写库。
 *
 * Redis 暂时不可用时 publish 不丢事件：失败的事件留在本进程的有界缓冲里，按原顺序定时重试，恢复后补发
 * （否则断开期间结束的会话会永远停在“已认证”状态，字节数也记不上）。进程在 Redis 恢复前退出则缓冲里的事件会丢。
 */
export class RedisSessionEvents implements SessionEventChannel {
  private buffer: RelaySessionEvent[] = [];
  private flushing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** 因缓冲溢出被丢弃的事件数（测试/排查用） */
  dropped = 0;

  constructor(
    private redis: Redis,
    private pollMs = 500,
    private onError: (e: unknown) => void = () => {},
    private retryMs = 1000,
  ) {}

  /** 缓冲中等待补发的事件数 */
  get pending(): number {
    return this.buffer.length;
  }

  async publish(ev: RelaySessionEvent): Promise<void> {
    // 缓冲非空说明 Redis 刚刚出过问题：排在后面，保证事件顺序（paired 先于 ended）
    if (this.buffer.length > 0 || this.flushing) {
      this.enqueue(ev);
      return;
    }
    try {
      await this.push(ev);
    } catch (e) {
      this.onError(e);
      this.enqueue(ev);
    }
  }

  private async push(ev: RelaySessionEvent): Promise<void> {
    // 一个 MULTI 里完成入列和截断，避免“入列成功、截断失败”导致重试时重复
    const res = await this.redis.multi().rpush(LIST_KEY, JSON.stringify(ev)).ltrim(LIST_KEY, -LIST_MAX, -1).exec();
    const failed = res?.find(([err]) => err);
    if (!res || failed) throw failed?.[0] ?? new Error('MULTI 被中止');
  }

  private enqueue(ev: RelaySessionEvent): void {
    this.buffer.push(ev);
    if (this.buffer.length > BUFFER_MAX) {
      this.buffer.shift();
      this.dropped++;
    }
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => void this.flush(), this.retryMs);
      this.retryTimer.unref();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        try {
          await this.push(this.buffer[0]!);
        } catch (e) {
          this.onError(e);
          return; // 仍不可用，下个周期再试
        }
        this.buffer.shift();
      }
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } finally {
      this.flushing = false;
    }
  }

  consume(handler: Handler): () => void {
    let stopped = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      try {
        for (;;) {
          const batch = await this.redis.lpop(LIST_KEY, 100);
          if (!batch || batch.length === 0) break;
          for (const raw of batch) {
            try {
              await handler(JSON.parse(raw) as RelaySessionEvent);
            } catch (e) {
              this.onError(e);
            }
          }
        }
      } catch (e) {
        this.onError(e);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), this.pollMs);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}
