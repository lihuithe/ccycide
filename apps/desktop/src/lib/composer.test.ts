import { describe, expect, it } from 'vitest';
import { ComposerMachine, ESC_CLEAR_WINDOW_MS, MessageHistory, type ComposerContext } from './composer';

const filled: ComposerContext = { empty: false, hasSelection: false, appCursor: false };
const empty: ComposerContext = { empty: true, hasSelection: false, appCursor: false };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ComposerMachine 按键决策', () => {
  it('有内容：Enter 提交，Shift+Enter 本地换行', () => {
    const m = new ComposerMachine();
    expect(m.onKeyDown({ key: 'Enter' }, filled, 0)).toEqual({ type: 'submit' });
    expect(m.onKeyDown({ key: 'Enter', shiftKey: true }, filled, 0)).toEqual({ type: 'default' });
  });

  it('为空：Enter/Esc/Tab/方向键编码直发', () => {
    const m = new ComposerMachine();
    const d = m.onKeyDown({ key: 'Enter' }, empty, 0);
    expect(d.type === 'send' && dec(d.bytes)).toBe('\r');
    const up = m.onKeyDown({ key: 'ArrowUp' }, { ...empty, appCursor: true }, 0);
    expect(up.type === 'send' && dec(up.bytes)).toBe('\x1bOA');
    const st = m.onKeyDown({ key: 'Tab', shiftKey: true }, empty, 0);
    expect(st.type === 'send' && dec(st.bytes)).toBe('\x1b[Z');
  });

  it('为空时普通字符走本地编辑', () => {
    expect(new ComposerMachine().onKeyDown({ key: 'a' }, empty, 0)).toEqual({ type: 'default' });
  });

  it('有内容时方向键、Backspace 走本地编辑', () => {
    const m = new ComposerMachine();
    expect(m.onKeyDown({ key: 'ArrowLeft' }, filled, 0)).toEqual({ type: 'default' });
    expect(m.onKeyDown({ key: 'Backspace' }, filled, 0)).toEqual({ type: 'default' });
  });

  it('Ctrl+C 在任何状态直发，有选中时不发', () => {
    const m = new ComposerMachine();
    const a = m.onKeyDown({ key: 'c', ctrlKey: true }, filled, 0);
    expect(a.type === 'send' && [...a.bytes]).toEqual([3]);
    expect(m.onKeyDown({ key: 'c', ctrlKey: true }, { ...filled, hasSelection: true }, 0)).toEqual({ type: 'default' });
  });

  it('Ctrl+Shift+P 切换直通，Alt+↑/↓ 历史', () => {
    const m = new ComposerMachine();
    expect(m.onKeyDown({ key: 'P', ctrlKey: true, shiftKey: true }, filled, 0)).toEqual({ type: 'togglePassthrough' });
    expect(m.onKeyDown({ key: 'ArrowUp', altKey: true }, empty, 0)).toEqual({ type: 'history', dir: 'prev' });
    expect(m.onKeyDown({ key: 'ArrowDown', altKey: true }, filled, 0)).toEqual({ type: 'history', dir: 'next' });
  });

  describe('Esc 两次清空', () => {
    it('有内容：第一次提示，窗口内第二次清空', () => {
      const m = new ComposerMachine();
      expect(m.onKeyDown({ key: 'Escape' }, filled, 1000)).toEqual({ type: 'escHint' });
      expect(m.onKeyDown({ key: 'Escape' }, filled, 1000 + ESC_CLEAR_WINDOW_MS - 1)).toEqual({ type: 'clear' });
      // 清空后重新计数
      expect(m.onKeyDown({ key: 'Escape' }, filled, 1100)).toEqual({ type: 'escHint' });
    });

    it('超时后第二次视为新的第一次', () => {
      const m = new ComposerMachine();
      m.onKeyDown({ key: 'Escape' }, filled, 0);
      expect(m.onKeyDown({ key: 'Escape' }, filled, ESC_CLEAR_WINDOW_MS + 1)).toEqual({ type: 'escHint' });
    });

    it('中间按了别的键，计数重置', () => {
      const m = new ComposerMachine();
      m.onKeyDown({ key: 'Escape' }, filled, 0);
      m.onKeyDown({ key: 'a' }, filled, 100);
      expect(m.onKeyDown({ key: 'Escape' }, filled, 200)).toEqual({ type: 'escHint' });
    });

    it('为空时 Esc 直发给远端', () => {
      const d = new ComposerMachine().onKeyDown({ key: 'Escape' }, empty, 0);
      expect(d.type === 'send' && dec(d.bytes)).toBe('\x1b');
    });
  });

  describe('输入法', () => {
    it('组字期间 Enter 不提交', () => {
      const m = new ComposerMachine();
      m.ime.compositionStart();
      expect(m.onKeyDown({ key: 'Enter', isComposing: true }, filled, 0)).toEqual({ type: 'ime' });
      expect(m.onKeyDown({ key: 'Enter', keyCode: 229 }, filled, 0)).toEqual({ type: 'ime' });
    });

    it('compositionend 后 50ms 内的 Enter 被吞掉，之后恢复提交', () => {
      const m = new ComposerMachine();
      m.ime.compositionStart();
      m.ime.compositionEnd(500);
      expect(m.onKeyDown({ key: 'Enter' }, filled, 520)).toEqual({ type: 'swallow' });
      expect(m.onKeyDown({ key: 'Enter' }, filled, 600)).toEqual({ type: 'submit' });
    });
  });
});

describe('MessageHistory', () => {
  it('Alt+↑ 从最新往回，Alt+↓ 往前，越过最新恢复草稿', () => {
    const h = new MessageHistory();
    h.push('第一条');
    h.push('第二条');
    expect(h.browse('prev', '草稿')).toBe('第二条');
    expect(h.browse('prev', '第二条')).toBe('第一条');
    expect(h.browse('prev', '第一条')).toBeNull();
    expect(h.browse('next', '第一条')).toBe('第二条');
    expect(h.browse('next', '第二条')).toBe('草稿');
    expect(h.browse('next', '草稿')).toBeNull();
  });

  it('空历史无变化；相邻重复和空白不入历史', () => {
    const h = new MessageHistory();
    expect(h.browse('prev', 'x')).toBeNull();
    h.push('a');
    h.push('a');
    h.push('   ');
    expect(h.size).toBe(1);
  });

  it('超出上限丢弃最旧', () => {
    const h = new MessageHistory(2);
    h.push('1');
    h.push('2');
    h.push('3');
    expect(h.browse('prev', '')).toBe('3');
    expect(h.browse('prev', '')).toBe('2');
    expect(h.browse('prev', '')).toBeNull();
  });

  it('提交后浏览位置复位', () => {
    const h = new MessageHistory();
    h.push('a');
    h.browse('prev', '');
    h.push('b');
    expect(h.browse('prev', '')).toBe('b');
  });
});
