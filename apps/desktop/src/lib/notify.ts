/** 通知策略（T41）：什么时候发系统通知、合并、角标、点击后跳转 */
import type { AppNotice } from '../backend/types';

export const DONE_MERGE_MS = 10_000;
/** 通知发出后多久内窗口重新获得焦点，视为用户点了通知，跳转到对应标签 */
export const NOTIFY_FOCUS_JUMP_MS = 60_000;

export interface NotifyContext {
  windowFocused: boolean;
  /** 该终端是否是当前显示的标签 */
  isActiveTab: boolean;
  tabLabel: string;
  notifyOnDone: boolean;
  notifyOnPermission: boolean;
}

export interface NotifyDecision {
  /** 发系统通知 */
  system: boolean;
  /** 标签上加角标 */
  badge: boolean;
  title: string;
  body: string;
}

export class NoticeNotifier {
  private lastDone = new Map<string, number>();

  /** 对一条 AppNotice 做决策；不需要提示返回 null */
  decide(termKey: string, n: AppNotice, ctx: NotifyContext, now: number): NotifyDecision | null {
    if (n.resolved) return null;
    const hidden = !ctx.windowFocused || !ctx.isActiveTab;
    if (!hidden) return null;

    switch (n.kind) {
      case 'permission':
      case 'need_input': {
        if (!ctx.notifyOnPermission) return { system: false, badge: true, title: '', body: '' };
        const what = n.toolName ? `${n.toolName}${n.toolSummary ? '：' + n.toolSummary : ''}` : n.text;
        return {
          system: true,
          badge: true,
          title: `${ctx.tabLabel} · ${n.title || '需要你确认'}`,
          body: what || '请回到窗口处理',
        };
      }
      case 'done':
      case 'error': {
        if (n.kind === 'done') {
          const last = this.lastDone.get(termKey);
          if (last !== undefined && now - last < DONE_MERGE_MS) return { system: false, badge: true, title: '', body: '' };
          this.lastDone.set(termKey, now);
        }
        if (!ctx.notifyOnDone) return { system: false, badge: true, title: '', body: '' };
        return {
          system: true,
          badge: true,
          title: `${ctx.tabLabel} · ${n.title || (n.kind === 'done' ? '任务完成' : '出错了')}`,
          body: n.text || (n.kind === 'done' ? 'Claude Code 已完成当前任务' : '请回到窗口查看'),
        };
      }
    }
    return null;
  }
}

export interface FocusTarget {
  termKey: string;
  at: number;
}

/** 窗口重新获得焦点时：若最近有过通知，返回应跳转的标签 */
export function focusJumpTarget(target: FocusTarget | null, now: number): string | null {
  if (!target) return null;
  return now - target.at <= NOTIFY_FOCUS_JUMP_MS ? target.termKey : null;
}
