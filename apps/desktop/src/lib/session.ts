/** 会话状态机的前端部分（方案 5.6 / T24）：状态文案、可发送判定、重连倒计时 */
import type { SessionPhase } from '../backend/types';

/** 重连间隔 1、2、4、8 秒，上限 15 秒（后端为准，这里只用于后端没给 retryInMs 时的显示兜底） */
export function reconnectDelayMs(attempt: number): number {
  const table = [1000, 2000, 4000, 8000, 15000];
  return table[Math.min(Math.max(attempt, 1), table.length) - 1];
}

export interface SessionView {
  phase: SessionPhase;
  reason?: string;
  reasonCode?: string;
  attempt?: number;
  /** 下次重试的绝对时刻（毫秒时间戳） */
  retryAt?: number;
}

export function remainingSeconds(retryAt: number | undefined, now: number): number {
  if (retryAt === undefined) return 0;
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** 只有 Ready 才能发送；其余状态提交时提示而不清空输入 */
export function canSend(phase: SessionPhase | undefined): boolean {
  return phase === 'ready';
}

/** 提交被拒时给用户的提示 */
export function notReadyHint(phase: SessionPhase | undefined): string {
  switch (phase) {
    case 'reconnecting':
      return '重连中，暂时无法发送';
    case 'connecting':
      return '正在连接，请稍候';
    case 'awaitingApproval':
      return '等待对方确认，暂时无法发送';
    default:
      return '尚未连接，无法发送';
  }
}

export function statusText(s: SessionView, now: number): string {
  switch (s.phase) {
    case 'connecting':
      return '连接中…';
    case 'awaitingApproval':
      return '等待对方确认…';
    case 'ready':
      return '已连接';
    case 'reconnecting': {
      const sec = remainingSeconds(s.retryAt, now);
      const n = s.attempt ? `第 ${s.attempt} 次` : '';
      return sec > 0 ? `重连中 ${n} · ${sec} 秒后重试` : `重连中 ${n}`.trim();
    }
    case 'closed':
      return s.reason ? `已断开 · ${s.reason}` : '已断开';
  }
}

/** 断开后是否需要用户重新输入密码才能继续 */
export function needsPasswordAgain(s: SessionView): boolean {
  return s.phase === 'closed' && s.reasonCode === 'PASSWORD_WRONG';
}

/** 连接失败的提示文案（方案 4.3 错误码表） */
export function connectErrorText(code: string, message: string): string {
  switch (code) {
    case 'UNAVAILABLE':
      return '设备不在线或设备码有误';
    case 'REJECTED':
      return '对方拒绝了连接';
    case 'RATE_LIMITED':
      return '操作太频繁，请稍后再试';
    case 'LOCKED':
      return '对方设备已临时锁定';
    case 'VERSION':
      return '请升级客户端';
    case 'BANNED':
      return '本设备已被限制使用';
    case 'NO_RELAY':
      return '服务繁忙，请稍后再试';
    case 'PASSWORD_WRONG':
      return '密码错误';
    case 'CANCELLED':
      return '已取消';
    case 'NETWORK':
      return '网络不通，请检查网络';
    default:
      return message || '连接失败';
  }
}
