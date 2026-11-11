/**
 * 中文输入法 Enter 判定（方案 5.7.3）：
 * - 组字期间（isComposing 或 keyCode 229）的按键一律交给输入法；
 * - macOS WebKit 确认候选词的那次 Enter，keydown 可能晚于 compositionend，
 *   所以 compositionend 之后 50ms 内的 Enter 忽略。
 */

export const IME_ENTER_GUARD_MS = 50;

export interface ImeKeyEvent {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}

/** 'composing' = 输入法正在处理，不要碰；'guard' = 组字刚结束的 Enter，吞掉；'none' = 正常按键 */
export type ImeVerdict = 'composing' | 'guard' | 'none';

export class ImeGuard {
  private lastEnd = Number.NEGATIVE_INFINITY;
  private composing = false;

  compositionStart(): void {
    this.composing = true;
  }

  compositionEnd(now: number): void {
    this.composing = false;
    this.lastEnd = now;
  }

  judge(e: ImeKeyEvent, now: number): ImeVerdict {
    if (this.composing || e.isComposing || e.keyCode === 229) return 'composing';
    if (e.key === 'Enter' && now - this.lastEnd < IME_ENTER_GUARD_MS) return 'guard';
    return 'none';
  }
}
