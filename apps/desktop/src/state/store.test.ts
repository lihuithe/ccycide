import { describe, expect, it } from 'vitest';
import type { AppNotice, AppState, CoreEvent, TermModes } from '../backend/types';
import { findTermKey, initialModel, makeTab, reducer, type Action, type AppModel } from './store';
import { canAllowPermission } from '../lib/actions';

const modes = (p: Partial<TermModes> = {}): TermModes => ({ bracketedPaste: false, altScreen: false, appCursor: false, mouse: false, title: '', ...p });

function app(p: Partial<AppState> = {}): AppState {
  return {
    app: 'claude', running: true, stateful: true, version: '', activity: 'idle', model: '', modelId: '', effort: '',
    fastMode: false, thinking: false, contextUsedPct: 0, hasContext: false, cwd: '', sessionId: '', sessionName: '', costUsd: 0, ...p,
  };
}

function run(m: AppModel, ...actions: Action[]): AppModel {
  return actions.reduce(reducer, m);
}
const core = (e: CoreEvent, now = 0): Action => ({ type: 'core', e, now });

function withTerm(profile: 'shell' | 'claude' = 'shell'): AppModel {
  return run(
    initialModel,
    { type: 'sessionAdd', id: 's1', deviceCode: '123456789' },
    { type: 'termAdd', tab: makeTab({ key: 'k1', sessionId: 's1', profile, title: '终端', remoteId: 't1' }) },
  );
}

describe('会话状态机', () => {
  it('connecting → ready → reconnecting → ready', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' });
    expect(m.sessions.s1.phase).toBe('connecting');
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'ready' }));
    expect(m.sessions.s1.phase).toBe('ready');
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'reconnecting', attempt: 2, retryInMs: 2000 }, 10_000));
    expect(m.sessions.s1).toMatchObject({ phase: 'reconnecting', attempt: 2, retryAt: 12_000 });
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'ready' }));
    expect(m.sessions.s1).toMatchObject({ phase: 'ready', attempt: undefined, retryAt: undefined });
  });

  it('没给 retryInMs 时按 1/2/4/8/15 秒兜底', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' });
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'reconnecting', attempt: 4 }, 0));
    expect(m.sessions.s1.retryAt).toBe(8000);
  });

  it('closed 保留原因，迟到的状态事件不会让它复活', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' });
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'closed', reason: '密码错误', reasonCode: 'PASSWORD_WRONG' }));
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'ready' }));
    expect(m.sessions.s1).toMatchObject({ phase: 'closed', reason: '密码错误', reasonCode: 'PASSWORD_WRONG' });
  });

  it('延迟、主机信息、能力、目录', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' });
    m = run(m, core({ type: 'latency', sessionId: 's1', ms: 42 }));
    expect(m.sessions.s1.latencyMs).toBe(42);
    m = run(m, core({ type: 'hostInfo', sessionId: 's1', info: { hostname: 'h' } as never, features: ['app.state'] }));
    expect(m.sessions.s1.features).toEqual(['app.state']);
  });

  it('未知会话的事件被忽略', () => {
    const m = run(initialModel, core({ type: 'latency', sessionId: 'nope', ms: 1 }));
    expect(m).toBe(initialModel);
  });
});

describe('终端直通', () => {
  it('shell 标签进入备用屏幕自动直通，退出自动切回', () => {
    let m = withTerm('shell');
    m = run(m, core({ type: 'termState', sessionId: 's1', termId: 't1', state: modes({ altScreen: true }) }));
    expect(m.terms.k1).toMatchObject({ passthrough: 'on', autoPassthrough: true });
    m = run(m, core({ type: 'termState', sessionId: 's1', termId: 't1', state: modes({ altScreen: false }) }));
    expect(m.terms.k1).toMatchObject({ passthrough: 'off', autoPassthrough: false });
  });

  it('Claude Code 标签不自动切换', () => {
    let m = withTerm('claude');
    m = run(m, core({ type: 'termState', sessionId: 's1', termId: 't1', state: modes({ altScreen: true }) }));
    expect(m.terms.k1.passthrough).toBe('off');
  });

  it('用户手动切换后，不再被备用屏幕退出自动改回', () => {
    let m = withTerm('shell');
    m = run(m, core({ type: 'termState', sessionId: 's1', termId: 't1', state: modes({ altScreen: true }) }));
    m = run(m, { type: 'passthrough', key: 'k1', mode: 'off' });
    expect(m.terms.k1.autoPassthrough).toBe(false);
    m = run(m, { type: 'passthrough', key: 'k1', mode: 'on' });
    m = run(m, core({ type: 'termState', sessionId: 's1', termId: 't1', state: modes({ altScreen: false }) }));
    expect(m.terms.k1.passthrough).toBe('on');
  });

  it('临时直通记录 returnKeys，切回时清空；应用退出后自动结束', () => {
    let m = withTerm('claude');
    m = run(m, { type: 'passthrough', key: 'k1', mode: 'temp', returnKeys: ['enter', 'esc'] });
    expect(m.terms.k1).toMatchObject({ passthrough: 'temp', returnKeys: ['enter', 'esc'] });
    m = run(m, core({ type: 'appState', sessionId: 's1', termId: 't1', state: app({ running: false }) }));
    expect(m.terms.k1).toMatchObject({ passthrough: 'off', returnKeys: [] });
  });
});

