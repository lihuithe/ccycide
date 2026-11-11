/** 终端级错误（TERM_BUSY / TERM_DETACHED / TERM_NOT_FOUND）到标签状态的映射 */
import type { AppNotice } from '../backend/types';

/** 标签的不可用状态：占用 / 被接管 / 已不存在。都不自动重试，也不提供强制接管 */
export type BlockedStatus = 'busy' | 'detached' | 'gone';

export function blockedStatusFromCode(code: string): BlockedStatus | null {
  switch (code) {
    case 'TERM_BUSY':
      return 'busy';
    case 'TERM_DETACHED':
      return 'detached';
    case 'TERM_NOT_FOUND':
      return 'gone';
    default:
      return null;
  }
}

/** AppNotice{kind:error, title:<错误码>} 形式的终端级错误；不是则返回 null */
export function blockedStatusFromNotice(n: AppNotice): BlockedStatus | null {
  return n.kind === 'error' ? blockedStatusFromCode(n.title) : null;
}

export function isBlocked(status: string): boolean {
  return status === 'busy' || status === 'detached' || status === 'gone';
}

export function blockedText(status: BlockedStatus): string {
  switch (status) {
    case 'busy':
      return '该终端正被其他设备使用';
    case 'detached':
      return '该终端已在别处打开';
    case 'gone':
      return '终端已不存在';
  }
}
