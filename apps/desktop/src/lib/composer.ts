/**
 * 输入框状态机（方案 5.7.3 按键规则表）：输入框内容在本地编辑，
 * 这里只负责“按下某个键该做什么”的决策，以及 Esc 两次清空、本地历史的状态。
 */
import { encodeCtrlCombo, encodeKey, isTogglePassthrough, type KeyLike } from './keys';
import { ImeGuard, type ImeKeyEvent } from './ime';

export const ESC_CLEAR_WINDOW_MS = 1500;
export const HISTORY_LIMIT = 100;

export interface ComposerKeyEvent extends KeyLike, ImeKeyEvent {}

export interface ComposerContext {
  /** 输入框无文字且无附件 */
  empty: boolean;
  /** 输入框或终端里有选中文本（Ctrl+C 留给复制） */
  hasSelection: boolean;
  /** 远端应用光标模式 */
  appCursor: boolean;
}

export type KeyDecision =
  /** 输入法正在处理：什么都不做，也不 preventDefault */
  | { type: 'ime' }
  /** 吞掉按键（组字刚结束的 Enter） */
  | { type: 'swallow' }
  /** 交给浏览器默认行为（本地编辑） */
  | { type: 'default' }
  | { type: 'send'; bytes: Uint8Array }
  | { type: 'submit' }
  | { type: 'togglePassthrough' }
  | { type: 'history'; dir: 'prev' | 'next' }
  /** 第一次 Esc：提示再按一次清空 */
  | { type: 'escHint' }
  | { type: 'clear' };

/** 本地消息历史，Alt+↑/↓ 浏览；到最新一条之后再按↓恢复浏览前正在写的草稿 */
export class MessageHistory {
  private items: string[] = [];
  private cursor: number | null = null;
  private draft = '';

  constructor(private readonly limit = HISTORY_LIMIT) {}

  push(text: string): void {
    this.cursor = null;
    if (!text.trim()) return;
    if (this.items[this.items.length - 1] === text) return;
    this.items.push(text);
    if (this.items.length > this.limit) this.items.shift();
  }

  /** 返回应显示的新内容；没有变化返回 null */
  browse(dir: 'prev' | 'next', current: string): string | null {
    if (this.items.length === 0) return null;
    if (dir === 'prev') {
      if (this.cursor === null) {
        this.draft = current;
        this.cursor = this.items.length - 1;
      } else if (this.cursor > 0) {
        this.cursor--;
      } else {
        return null;
      }
      return this.items[this.cursor];
    }
    if (this.cursor === null) return null;
    if (this.cursor < this.items.length - 1) {
      this.cursor++;
      return this.items[this.cursor];
    }
    this.cursor = null;
    return this.draft;
  }

  /** 用户手动编辑后，退出历史浏览状态 */
  reset(): void {
    this.cursor = null;
  }

  get size(): number {
    return this.items.length;
  }
}

export class ComposerMachine {
  readonly ime = new ImeGuard();
  readonly history = new MessageHistory();
  private escArmedAt: number | null = null;

  /** 决策一次 keydown */
  onKeyDown(e: ComposerKeyEvent, ctx: ComposerContext, now: number): KeyDecision {
    const verdict = this.ime.judge(e, now);
    if (verdict === 'composing') return { type: 'ime' };
    if (verdict === 'guard') return { type: 'swallow' };

    // 除 Esc 以外的任何按键都会取消“再按一次清空”的等待
    const armed = this.escArmedAt;
    if (e.key !== 'Escape') this.escArmedAt = null;

    if (isTogglePassthrough(e)) return { type: 'togglePassthrough' };

    const ctrl = encodeCtrlCombo(e, ctx.hasSelection);
    if (ctrl) return { type: 'send', bytes: ctrl };

    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return { type: 'history', dir: e.key === 'ArrowUp' ? 'prev' : 'next' };
    }

    if (ctx.empty) {
      const seq = encodeKey(e, { appCursor: ctx.appCursor });
      if (seq) return { type: 'send', bytes: seq };
      return { type: 'default' };
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return { type: 'submit' };

    if (e.key === 'Escape') {
      if (armed !== null && now - armed <= ESC_CLEAR_WINDOW_MS) {
        this.escArmedAt = null;
        return { type: 'clear' };
      }
      this.escArmedAt = now;
      return { type: 'escHint' };
    }
    return { type: 'default' };
  }

  /** 提交或清空后调用 */
  resetEsc(): void {
    this.escArmedAt = null;
  }
}
