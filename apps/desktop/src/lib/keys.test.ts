import { describe, expect, it } from 'vitest';
import { ctrlCode, dataHitsReturnKey, encodeCtrlCombo, encodeKey, isTogglePassthrough, keyNameToSeq } from './keys';

const str = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const normal = { appCursor: false };
const app = { appCursor: true };

describe('encodeKey（输入框为空时的特殊键）', () => {
  it('Enter / Esc / Tab / Backspace', () => {
    expect(str(encodeKey({ key: 'Enter' }, normal))).toBe('\r');
    expect(str(encodeKey({ key: 'Escape' }, normal))).toBe('\x1b');
    expect(str(encodeKey({ key: 'Tab' }, normal))).toBe('\t');
    expect(str(encodeKey({ key: 'Backspace' }, normal))).toBe('\x7f');
  });

  it('Shift+Tab 编码为 ESC[Z，且与光标模式无关', () => {
    expect(str(encodeKey({ key: 'Tab', shiftKey: true }, normal))).toBe('\x1b[Z');
    expect(str(encodeKey({ key: 'Tab', shiftKey: true }, app))).toBe('\x1b[Z');
  });

  it('方向键：普通模式 ESC[A，应用光标模式 ESC O A', () => {
    expect(str(encodeKey({ key: 'ArrowUp' }, normal))).toBe('\x1b[A');
    expect(str(encodeKey({ key: 'ArrowDown' }, normal))).toBe('\x1b[B');
    expect(str(encodeKey({ key: 'ArrowRight' }, normal))).toBe('\x1b[C');
    expect(str(encodeKey({ key: 'ArrowLeft' }, normal))).toBe('\x1b[D');
    expect(str(encodeKey({ key: 'ArrowUp' }, app))).toBe('\x1bOA');
    expect(str(encodeKey({ key: 'ArrowDown' }, app))).toBe('\x1bOB');
    expect(str(encodeKey({ key: 'ArrowRight' }, app))).toBe('\x1bOC');
    expect(str(encodeKey({ key: 'ArrowLeft' }, app))).toBe('\x1bOD');
  });

  it('Home/End 随光标模式变化，PageUp/PageDown 不变', () => {
    expect(str(encodeKey({ key: 'Home' }, normal))).toBe('\x1b[H');
    expect(str(encodeKey({ key: 'End' }, normal))).toBe('\x1b[F');
    expect(str(encodeKey({ key: 'Home' }, app))).toBe('\x1bOH');
    expect(str(encodeKey({ key: 'End' }, app))).toBe('\x1bOF');
    expect(str(encodeKey({ key: 'PageUp' }, app))).toBe('\x1b[5~');
    expect(str(encodeKey({ key: 'PageDown' }, normal))).toBe('\x1b[6~');
  });

  it('带修饰键或普通字符不编码', () => {
    expect(encodeKey({ key: 'ArrowUp', altKey: true }, normal)).toBeNull();
    expect(encodeKey({ key: 'Enter', shiftKey: true }, normal)).toBeNull();
    expect(encodeKey({ key: 'a' }, normal)).toBeNull();
    expect(encodeKey({ key: 'Enter', ctrlKey: true }, normal)).toBeNull();
  });
});

describe('Ctrl 组合键', () => {
  it('ctrlCode：a=1 … z=26', () => {
    expect(ctrlCode('a')).toBe(1);
    expect(ctrlCode('C')).toBe(3);
    expect(ctrlCode('z')).toBe(26);
    expect(ctrlCode('1')).toBeNull();
    expect(ctrlCode('Enter')).toBeNull();
  });

  it('Ctrl+C/D/L/R/O 直接发给远端', () => {
    expect([...encodeCtrlCombo({ key: 'c', ctrlKey: true }, false)!]).toEqual([3]);
    expect([...encodeCtrlCombo({ key: 'd', ctrlKey: true }, false)!]).toEqual([4]);
    expect([...encodeCtrlCombo({ key: 'l', ctrlKey: true }, false)!]).toEqual([12]);
    expect([...encodeCtrlCombo({ key: 'r', ctrlKey: true }, false)!]).toEqual([18]);
    expect([...encodeCtrlCombo({ key: 'o', ctrlKey: true }, false)!]).toEqual([15]);
  });

  it('有选中文本时 Ctrl+C 留给复制', () => {
    expect(encodeCtrlCombo({ key: 'c', ctrlKey: true }, true)).toBeNull();
  });

  it('Ctrl+V/X/A/Z 留给浏览器编辑', () => {
    for (const k of ['v', 'x', 'a', 'z']) expect(encodeCtrlCombo({ key: k, ctrlKey: true }, false)).toBeNull();
  });

  it('Ctrl+Shift+字母不走这里', () => {
    expect(encodeCtrlCombo({ key: 'P', ctrlKey: true, shiftKey: true }, false)).toBeNull();
  });
});

describe('直通切换快捷键', () => {
  it('Ctrl+Shift+P 与 Cmd+Shift+P', () => {
    expect(isTogglePassthrough({ key: 'P', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isTogglePassthrough({ key: 'p', metaKey: true, shiftKey: true })).toBe(true);
    expect(isTogglePassthrough({ key: 'p', ctrlKey: true })).toBe(false);
    expect(isTogglePassthrough({ key: 'p', shiftKey: true })).toBe(false);
  });
});

describe('动作目录按键名', () => {
  it('基本按键', () => {
    expect(keyNameToSeq('esc')).toBe('\x1b');
    expect(keyNameToSeq('enter')).toBe('\r');
    expect(keyNameToSeq('shift+tab')).toBe('\x1b[Z');
    expect(keyNameToSeq('ctrl+o')).toBe('\x0f');
    expect(keyNameToSeq('alt+p')).toBe('\x1bp');
    expect(keyNameToSeq('up')).toBe('\x1b[A');
    expect(keyNameToSeq('up', true)).toBe('\x1bOA');
    expect(keyNameToSeq('f13')).toBeNull();
  });

  it('returnKeys 命中判定：先于其它逻辑，光标模式两种都认', () => {
    expect(dataHitsReturnKey('\r', ['enter', 'esc'])).toBe(true);
    expect(dataHitsReturnKey('\x1b', ['enter', 'esc'])).toBe(true);
    expect(dataHitsReturnKey('a', ['enter', 'esc'])).toBe(false);
    expect(dataHitsReturnKey('\x1b[A', ['enter', 'esc'])).toBe(false);
    expect(dataHitsReturnKey('\x1bOA', ['up'])).toBe(true);
    expect(dataHitsReturnKey('\x1b[A', ['up'])).toBe(true);
  });
});
