import type { Redis } from 'ioredis';
import type { BusMessage, SignalBus } from './types.js';

const BROADCAST = 'signal:broadcast';

/** 进程内总线：同一进程里起多个信令实例（测试）或单实例时使用 */
export class MemoryBus implements SignalBus {
  private subs = new Map<string, Set<(m: BusMessage) => void>>();

  async subscribe(instanceId: string, handler: (m: BusMessage) => void): Promise<() => Promise<void>> {
    const set = this.subs.get(instanceId) ?? new Set();
    set.add(handler);
    this.subs.set(instanceId, set);
    return async () => {
      set.delete(handler);
    };
  }

  async publish(instanceId: string, m: BusMessage): Promise<number> {
    const set = this.subs.get(instanceId);
    if (!set || set.size === 0) return 0;
    // 异步投递，行为上与真实网络一致（不在发送方的调用栈里执行处理函数）
    for (const h of set) queueMicrotask(() => h(m));
    return set.size;
  }

  async broadcast(m: BusMessage): Promise<void> {
    for (const set of this.subs.values()) for (const h of set) queueMicrotask(() => h(m));
  }
}

/** Redis 发布订阅：频道 signal:{实例ID}，另有广播频道 signal:broadcast */
export class RedisBus implements SignalBus {
  private sub: Redis | null = null;
  private handlers = new Map<string, Set<(m: BusMessage) => void>>();

  constructor(
    private pub: Redis,
    private makeSubscriber: () => Redis,
    private onError: (err: unknown) => void = () => {},
  ) {}

  async subscribe(instanceId: string, handler: (m: BusMessage) => void): Promise<() => Promise<void>> {
    if (!this.sub) {
      this.sub = this.makeSubscriber();
      this.sub.on('message', (channel: string, raw: string) => {
        let m: BusMessage;
        try {
          m = JSON.parse(raw) as BusMessage;
        } catch (e) {
          this.onError(e);
          return;
        }
        for (const h of this.handlers.get(channel) ?? []) h(m);
      });
      this.sub.on('error', (e: unknown) => this.onError(e));
    }
    const own = `signal:${instanceId}`;
    for (const ch of [own, BROADCAST]) {
      const set = this.handlers.get(ch) ?? new Set();
      set.add(handler);
      this.handlers.set(ch, set);
    }
    await this.sub.subscribe(own, BROADCAST);
    return async () => {
      this.handlers.get(own)?.delete(handler);
      this.handlers.get(BROADCAST)?.delete(handler);
      await this.sub?.unsubscribe(own).catch(() => {});
    };
  }

  async publish(instanceId: string, m: BusMessage): Promise<number> {
    // PUBLISH 返回收到消息的订阅者数
    return Number(await this.pub.publish(`signal:${instanceId}`, JSON.stringify(m)));
  }

  async broadcast(m: BusMessage): Promise<void> {
    await this.pub.publish(BROADCAST, JSON.stringify(m));
  }

  async close(): Promise<void> {
    if (this.sub) {
      this.sub.disconnect();
      this.sub = null;
    }
  }
}
