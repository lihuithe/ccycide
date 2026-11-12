import { describe, expect, it } from 'vitest';
import { RESET_SEQ, TermTable, dedup } from './terms';

const b = (s: string): Uint8Array => new TextEncoder().encode(s);
const t = (u: Uint8Array): string => new TextDecoder().decode(u);

describe('终端输出按偏移去重（与 Rust controller/term.rs 一致）', () => {
  it('整段重复丢弃、重叠裁剪、正常衔接、跳变原样交出', () => {
    expect(dedup(10, 0, b('abcde'), false)).toEqual({ drop: true });
    const cut = dedup(10, 8, b('abcdef'), false);
    expect(cut.drop).toBe(false);
    if (!cut.drop) expect([cut.seq, t(cut.data)]).toEqual([10, 'cdef']);
    const same = dedup(10, 10, b('xy'), false);
    if (!same.drop) expect([same.seq, t(same.data)]).toEqual([10, 'xy']);
    const jump = dedup(10, 100, b('zz'), false);
    if (!jump.drop) expect(jump.seq).toBe(100);
    expect(dedup(10, 12, b(''), false)).toEqual({ drop: true });
  });

  it('附着后第一段若是跨过已收偏移的复位序列，原样交出；否则按重叠裁剪', () => {
    // 被控端的复位帧 seq = 回放起点 - 2，所以会跨过 received
    const first = dedup(10, 9, RESET_SEQ, true);
    expect(first.drop).toBe(false);
    if (!first.drop) expect([first.seq, first.data.length]).toEqual([9, 2]);
    // 不是第一段：普通裁剪，只剩跨过 received 之后的 1 个字节
    const cut = dedup(10, 9, RESET_SEQ, false);
    if (!cut.drop) expect([cut.seq, cut.data.length]).toEqual([10, 1]);
    // 整段在 received 之前：丢弃
    expect(dedup(10, 8, RESET_SEQ, true)).toEqual({ drop: true });
  });
});

describe('TermTable', () => {
  it('附着、输出、确认偏移、断线保留偏移并可续传', () => {
    const tb = new TermTable();
    tb.onAttached('T1', 3, { cols: 80, rows: 24 });
    expect(tb.onOutput(3, 0, b('hello'))?.seq).toBe(0);
    expect(tb.onOutput(3, 0, b('hello'))).toBeNull(); // 重复
    expect(tb.onOutput(99, 0, b('x'))).toBeNull(); // 未知通道
    // 界面确认已渲染 5：发给被控端；再确认同样的值没有新进展
    expect(tb.noteRendered('T1', 5)).toEqual({ channel: 3, offset: 5 });
    expect(tb.noteRendered('T1', 5)).toBeNull();
    // 不能确认还没收到的数据
    expect(tb.noteRendered('T1', 999)).toBeNull();

    tb.dropChannels();
    expect(tb.resumable()).toEqual([{ id: 'T1', lastSeq: 5, size: { cols: 80, rows: 24 } }]);
    // 重新附着：新通道号，偏移续上，重叠部分被裁掉
    tb.onAttached('T1', 7, { cols: 80, rows: 24 });
    const r = tb.onOutput(7, 3, b('lo world'));
    expect(r?.seq).toBe(5);
    expect(r && t(r.data)).toBe(' world');
  });

  it('被接管 / 已退出的终端不会自动重新附着', () => {
    const tb = new TermTable();
    tb.onAttached('A', 1, { cols: 80, rows: 24 });
    tb.onAttached('B', 2, { cols: 80, rows: 24 });
    tb.markTaken('A');
    const e = tb.get('B');
    if (e) e.exited = true;
    expect(tb.resumable()).toEqual([]);
  });
});
