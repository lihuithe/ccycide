/**
 * 应用状态：纯 reducer + 极简 store（供 useSyncExternalStore 订阅）。
 * 终端输出字节不进这里（直接写 xterm），这里只放低频状态。
 */
import type {
  ActionCatalog,
  AppNotice,
  AppState,
  CoreEvent,
  CustomCommand,
  HostInfo,
  IncomingSession,
  KnownHost,
  LocalInfo,
  SessionId,
  SessionPhase,
  Settings,
  TermId,
  TermModes,
  TermProfile,
  UpdateInfo,
} from '../backend/types';
import type { UploadState } from '../lib/attachments';
import { reconnectDelayMs } from '../lib/session';
import { blockedStatusFromNotice, type BlockedStatus } from '../lib/termErrors';

export type PassthroughMode = 'off' | 'on' | 'temp';

export interface SessionModel {
  id: SessionId;
  deviceCode: string;
  phase: SessionPhase;
  reason?: string;
  reasonCode?: string;
  attempt?: number;
  retryAt?: number;
  latencyMs?: number;
  info?: HostInfo;
  features: string[];
  catalog?: ActionCatalog;
}

export interface TermTab {
  /** 前端本地 key，整个生命周期不变（重连换会话时也不变） */
  key: string;
  sessionId: SessionId;
  remoteId?: TermId;
  profile: TermProfile;
  title: string;
  status: 'opening' | 'open' | 'exited' | 'failed' | BlockedStatus;
  exitCode?: number;
  failReason?: string;
  modes: TermModes;
  app: AppState | null;
  commands: CustomCommand[];
  passthrough: PassthroughMode;
  /** 备用屏幕触发的自动直通（退出备用屏幕时自动切回） */
  autoPassthrough: boolean;
  returnKeys: string[];
  badge: boolean;
  permissionCard: AppNotice | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface UpdateModel {
  info: UpdateInfo;
  /** null = 未开始；0-1 = 下载中 */
  progress: number | null;
  error?: string;
}

export interface AppModel {
  ready: boolean;
  online: boolean;
  local: LocalInfo | null;
  settings: Settings | null;
  knownHosts: KnownHost[];
  incoming: IncomingSession[];
  sessions: Record<SessionId, SessionModel>;
  sessionOrder: SessionId[];
  terms: Record<string, TermTab>;
  tabOrder: string[];
  activeKey: string | null;
  activeSessionId: SessionId | null;
  uploads: Record<string, UploadState>;
  toasts: Toast[];
  update: UpdateModel | null;
  /** 有文件正拖到窗口上 */
  dragging: boolean;
  /** 进行中的 connect（requestId → 阶段）；awaitingApproval 时连接按钮区显示“等待对方确认” */
  connecting: Record<string, 'connecting' | 'awaitingApproval'>;
}

export const initialModel: AppModel = {
  ready: false,
  online: true,
  local: null,
  settings: null,
  knownHosts: [],
  incoming: [],
  sessions: {},
  sessionOrder: [],
  terms: {},
  tabOrder: [],
  activeKey: null,
  activeSessionId: null,
  uploads: {},
  toasts: [],
  update: null,
  dragging: false,
  connecting: {},
};

export const defaultModes: TermModes = { bracketedPaste: false, altScreen: false, appCursor: false, mouse: false, title: '' };

export type Action =
  | { type: 'init'; local: LocalInfo; settings: Settings; knownHosts: KnownHost[] }
  | { type: 'local'; local: LocalInfo }
  | { type: 'settings'; settings: Settings }
  | { type: 'knownHosts'; hosts: KnownHost[] }
  | { type: 'sessionAdd'; id: SessionId; deviceCode: string }
  | { type: 'sessionRemove'; id: SessionId }
  | { type: 'incomingConfirmed'; sessionId: SessionId }
  | { type: 'termAdd'; tab: TermTab }
  | { type: 'termOpened'; key: string; remoteId: TermId; title: string }
  | { type: 'termFailed'; key: string; reason: string }
  | { type: 'termBlocked'; key: string; status: BlockedStatus }
  | { type: 'termRebind'; key: string; sessionId: SessionId }
  | { type: 'termRemove'; key: string }
  | { type: 'activate'; key: string | null }
  | { type: 'activateSession'; id: SessionId }
  | { type: 'passthrough'; key: string; mode: PassthroughMode; returnKeys?: string[]; auto?: boolean }
  | { type: 'badge'; key: string; on: boolean }
  | { type: 'permissionCard'; key: string; card: AppNotice | null }
  | { type: 'toast'; toast: Toast }
  | { type: 'toastDismiss'; id: number }
  | { type: 'update'; update: UpdateModel | null }
  | { type: 'dragging'; on: boolean }
  | { type: 'connectPhase'; requestId: string; phase: 'connecting' | 'awaitingApproval' | null }
  | { type: 'core'; e: CoreEvent; now: number };

export function makeTab(p: {
  key: string;
  sessionId: SessionId;
  profile: TermProfile;
  title: string;
  remoteId?: TermId;
  status?: TermTab['status'];
}): TermTab {
  return {
    key: p.key,
    sessionId: p.sessionId,
    remoteId: p.remoteId,
    profile: p.profile,
    title: p.title,
    status: p.status ?? (p.remoteId ? 'open' : 'opening'),
    modes: { ...defaultModes },
    app: null,
    commands: [],
    passthrough: 'off',
    autoPassthrough: false,
    returnKeys: [],
    badge: false,
    permissionCard: null,
  };
}

export function findTermKey(m: AppModel, sessionId: SessionId, remoteId: TermId): string | undefined {
  return m.tabOrder.find((k) => m.terms[k].sessionId === sessionId && m.terms[k].remoteId === remoteId);
}

/** 事件是否指向前端已知的会话/终端（未知的由 controller 暂存，等注册后重放） */
export function eventTarget(e: CoreEvent): { sessionId: SessionId; termId?: TermId } | null {
  if (e.type === 'sessionState' && e.requestId) return null;
  switch (e.type) {
    case 'sessionState':
    case 'latency':
    case 'hostInfo':
    case 'actionCatalog':
    case 'uploadProgress':
    case 'uploadDone':
    case 'uploadFailed':
      return { sessionId: e.sessionId };
    case 'termState':
    case 'termExit':
    case 'appState':
    case 'appNotice':
    case 'commandList':
      return { sessionId: e.sessionId, termId: e.termId };
    default:
      return null;
  }
}

function patchTerm(m: AppModel, key: string | undefined, f: (t: TermTab) => TermTab): AppModel {
  if (!key || !m.terms[key]) return m;
  return { ...m, terms: { ...m.terms, [key]: f(m.terms[key]) } };
}

/** 标签进入占用/被接管/已不存在状态：退出直通，清掉权限卡片 */
function blockedTab(t: TermTab, status: BlockedStatus): TermTab {
  return { ...t, status, passthrough: 'off', autoPassthrough: false, returnKeys: [], permissionCard: null };
}

function patchSession(m: AppModel, id: SessionId, f: (s: SessionModel) => SessionModel): AppModel {
  const s = m.sessions[id];
  return s ? { ...m, sessions: { ...m.sessions, [id]: f(s) } } : m;
}

function applyCore(m: AppModel, e: CoreEvent, now: number): AppModel {
  // connect 进行中的状态事件：用 requestId 对应，还没有会话
  if (e.type === 'sessionState' && e.requestId) {
    if (!(e.requestId in m.connecting)) return m;
    const phase = e.state === 'awaitingApproval' ? 'awaitingApproval' : 'connecting';
    return { ...m, connecting: { ...m.connecting, [e.requestId]: phase } };
  }
  switch (e.type) {
    case 'signalState':
      return { ...m, online: e.online, local: m.local ? { ...m.local, online: e.online } : m.local };
    case 'localInfoChanged':
      return { ...m, local: e.info };
    case 'settingsChanged':
      return { ...m, settings: e.settings };
    case 'incomingSession': {
      const { type: _t, ...sess } = e;
      if (m.incoming.some((i) => i.sessionId === sess.sessionId)) return m;
      return { ...m, incoming: [...m.incoming, sess] };
    }
    case 'incomingClosed':
      // accepted：确认阶段结束但已同意，会话仍在；其余原因都撤掉该项
      if (e.reason === 'accepted') {
        return { ...m, incoming: m.incoming.map((i) => (i.sessionId === e.sessionId ? { ...i, pendingConfirm: false } : i)) };
      }
      return { ...m, incoming: m.incoming.filter((i) => i.sessionId !== e.sessionId) };
    case 'sessionState':
      return patchSession(m, e.sessionId, (s) => {
        // 已关闭的会话不再接受后续状态（防止迟到事件把它“复活”）
        if (s.phase === 'closed') return s;
        const retryAt = e.state === 'reconnecting' ? now + (e.retryInMs ?? reconnectDelayMs(e.attempt ?? 1)) : undefined;
        return {
          ...s,
          phase: e.state,
          reason: e.state === 'closed' ? e.reason : undefined,
          reasonCode: e.state === 'closed' ? e.reasonCode : undefined,
          attempt: e.state === 'reconnecting' ? e.attempt : undefined,
          retryAt,
        };
      });
    case 'latency':
      return patchSession(m, e.sessionId, (s) => ({ ...s, latencyMs: e.ms }));
    case 'hostInfo':
      return patchSession(m, e.sessionId, (s) => ({ ...s, info: e.info, features: e.features }));
    case 'actionCatalog':
      return patchSession(m, e.sessionId, (s) => ({ ...s, catalog: e.catalog }));
    case 'termState': {
      const key = findTermKey(m, e.sessionId, e.termId);
      return patchTerm(m, key, (t) => {
        let { passthrough, autoPassthrough } = t;
        // 通用 shell 标签进入备用屏幕自动直通，退出时切回；Claude Code 标签不自动切换
        if (t.profile !== 'claude') {
          if (e.state.altScreen && passthrough === 'off') {
            passthrough = 'on';
            autoPassthrough = true;
          } else if (!e.state.altScreen && autoPassthrough) {
            if (passthrough === 'on') passthrough = 'off';
            autoPassthrough = false;
          }
        }
        return { ...t, modes: e.state, title: e.state.title || t.title, passthrough, autoPassthrough };
      });
    }
    case 'termExit': {
      const key = findTermKey(m, e.sessionId, e.termId);
      return patchTerm(m, key, (t) => ({ ...t, status: 'exited', exitCode: e.code, passthrough: 'off', autoPassthrough: false }));
    }
    case 'appState': {
      const key = findTermKey(m, e.sessionId, e.termId);
      return patchTerm(m, key, (t) => ({
        ...t,
        app: e.state,
        // 不再处于等待确认时，权限卡片失效
        permissionCard: e.state.stateful && e.state.activity !== 'waiting_permission' ? null : t.permissionCard,
        // 应用退出后不应还停在临时直通
        ...(!e.state.running && t.passthrough === 'temp' ? { passthrough: 'off' as const, returnKeys: [] } : {}),
      }));
    }
    case 'appNotice': {
      const key = findTermKey(m, e.sessionId, e.termId);
      const n = e.notice;
      return patchTerm(m, key, (t) => {
        // 终端级错误（占用/被接管/已不存在）：标签转为不可用状态，不重试
        const blocked = blockedStatusFromNotice(n);
        if (blocked) return blockedTab(t, blocked);
        if (n.kind === 'permission') {
          if (n.resolved) return t.permissionCard?.noticeId === n.noticeId ? { ...t, permissionCard: null } : t;
          return { ...t, permissionCard: n };
        }
        return t;
      });
    }
    case 'commandList': {
      const key = findTermKey(m, e.sessionId, e.termId);
      return patchTerm(m, key, (t) => ({ ...t, commands: e.list.commands }));
    }
    case 'uploadProgress': {
      const k = `${e.sessionId}:${e.fileId}`;
      return { ...m, uploads: { ...m.uploads, [k]: { ...m.uploads[k], sent: e.sent, total: e.total, done: m.uploads[k]?.done ?? false } } };
    }
    case 'uploadDone': {
      const k = `${e.sessionId}:${e.fileId}`;
      const prev = m.uploads[k];
      return { ...m, uploads: { ...m.uploads, [k]: { sent: prev?.total ?? 0, total: prev?.total ?? 0, done: true, remotePath: e.remotePath } } };
    }
    case 'uploadFailed': {
      const k = `${e.sessionId}:${e.fileId}`;
      const prev = m.uploads[k];
      return { ...m, uploads: { ...m.uploads, [k]: { sent: prev?.sent ?? 0, total: prev?.total ?? 0, done: false, failed: e.reason } } };
    }
  }
  return m;
}

export function reducer(m: AppModel, a: Action): AppModel {
  switch (a.type) {
    case 'init':
      return { ...m, ready: true, local: a.local, online: a.local.online, settings: a.settings, knownHosts: a.knownHosts };
    case 'local':
      return { ...m, local: a.local };
    case 'settings':
      return { ...m, settings: a.settings };
    case 'knownHosts':
      return { ...m, knownHosts: a.hosts };
    case 'sessionAdd':
      if (m.sessions[a.id]) return m;
      return {
        ...m,
        sessions: { ...m.sessions, [a.id]: { id: a.id, deviceCode: a.deviceCode, phase: 'connecting', features: [] } },
        sessionOrder: [...m.sessionOrder, a.id],
        activeSessionId: a.id,
      };
    case 'sessionRemove': {
      const keys = m.tabOrder.filter((k) => m.terms[k].sessionId === a.id);
      const terms = { ...m.terms };
      keys.forEach((k) => delete terms[k]);
      const tabOrder = m.tabOrder.filter((k) => !keys.includes(k));
      const sessions = { ...m.sessions };
      delete sessions[a.id];
      const sessionOrder = m.sessionOrder.filter((s) => s !== a.id);
      const activeKey = m.activeKey && terms[m.activeKey] ? m.activeKey : (tabOrder[tabOrder.length - 1] ?? null);
      const activeSessionId =
        m.activeSessionId === a.id ? (activeKey ? terms[activeKey].sessionId : (sessionOrder[sessionOrder.length - 1] ?? null)) : m.activeSessionId;
      return { ...m, sessions, sessionOrder, terms, tabOrder, activeKey, activeSessionId };
    }
    case 'incomingConfirmed':
      return { ...m, incoming: m.incoming.map((i) => (i.sessionId === a.sessionId ? { ...i, pendingConfirm: false } : i)) };
    case 'termAdd':
      return {
        ...m,
        terms: { ...m.terms, [a.tab.key]: a.tab },
        tabOrder: [...m.tabOrder, a.tab.key],
        activeKey: a.tab.key,
        activeSessionId: a.tab.sessionId,
      };
    case 'termOpened':
      return patchTerm(m, a.key, (t) => ({ ...t, remoteId: a.remoteId, status: 'open', title: a.title || t.title }));
    case 'termFailed':
      return patchTerm(m, a.key, (t) => ({ ...t, status: 'failed', failReason: a.reason }));
    case 'termBlocked':
      return patchTerm(m, a.key, (t) => blockedTab(t, a.status));
    case 'termRebind':
      return patchTerm(m, a.key, (t) => ({ ...t, sessionId: a.sessionId, status: t.status === 'exited' ? t.status : 'open' }));
    case 'termRemove': {
      if (!m.terms[a.key]) return m;
      const idx = m.tabOrder.indexOf(a.key);
      const terms = { ...m.terms };
      delete terms[a.key];
      const tabOrder = m.tabOrder.filter((k) => k !== a.key);
      let activeKey = m.activeKey;
      if (activeKey === a.key) activeKey = tabOrder[Math.min(idx, tabOrder.length - 1)] ?? null;
      const activeSessionId = activeKey ? terms[activeKey].sessionId : m.activeSessionId;
      return { ...m, terms, tabOrder, activeKey, activeSessionId };
    }
    case 'activate': {
      if (a.key === null) return { ...m, activeKey: null };
      const t = m.terms[a.key];
      if (!t) return m;
      return { ...patchTerm(m, a.key, (x) => ({ ...x, badge: false })), activeKey: a.key, activeSessionId: t.sessionId };
    }
    case 'activateSession': {
      const first = m.tabOrder.find((k) => m.terms[k].sessionId === a.id);
      return { ...m, activeSessionId: a.id, activeKey: first ?? m.activeKey };
    }
    case 'passthrough':
      return patchTerm(m, a.key, (t) => ({
        ...t,
        passthrough: a.mode,
        returnKeys: a.mode === 'temp' ? (a.returnKeys ?? []) : [],
        // 手动切换后不再受备用屏幕自动控制
        autoPassthrough: a.auto ? t.autoPassthrough : false,
      }));
    case 'badge':
      return patchTerm(m, a.key, (t) => (t.badge === a.on ? t : { ...t, badge: a.on }));
    case 'permissionCard':
      return patchTerm(m, a.key, (t) => ({ ...t, permissionCard: a.card }));
    case 'toast':
      return { ...m, toasts: [...m.toasts.slice(-3), a.toast] };
    case 'toastDismiss':
      return { ...m, toasts: m.toasts.filter((t) => t.id !== a.id) };
    case 'update':
      return { ...m, update: a.update };
    case 'connectPhase': {
      const connecting = { ...m.connecting };
      if (a.phase) connecting[a.requestId] = a.phase;
      else delete connecting[a.requestId];
      return { ...m, connecting };
    }
    case 'dragging':
      return m.dragging === a.on ? m : { ...m, dragging: a.on };
    case 'core':
      return applyCore(m, a.e, a.now);
  }
}

export class Store {
  private state: AppModel = initialModel;
  private listeners = new Set<() => void>();

  getState = (): AppModel => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  dispatch = (a: Action): void => {
    const next = reducer(this.state, a);
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  };
}
