import { memo } from 'react';
import { useCompact, useController } from '../app/hooks';
import type { TermTab } from '../state/store';

const enc = new TextEncoder();

interface KeyDef {
  label: string;
  title?: string;
  /** 固定序列 */
  seq?: string;
  /** 光标键：按终端当前的光标键模式选 ESC O x 或 ESC [ x */
  cursor?: 'A' | 'B' | 'C' | 'D' | 'H' | 'F';
}

/** 手机软键盘没有的按键 */
const KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', title: 'Ctrl+C 中断', seq: '\x03' },
  { label: '^D', title: 'Ctrl+D 结束输入', seq: '\x04' },
  { label: '^Z', title: 'Ctrl+Z 挂起', seq: '\x1a' },
  { label: '↑', cursor: 'A' },
  { label: '↓', cursor: 'B' },
  { label: '←', cursor: 'D' },
  { label: '→', cursor: 'C' },
  { label: 'Home', cursor: 'H' },
  { label: 'End', cursor: 'F' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
];

function bytesFor(k: KeyDef, appCursor: boolean): Uint8Array {
  if (k.cursor) return enc.encode(`\x1b${appCursor ? 'O' : '['}${k.cursor}`);
  return enc.encode(k.seq ?? '');
}

/**
 * 手机上的虚拟按键条：Esc、Tab、Ctrl+C、方向键等软键盘上没有的按键，直接发给终端。
 * 只在紧凑布局（手机）里显示。按下时不抢走输入框焦点，软键盘不会收起。
 */
function MobileKeysImpl({ tab }: { tab: TermTab }) {
  const c = useController();
  const compact = useCompact();
  if (!compact) return null;
  return (
    <div className="mobile-keys" role="toolbar" aria-label="终端按键">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="mk"
          title={k.title}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => c.sendInput(tab.key, bytesFor(k, tab.modes.appCursor))}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

export const MobileKeys = memo(MobileKeysImpl);
