/** 按键编码：输入框为空时的特殊键、Ctrl 组合键、动作目录里的按键名（方案 5.7.3 / 18.5.3） */

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface TermKeyModes {
  /** 远端处于应用光标模式：方向键用 ESC O x */
  appCursor: boolean;
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

/** Ctrl+字母 → 控制码（a=0x01 … z=0x1a）。非单个字母返回 null */
export function ctrlCode(key: string): number | null {
  if (key.length !== 1) return null;
  const c = key.toLowerCase().charCodeAt(0);
  if (c < 97 || c > 122) return null;
  return c - 96;
}

/** 这些 Ctrl 组合键留给浏览器的编辑行为（粘贴、剪切、全选、撤销） */
const CTRL_LOCAL_KEYS = new Set(['v', 'x', 'a', 'z']);

/** 光标键：普通模式 ESC [ x，应用光标模式 ESC O x */
const CURSOR_FINAL: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
};

function cursorSeq(key: string, appCursor: boolean): string | null {
  const f = CURSOR_FINAL[key];
  if (!f) return null;
  return (appCursor ? '\x1bO' : '\x1b[') + f;
}

/**
 * 输入框为空时的特殊键编码。无对应编码返回 null（交给浏览器默认行为）。
 * 只处理无修饰键（Shift+Tab 除外）的按键。
 */
export function encodeKey(e: KeyLike, modes: TermKeyModes): Uint8Array | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.shiftKey) return e.key === 'Tab' ? bytes('\x1b[Z') : null;
  switch (e.key) {
    case 'Enter':
      return bytes('\r');
    case 'Escape':
      return bytes('\x1b');
    case 'Tab':
      return bytes('\t');
    case 'Backspace':
      return bytes('\x7f');
    case 'Delete':
      return bytes('\x1b[3~');
    case 'PageUp':
      return bytes('\x1b[5~');
    case 'PageDown':
      return bytes('\x1b[6~');
    default: {
      const s = cursorSeq(e.key, modes.appCursor);
      return s ? bytes(s) : null;
    }
  }
}

/** 任何状态下都直接发给远端的 Ctrl+字母。返回字节或 null（含：有选中文本时的 Ctrl+C 留给复制） */
export function encodeCtrlCombo(e: KeyLike, hasSelection: boolean): Uint8Array | null {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'c' && hasSelection) return null;
  if (CTRL_LOCAL_KEYS.has(k)) return null;
  const code = ctrlCode(k);
  return code === null ? null : Uint8Array.of(code);
}

/** 切换直通模式的快捷键：Ctrl+Shift+P（macOS 为 Cmd+Shift+P） */
export function isTogglePassthrough(e: KeyLike): boolean {
  return !!(e.ctrlKey || e.metaKey) && !!e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p';
}

/**
 * 动作目录里的按键名 → 字节串（18.5.3）。
 * 支持 esc enter tab shift+tab up/down/left/right backspace ctrl+x alt+x。
 */
export function keyNameToSeq(name: string, appCursor = false): string | null {
  const n = name.trim().toLowerCase();
  switch (n) {
    case 'esc':
      return '\x1b';
    case 'enter':
      return '\r';
    case 'tab':
      return '\t';
    case 'shift+tab':
      return '\x1b[Z';
    case 'backspace':
      return '\x7f';
    case 'up':
      return cursorSeq('ArrowUp', appCursor);
    case 'down':
      return cursorSeq('ArrowDown', appCursor);
    case 'right':
      return cursorSeq('ArrowRight', appCursor);
    case 'left':
      return cursorSeq('ArrowLeft', appCursor);
  }
  const m = /^(ctrl|alt)\+([a-z])$/.exec(n);
  if (m) return m[1] === 'ctrl' ? String.fromCharCode(m[2].charCodeAt(0) - 96) : '\x1b' + m[2];
  return null;
}

/** xterm onData 的一段数据是否恰好是 returnKeys 中的某个键（临时直通结束判定；光标键两种模式都认） */
export function dataHitsReturnKey(data: string, returnKeys: string[]): boolean {
  return returnKeys.some((k) => [false, true].some((app) => keyNameToSeq(k, app) === data));
}

/** 按键名的中文显示，用于“按 Esc 或回车结束”这类提示 */
export function keyNameLabel(name: string): string {
  switch (name.toLowerCase()) {
    case 'enter':
      return '回车';
    case 'esc':
      return 'Esc';
    case 'tab':
      return 'Tab';
    case 'shift+tab':
      return 'Shift+Tab';
    case 'backspace':
      return '退格';
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'left':
      return '←';
    case 'right':
      return '→';
    default:
      return name;
  }
}