describe('权限卡片', () => {
  const notice = (p: Partial<AppNotice>): AppNotice => ({
    kind: 'permission', title: '', text: '', noticeId: '7', toolName: 'Bash', toolSummary: 'npm run build', resolved: false, truncated: false, ...p,
  });

  it('出现、被同 id 的 resolved 撤掉', () => {
    let m = withTerm('claude');
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({}) }));
    expect(m.terms.k1.permissionCard?.toolName).toBe('Bash');
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({ noticeId: '8', resolved: true }) }));
    expect(m.terms.k1.permissionCard).not.toBeNull();
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({ resolved: true }) }));
    expect(m.terms.k1.permissionCard).toBeNull();
  });

  it('truncated 标志原样保留，且不能远程允许', () => {
    let m = withTerm('claude');
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({ truncated: true }) }));
    expect(m.terms.k1.permissionCard?.truncated).toBe(true);
    expect(canAllowPermission(m.terms.k1.permissionCard!)).toBe(false);
    expect(canAllowPermission(notice({}))).toBe(true);
  });

  it('活动不再是等待确认时卡片失效', () => {
    let m = withTerm('claude');
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({}) }));
    m = run(m, core({ type: 'appState', sessionId: 's1', termId: 't1', state: app({ activity: 'waiting_permission' }) }));
    expect(m.terms.k1.permissionCard).not.toBeNull();
    m = run(m, core({ type: 'appState', sessionId: 's1', termId: 't1', state: app({ activity: 'busy' }) }));
    expect(m.terms.k1.permissionCard).toBeNull();
  });

  it('无状态回传时 appState 不会撤掉卡片', () => {
    let m = withTerm('claude');
    m = run(m, core({ type: 'appNotice', sessionId: 's1', termId: 't1', notice: notice({}) }));
    m = run(m, core({ type: 'appState', sessionId: 's1', termId: 't1', state: app({ stateful: false }) }));
    expect(m.terms.k1.permissionCard).not.toBeNull();
  });
});

describe('终端占用（TERM_BUSY 等）', () => {
  const err = (title: string): CoreEvent => ({
    type: 'appNotice', sessionId: 's1', termId: 't1',
    notice: { kind: 'error', title, text: '', noticeId: '', toolName: '', toolSummary: '', resolved: false, truncated: false },
  });

  it('TERM_BUSY 通知使标签进入占用状态，并退出直通、撤掉权限卡片', () => {
    let m = withTerm('claude');
    m = run(m, { type: 'passthrough', key: 'k1', mode: 'on' });
    m = run(m, core(err('TERM_BUSY')));
    expect(m.terms.k1).toMatchObject({ status: 'busy', passthrough: 'off', permissionCard: null });
  });

  it('TERM_DETACHED、TERM_NOT_FOUND 分别对应被接管、已不存在', () => {
    expect(run(withTerm(), core(err('TERM_DETACHED'))).terms.k1.status).toBe('detached');
    expect(run(withTerm(), core(err('TERM_NOT_FOUND'))).terms.k1.status).toBe('gone');
  });

  it('其它错误通知不改变标签状态', () => {
    expect(run(withTerm(), core(err('RATE_LIMIT'))).terms.k1.status).toBe('open');
  });

  it('attach 失败的 termBlocked；列表里被占用的终端以 busy 建标签', () => {
    const m = run(withTerm(), { type: 'termBlocked', key: 'k1', status: 'busy' });
    expect(m.terms.k1.status).toBe('busy');
    const tab = makeTab({ key: 'k9', sessionId: 's1', profile: 'shell', title: 'x', remoteId: 'tz', status: 'busy' });
    expect(tab.status).toBe('busy');
  });
});

describe('标签管理', () => {
  it('关闭当前标签后激活相邻标签', () => {
    let m = withTerm('shell');
    m = run(m, { type: 'termAdd', tab: makeTab({ key: 'k2', sessionId: 's1', profile: 'shell', title: 'b', remoteId: 't2' }) });
    m = run(m, { type: 'termAdd', tab: makeTab({ key: 'k3', sessionId: 's1', profile: 'shell', title: 'c', remoteId: 't3' }) });
    m = run(m, { type: 'activate', key: 'k2' }, { type: 'termRemove', key: 'k2' });
    expect(m.tabOrder).toEqual(['k1', 'k3']);
    expect(m.activeKey).toBe('k3');
  });

  it('远端 id 与本地 key 的映射；opening 状态在 termOpened 后补上', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' }, { type: 'termAdd', tab: makeTab({ key: 'k1', sessionId: 's1', profile: 'claude', title: 'Claude Code' }) });
    expect(m.terms.k1.status).toBe('opening');
    m = run(m, { type: 'termOpened', key: 'k1', remoteId: 'tx', title: '' });
    expect(findTermKey(m, 's1', 'tx')).toBe('k1');
    expect(m.terms.k1.title).toBe('Claude Code');
  });

  it('切到有角标的标签，角标清除', () => {
    let m = withTerm('claude');
    m = run(m, { type: 'termAdd', tab: makeTab({ key: 'k2', sessionId: 's1', profile: 'shell', title: 'b', remoteId: 't2' }) });
    m = run(m, { type: 'badge', key: 'k1', on: true }, { type: 'activate', key: 'k1' });
    expect(m.terms.k1.badge).toBe(false);
  });

  it('重连换会话：标签改绑到新会话', () => {
    let m = withTerm('shell');
    m = run(m, { type: 'sessionAdd', id: 's2', deviceCode: '1' }, { type: 'termRebind', key: 'k1', sessionId: 's2' });
    expect(m.terms.k1.sessionId).toBe('s2');
  });

  it('移除会话同时移除其标签', () => {
    let m = withTerm('shell');
    m = run(m, { type: 'sessionRemove', id: 's1' });
    expect(m.tabOrder).toEqual([]);
    expect(m.activeKey).toBeNull();
  });
});

