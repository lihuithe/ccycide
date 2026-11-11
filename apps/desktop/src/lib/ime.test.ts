import { describe, expect, it } from 'vitest';
import { ImeGuard } from './ime';

describe('ImeGuard', () => {
  it('isComposing 为真时交给输入法', () => {
    const g = new ImeGuard();
    expect(g.judge({ key: 'Enter', isComposing: true }, 1000)).toBe('composing');
  });

  it('keyCode 229 视为组字', () => {
    const g = new ImeGuard();
    expect(g.judge({ key: 'Process', keyCode: 229 }, 1000)).toBe('composing');
    expect(g.judge({ key: 'Enter', keyCode: 229 }, 1000)).toBe('composing');
  });

  it('compositionstart 到 compositionend 之间一律视为组字', () => {
    const g = new ImeGuard();
    g.compositionStart();
    expect(g.judge({ key: 'Enter' }, 1000)).toBe('composing');
    g.compositionEnd(1010);
    expect(g.judge({ key: 'a' }, 1011)).toBe('none');
  });

  it('compositionend 之后 50ms 内的 Enter 被吞掉（macOS WebKit 的顺序问题）', () => {
    const g = new ImeGuard();
    g.compositionStart();
    g.compositionEnd(2000);
    expect(g.judge({ key: 'Enter' }, 2000)).toBe('guard');
    expect(g.judge({ key: 'Enter' }, 2049)).toBe('guard');
    expect(g.judge({ key: 'Enter' }, 2050)).toBe('none');
    expect(g.judge({ key: 'Enter' }, 3000)).toBe('none');
  });

  it('50ms 窗口只针对 Enter', () => {
    const g = new ImeGuard();
    g.compositionEnd(2000);
    expect(g.judge({ key: 'ArrowUp' }, 2010)).toBe('none');
  });

  it('没有发生过组字时 Enter 正常', () => {
    expect(new ImeGuard().judge({ key: 'Enter' }, 0)).toBe('none');
  });
});
