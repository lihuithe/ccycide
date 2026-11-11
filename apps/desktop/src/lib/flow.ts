/** 终端输出的 ack 累计（方案 4.7）：每 256KB 或每 100ms 发一次 TermAck */

export const ACK_BYTES = 256 * 1024;
export const ACK_INTERVAL_MS = 100;

export class AckBatcher {
  private rendered = 0;
  private acked = 0;
  private lastAckAt = 0;

  constructor(
    private readonly send: (consumed: number) => void,
    private readonly bytes = ACK_BYTES,
    private readonly intervalMs = ACK_INTERVAL_MS,
  ) {}

  /** 一帧写入 xterm 完成（write 回调）。endOffset = 这帧的 seq + 长度 */
  onRendered(endOffset: number, now: number): void {
    if (endOffset > this.rendered) this.rendered = endOffset;
    if (this.rendered - this.acked >= this.bytes) this.ack(now);
  }

  /** 定时器调用；有未确认的数据且距上次确认已过 intervalMs 时发送 */
  tick(now: number): void {
    if (this.rendered > this.acked && now - this.lastAckAt >= this.intervalMs) this.ack(now);
  }

  get pending(): number {
    return this.rendered - this.acked;
  }

  /** 已渲染到的流偏移，重连续传时作为 lastSeq */
  get renderedOffset(): number {
    return this.rendered;
  }

  private ack(now: number): void {
    this.acked = this.rendered;
    this.lastAckAt = now;
    this.send(this.rendered);
  }
}
