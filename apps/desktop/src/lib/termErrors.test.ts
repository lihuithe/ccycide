import { describe, expect, it } from 'vitest';
import type { AppNotice } from '../backend/types';
import { defaultSettings } from '../backend/mockData';
import { blockedStatusFromCode, blockedStatusFromNotice, blockedText, isBlocked } from './termErrors';

const notice = (p: Partial<AppNotice>): AppNotice => ({
  kind: 'error', title: '', text: '', noticeId: '', toolName: '', toolSummary: '', resolved: false, truncated: false, ...p,
});

describe('终端级错误映射', () => {
  it('错误码到标签状态', () => {
    expect(blockedStatusFromCode('TERM_BUSY')).toBe('busy');
    expect(blockedStatusFromCode('TERM_DETACHED')).toBe('detached');
    expect(blockedStatusFromCode('TERM_NOT_FOUND')).toBe('gone');
    expect(blockedStatusFromCode('SPAWN_FAILED')).toBeNull();
  });

  it('只有 kind=error 且 title 是终端错误码的 AppNotice 才算', () => {
    expect(blockedStatusFromNotice(notice({ title: 'TERM_BUSY' }))).toBe('busy');
    expect(blockedStatusFromNotice(notice({ title: 'RATE_LIMIT' }))).toBeNull();
    expect(blockedStatusFromNotice(notice({ kind: 'done', title: 'TERM_BUSY' }))).toBeNull();
  });

  it('文案与判定', () => {
    expect(blockedText('busy')).toBe('该终端正被其他设备使用');
    expect(blockedText('gone')).toBe('终端已不存在');
    expect(isBlocked('busy')).toBe(true);
    expect(isBlocked('open')).toBe(false);
    expect(isBlocked('exited')).toBe(false);
  });
});

describe('设置默认值', () => {
  it('终端隔离默认开启', () => {
    expect(defaultSettings().host.isolateTerminals).toBe(true);
  });
});
