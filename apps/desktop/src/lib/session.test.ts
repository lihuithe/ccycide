import { describe, expect, it } from 'vitest';
import { canSend, connectErrorText, needsPasswordAgain, notReadyHint, reconnectDelayMs, remainingSeconds, statusText } from './session';

describe('重连间隔', () => {
  it('1、2、4、8 秒，上限 15 秒', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});

describe('状态文案', () => {
  it('各阶段', () => {
    expect(statusText({ phase: 'connecting' }, 0)).toBe('连接中…');
    expect(statusText({ phase: 'ready' }, 0)).toBe('已连接');
    expect(statusText({ phase: 'awaitingApproval' }, 0)).toBe('等待对方确认…');
    expect(statusText({ phase: 'closed' }, 0)).toBe('已断开');
    expect(statusText({ phase: 'closed', reason: '对方断开' }, 0)).toBe('已断开 · 对方断开');
  });

  it('重连中显示次数与倒计时', () => {
    expect(statusText({ phase: 'reconnecting', attempt: 2, retryAt: 5000 }, 1500)).toBe('重连中 第 2 次 · 4 秒后重试');
    expect(statusText({ phase: 'reconnecting', attempt: 2, retryAt: 5000 }, 6000)).toBe('重连中 第 2 次');
  });

  it('倒计时向上取整且不为负', () => {
    expect(remainingSeconds(1001, 0)).toBe(2);
    expect(remainingSeconds(0, 5000)).toBe(0);
    expect(remainingSeconds(undefined, 0)).toBe(0);
  });
});

describe('可发送判定', () => {
  it('只有 ready 可发送', () => {
    expect(canSend('ready')).toBe(true);
    expect(canSend('reconnecting')).toBe(false);
    expect(canSend('connecting')).toBe(false);
    expect(canSend('awaitingApproval')).toBe(false);
    expect(canSend('closed')).toBe(false);
    expect(canSend(undefined)).toBe(false);
  });

  it('提示文案区分重连与未连接', () => {
    expect(notReadyHint('reconnecting')).toContain('重连');
    expect(notReadyHint('closed')).toContain('尚未连接');
  });
});

describe('密码错误需要重新输入', () => {
  it('只有因密码错误关闭才需要', () => {
    expect(needsPasswordAgain({ phase: 'closed', reasonCode: 'PASSWORD_WRONG' })).toBe(true);
    expect(needsPasswordAgain({ phase: 'closed', reasonCode: 'REJECTED' })).toBe(false);
    expect(needsPasswordAgain({ phase: 'reconnecting', reasonCode: 'PASSWORD_WRONG' })).toBe(false);
  });
});

describe('连接错误文案', () => {
  it('对应方案 4.3 错误码表', () => {
    expect(connectErrorText('UNAVAILABLE', '')).toBe('设备不在线或设备码有误');
    expect(connectErrorText('REJECTED', '')).toBe('对方拒绝了连接');
    expect(connectErrorText('LOCKED', '')).toBe('对方设备已临时锁定');
    expect(connectErrorText('VERSION', '')).toBe('请升级客户端');
    expect(connectErrorText('UNKNOWN', '后端消息')).toBe('后端消息');
    expect(connectErrorText('CANCELLED', '')).toBe('已取消');
  });
});
