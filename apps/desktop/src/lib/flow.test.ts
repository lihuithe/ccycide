import { describe, expect, it } from 'vitest';
import { ACK_BYTES, AckBatcher } from './flow';

function make() {
  const sent: number[] = [];
  return { sent, b: new AckBatcher((c) => sent.push(c)) };
}

describe('AckBatcher', () => {
  it('累计不足 256KB 且未到 100ms 时不发', () => {
    const { sent, b } = make();
    b.onRendered(1000, 10);
    b.tick(50);
    expect(sent).toEqual([]);
  });

  it('累计达到 256KB 立即发，consumed 为流偏移', () => {
    const { sent, b } = make();
    b.onRendered(100_000, 0);
    b.onRendered(ACK_BYTES, 5);
    expect(sent).toEqual([ACK_BYTES]);
  });

  it('超过 100ms 的定时器 tick 发送剩余未确认数据', () => {
    const { sent, b } = make();
    b.onRendered(5000, 0);
    b.tick(99);
    expect(sent).toEqual([]);
    b.tick(100);
    expect(sent).toEqual([5000]);
  });

  it('没有新数据不重复确认', () => {
    const { sent, b } = make();
    b.onRendered(5000, 0);
    b.tick(100);
    b.tick(300);
    b.tick(500);
    expect(sent).toEqual([5000]);
  });

  it('seq 跳变（重连复位回放）后按真实偏移确认', () => {
    const { sent, b } = make();
    b.onRendered(1_000_000, 0);
    expect(sent).toEqual([1_000_000]);
    b.onRendered(1_000_000 + ACK_BYTES + 10, 10);
    expect(sent).toEqual([1_000_000, 1_000_000 + ACK_BYTES + 10]);
    expect(b.pending).toBe(0);
  });

  it('乱序的小偏移不会让确认倒退', () => {
    const { sent, b } = make();
    b.onRendered(ACK_BYTES, 0);
    b.onRendered(10, 1);
    b.tick(500);
    expect(sent).toEqual([ACK_BYTES]);
    expect(b.renderedOffset).toBe(ACK_BYTES);
  });
});