describe('上传状态与来访会话', () => {
  it('进度、完成、失败', () => {
    let m = run(initialModel, core({ type: 'uploadProgress', sessionId: 's', fileId: 'f1', sent: 5, total: 10 }));
    expect(m.uploads['s:f1']).toMatchObject({ sent: 5, total: 10, done: false });
    m = run(m, core({ type: 'uploadDone', sessionId: 's', fileId: 'f1', remotePath: '/x' }));
    expect(m.uploads['s:f1']).toMatchObject({ done: true, remotePath: '/x' });
    m = run(m, core({ type: 'uploadFailed', sessionId: 's', fileId: 'f2', reason: '断了' }));
    expect(m.uploads['s:f2'].failed).toBe('断了');
  });

  it('来访会话增删，重复事件去重', () => {
    const ev: CoreEvent = { type: 'incomingSession', sessionId: 'i1', fromCode: '1', platform: 'macos', startedAt: 1, pendingConfirm: true };
    let m = run(initialModel, core(ev), core(ev));
    expect(m.incoming).toHaveLength(1);
    m = run(m, { type: 'incomingConfirmed', sessionId: 'i1' });
    expect(m.incoming[0].pendingConfirm).toBe(false);
    m = run(m, core({ type: 'incomingClosed', sessionId: 'i1', reason: 'closed' }));
    expect(m.incoming).toHaveLength(0);
  });
});

describe('连接确认（awaitingApproval）与来访取消', () => {
  it('connect 进行中的状态事件按 requestId 记录，不影响会话表', () => {
    let m = run(initialModel, { type: 'connectPhase', requestId: 'r1', phase: 'connecting' });
    expect(m.connecting.r1).toBe('connecting');
    m = run(m, core({ type: 'sessionState', sessionId: '', requestId: 'r1', state: 'awaitingApproval' }));
    expect(m.connecting.r1).toBe('awaitingApproval');
    expect(Object.keys(m.sessions)).toEqual([]);
    m = run(m, { type: 'connectPhase', requestId: 'r1', phase: null });
    expect(m.connecting).toEqual({});
  });

  it('已结束的 requestId 的迟到事件被忽略', () => {
    const m = run(initialModel, core({ type: 'sessionState', sessionId: '', requestId: 'gone', state: 'awaitingApproval' }));
    expect(m).toBe(initialModel);
  });

  it('已有会话也可进入 awaitingApproval，之后恢复 ready', () => {
    let m = run(initialModel, { type: 'sessionAdd', id: 's1', deviceCode: '1' });
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'awaitingApproval' }));
    expect(m.sessions.s1.phase).toBe('awaitingApproval');
    m = run(m, core({ type: 'sessionState', sessionId: 's1', state: 'ready' }));
    expect(m.sessions.s1.phase).toBe('ready');
  });

  const pending: CoreEvent = { type: 'incomingSession', sessionId: 'i1', fromCode: '1', platform: 'macos', startedAt: 1, pendingConfirm: true };

  it('多个待确认来访共存，时间过去也不会被自动移除', () => {
    let m = run(initialModel, core(pending), core({ ...pending, sessionId: 'i2', startedAt: 2 }));
    m = run(m, core({ type: 'signalState', online: true }, 10 * 60_000));
    expect(m.incoming.filter((i) => i.pendingConfirm)).toHaveLength(2);
  });

  it('incomingClosed 各原因：cancelled / rejected / closed 撤掉该项；accepted 保留并转为已连入', () => {
    for (const reason of ['cancelled', 'rejected', 'closed'] as const) {
      const m = run(initialModel, core(pending), core({ type: 'incomingClosed', sessionId: 'i1', reason }));
      expect(m.incoming).toHaveLength(0);
    }
    const m = run(initialModel, core(pending), core({ type: 'incomingClosed', sessionId: 'i1', reason: 'accepted' }));
    expect(m.incoming).toHaveLength(1);
    expect(m.incoming[0].pendingConfirm).toBe(false);
  });
});
