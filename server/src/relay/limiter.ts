/**
 * 令牌桶：rate 字节/秒，容量 burst 字节（允许短时突发）。
 * take 不拒绝，而是返回“需要等多久”，调用方据此暂停读取源端，让 TCP 流控把压力传回发送方。
 * 余额可以为负（已经读进来的数据不能退回去），下次 take 会等得更久，整体速率仍然受控。
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private rate: number,
    private burst: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** 消耗 n 字节，返回需要等待的毫秒数（0 表示可以立即继续） */
  take(n: number): number {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    this.tokens -= n;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.rate) * 1000);
  }
}
