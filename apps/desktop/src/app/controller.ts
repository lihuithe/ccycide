/**
 * 应用控制器：把 Backend、Store、xterm 运行时串起来的所有副作用逻辑。
 * 纯判定逻辑都在 src/lib 里（有单测），这里只做编排。
 */
import { getBackend, toCommandError, type Backend } from '../backend';
import type {
  ActionDef,
  AppNotice,
  CommandError,
  CoreEvent,
  FileId,
  LaunchOptions,
  SessionId,
  Settings,
  TermProfile,
} from '../backend/types';
import { Features } from '../backend/types';
import { Store, eventTarget, findTermKey, makeTab, type PassthroughMode, type TermTab } from '../state/store';
import { actionErrorText } from '../lib/actions';
import { canSend, notReadyHint } from '../lib/session';
import { blockedStatusFromCode, blockedStatusFromNotice, blockedText, isBlocked } from '../lib/termErrors';
import { focusJumpTarget, NoticeNotifier, type FocusTarget } from '../lib/notify';
import { formatDeviceCode, platformLabel } from '../lib/format';
import { TermRuntime } from './termRuntime';
import { applyThemeAttr, resolveDark } from './theme';
import { confirmDialog } from './ui';

/** 前端生成的 connect 请求 id */
export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 输入框向控制器注册的能力 */
export interface ComposerHandle {
  focus(insert?: string): void;
  setText(text: string): void;
  addPaths(paths: string[]): void;
}

interface PendingOpen {
  shellId?: string;
  cwd?: string;
  command?: string;
  launch?: LaunchOptions;
}

const EARLY_LIMIT = 300;

export class Controller {
  readonly store = new Store();
  private runtimes = new Map<string, TermRuntime>();
  private composers = new Map<string, ComposerHandle>();
  private pendingOpen = new Map<string, PendingOpen>();
  private early: { sessionId: string; termId?: string; e: CoreEvent }[] = [];
  private notifier = new NoticeNotifier();
  private focusTarget: FocusTarget | null = null;
  private toastSeq = 1;
  private keySeq = 1;
  private unsubs: (() => void)[] = [];
  private mediaQuery: MediaQueryList | null = null;

  private constructor(readonly backend: Backend) {}

  static async create(): Promise<Controller> {
    const c = new Controller(await getBackend());
    await c.init();
    return c;
  }

  // ———————————————————— 初始化 ————————————————————

  private async init(): Promise<void> {
    const b = this.backend;
    this.unsubs.push(await b.onEvent((e) => this.handleEvent(e)));
    this.unsubs.push(await b.onDragDrop((e) => this.handleDrag(e)));
    const [local, settings, knownHosts] = await Promise.all([b.localInfo(), b.getSettings(), b.listKnownHosts()]);
    this.store.dispatch({ type: 'init', local, settings, knownHosts });
    this.applyTheme(settings);

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onMedia = () => this.applyTheme(this.store.getState().settings);
    this.mediaQuery.addEventListener('change', onMedia);
    this.unsubs.push(() => this.mediaQuery?.removeEventListener('change', onMedia));

    const onFocus = () => this.onWindowFocus();
    window.addEventListener('focus', onFocus);
    this.unsubs.push(() => window.removeEventListener('focus', onFocus));

    // 启动后稍等再检查更新，失败静默
    setTimeout(() => void this.checkUpdate(true), 4000);
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.runtimes.forEach((r) => r.dispose());
  }

  // ———————————————————— 事件 ————————————————————

  private handleEvent(e: CoreEvent): void {
    // 主控方在等待确认期间取消：撤掉该项并提示一次（先于 reducer，需要读到被撤掉前的条目）
    if (e.type === 'incomingClosed' && e.reason === 'cancelled') {
      const had = this.store.getState().incoming.find((i) => i.sessionId === e.sessionId);
      if (had) this.toast(`${formatDeviceCode(had.fromCode)} 取消了连接请求`);
    }
    const target = eventTarget(e);
    if (target) {
      const st = this.store.getState();
      const knownSession = !!st.sessions[target.sessionId];
      const knownTerm = target.termId === undefined || findTermKey(st, target.sessionId, target.termId) !== undefined;
      if (!knownSession || !knownTerm) {
        this.early.push({ sessionId: target.sessionId, termId: target.termId, e });
        if (this.early.length > EARLY_LIMIT) this.early.shift();
        return;
      }
    }
    this.store.dispatch({ type: 'core', e, now: Date.now() });
    this.sideEffects(e);
  }

  /** 会话/终端注册后，重放此前提早到达的事件 */
  private flushEarly(sessionId: string, termId?: string): void {
    const mine = this.early.filter((x) => x.sessionId === sessionId && (termId === undefined || x.termId === termId || x.termId === undefined));
    if (mine.length === 0) return;
    this.early = this.early.filter((x) => !mine.includes(x));
    mine.forEach((x) => this.handleEvent(x.e));
  }

  private sideEffects(e: CoreEvent): void {
    const st = this.store.getState();
    switch (e.type) {
      case 'incomingSession': {
        if (e.pendingConfirm) {
          // 需要用户处理的请求：窗口失焦时必须通知（点击通知回到应用由系统处理）
          if (!document.hasFocus()) {
            void this.backend.notify('有设备请求连接', `${formatDeviceCode(e.fromCode)} (${platformLabel(e.platform)})`).catch(() => {});
          }
        } else if (st.settings?.host.notifyOnConnect) {
          void this.backend.notify('有设备连入', `${formatDeviceCode(e.fromCode)} 已连接到本机`).catch(() => {});
        }
        break;
      }
      case 'sessionState':
        if (e.requestId) break; // connect 进行中的状态，只用于连接按钮区
        if (e.state === 'closed' && e.reason) this.toast(`已断开：${e.reason}`, 'error');
        else if (e.state === 'ready') this.afterReady(e.sessionId);
        break;
      case 'termExit': {
        const key = findTermKey(st, e.sessionId, e.termId);
        if (key) this.runtimes.get(key)?.writeLocal(`\r\n\x1b[90m[进程已退出，代码 ${e.code}]\x1b[0m\r\n`);
        break;
      }
      case 'appNotice': {
        const key = findTermKey(st, e.sessionId, e.termId);
        if (key) this.handleNotice(key, e.notice);
        break;
      }
      case 'termState': {
        const key = findTermKey(st, e.sessionId, e.termId);
        if (key) this.syncPassthroughFocus(key);
        break;
      }
      default:
    }
  }

  /** 重连成功后让终端画面尺寸重新同步，触发远端重绘 */
  private afterReady(sessionId: SessionId): void {
    const st = this.store.getState();
    for (const k of st.tabOrder) {
      if (st.terms[k].sessionId === sessionId) this.runtimes.get(k)?.forceResize();
    }
  }

  private handleNotice(key: string, n: AppNotice): void {
    const st = this.store.getState();
    const tab = st.terms[key];
    if (!tab) return;
    // 终端级错误：标签状态已由 reducer 更新，这里只提示一次，不发系统通知
    const blocked = blockedStatusFromNotice(n);
    if (blocked) {
      if (!isBlocked(tab.status)) this.toast(blockedText(blocked), 'error');
      return;
    }
    const s = st.settings;
    const d = this.notifier.decide(
      key,
      n,
      {
        windowFocused: document.hasFocus(),
        isActiveTab: st.activeKey === key,
        tabLabel: this.tabLabel(tab),
        notifyOnDone: s?.controller.notifyOnDone ?? true,
        notifyOnPermission: s?.controller.notifyOnPermission ?? true,
      },
      Date.now(),
    );
    if (!d) return;
    if (d.badge) this.store.dispatch({ type: 'badge', key, on: true });
    if (d.system) {
      this.focusTarget = { termKey: key, at: Date.now() };
      void this.backend.notify(d.title, d.body).catch(() => {});
    }
  }

  tabLabel(tab: TermTab): string {
    const st = this.store.getState();
    const host = st.sessions[tab.sessionId]?.info?.hostname;
    return host && st.sessionOrder.length > 1 ? `${host} · ${tab.title}` : tab.title;
  }

  /** 窗口重新获得焦点：清除当前标签角标；最近有通知则跳到对应标签（桌面通知点击回调不可用时的替代） */
  private onWindowFocus(): void {
    const st = this.store.getState();
    const jump = focusJumpTarget(this.focusTarget, Date.now());
    this.focusTarget = null;
    if (jump && st.terms[jump]) {
      this.store.dispatch({ type: 'activate', key: jump });
    } else if (st.activeKey) {
      this.store.dispatch({ type: 'badge', key: st.activeKey, on: false });
    }
  }

  private handleDrag(e: import('../backend/types').DragDropEvent): void {
    if (e.type === 'enter') this.store.dispatch({ type: 'dragging', on: true });
    else if (e.type === 'leave') this.store.dispatch({ type: 'dragging', on: false });
    else {
      this.store.dispatch({ type: 'dragging', on: false });
      const key = this.store.getState().activeKey;
      if (key) this.composers.get(key)?.addPaths(e.paths);
      else this.toast('请先连接设备并打开终端', 'info');
    }
  }

  // ———————————————————— 通用 ————————————————————

  toast(text: string, tone: 'info' | 'error' = 'info'): void {
    const id = this.toastSeq++;
    this.store.dispatch({ type: 'toast', toast: { id, text, tone } });
    setTimeout(() => this.store.dispatch({ type: 'toastDismiss', id }), tone === 'error' ? 5000 : 2800);
  }

  errorText(e: unknown): string {
    return toCommandError(e).message || '操作失败';
  }

  // ———————————————————— 本机 / 设置 ————————————————————

  async refreshPassword(): Promise<void> {
    try {
      const pw = await this.backend.refreshTempPassword();
      const local = this.store.getState().local;
      if (local) this.store.dispatch({ type: 'local', local: { ...local, tempPassword: pw } });
    } catch (e) {
      this.toast(this.errorText(e), 'error');
    }
  }

  async setFixedPassword(pw: string | null): Promise<void> {
    await this.backend.setFixedPassword(pw);
    const local = this.store.getState().local;
    if (local) this.store.dispatch({ type: 'local', local: { ...local, fixedPasswordSet: pw !== null } });
  }

  async copy(text: string, what = '已复制'): Promise<void> {
    try {
      await this.backend.copyText(text);
      this.toast(what);
    } catch {
      this.toast('复制失败', 'error');
    }
  }

  private applyTheme(settings: Settings | null): void {
    const choice = settings?.controller.theme ?? 'auto';
    applyThemeAttr(choice);
    const dark = resolveDark(choice);
    this.runtimes.forEach((r) => {
      r.setTheme(dark);
      r.setFontSize(settings?.controller.fontSize ?? 14);
    });
  }

  async saveSettings(next: Settings): Promise<void> {
    const prev = this.store.getState().settings;
    const saved = await this.backend.setSettings(next);
    if (prev && prev.app.autostart !== saved.app.autostart) {
      await this.backend.setAutostart(saved.app.autostart);
    }
    this.store.dispatch({ type: 'settings', settings: saved });
    this.applyTheme(saved);
  }

  async acceptIncoming(sessionId: string): Promise<void> {
    await this.backend.acceptIncoming(sessionId).catch((e) => this.toast(this.errorText(e), 'error'));
    this.store.dispatch({ type: 'incomingConfirmed', sessionId });
  }

  async rejectIncoming(sessionId: string): Promise<void> {
    await this.backend.rejectIncoming(sessionId).catch(() => {});
    this.store.dispatch({ type: 'core', e: { type: 'incomingClosed', sessionId, reason: 'rejected' }, now: Date.now() });
  }

  async disconnectIncoming(sessionId: string): Promise<void> {
    await this.backend.disconnectIncoming(sessionId).catch((e) => this.toast(this.errorText(e), 'error'));
  }

  async disconnectAllIncoming(): Promise<void> {
    await this.backend.disconnectAllIncoming().catch((e) => this.toast(this.errorText(e), 'error'));
  }

  async dismissSafetyNotice(): Promise<void> {
    const s = this.store.getState().settings;
    if (s) await this.saveSettings({ ...s, app: { ...s.app, safetyNoticeAcked: true } });
  }

  async removeKnownHost(code: string): Promise<void> {
    await this.backend.removeKnownHost(code);
    this.store.dispatch({ type: 'knownHosts', hosts: await this.backend.listKnownHosts() });
  }

  // —— 更新 ——

  async checkUpdate(silent: boolean): Promise<void> {
    try {
      const info = await this.backend.checkUpdate();
      if (info) this.store.dispatch({ type: 'update', update: { info, progress: null } });
      else if (!silent) this.toast('已是最新版本');
    } catch (e) {
      if (!silent) this.toast(`检查更新失败：${this.errorText(e)}`, 'error');
    }
  }

  async installUpdate(): Promise<void> {
    const u = this.store.getState().update;
    if (!u) return;
    this.store.dispatch({ type: 'update', update: { ...u, progress: 0, error: undefined } });
    try {
      await this.backend.installUpdate((p) => {
        const cur = this.store.getState().update;
        if (cur) this.store.dispatch({ type: 'update', update: { ...cur, progress: p } });
      });
    } catch (e) {
      const cur = this.store.getState().update;
      if (cur) this.store.dispatch({ type: 'update', update: { ...cur, progress: null, error: this.errorText(e) } });
    }
  }

  // ———————————————————— 主控：会话 ————————————————————

  /** 连接；失败抛出 CommandError。成功后自动附着对端已有的终端 */
  async connect(deviceCode: string, password: string, requestId: string): Promise<SessionId> {
    this.store.dispatch({ type: 'connectPhase', requestId, phase: 'connecting' });
    let id: SessionId;
    try {
      id = await this.backend.connect(deviceCode, password, requestId);
    } finally {
      this.store.dispatch({ type: 'connectPhase', requestId, phase: null });
    }
    this.registerSession(id, deviceCode);
    this.store.dispatch({ type: 'knownHosts', hosts: await this.backend.listKnownHosts().catch(() => []) });
    await this.attachExisting(id);
    return id;
  }

  /** connect 成功即握手完成：先置为 Ready（Ready 事件可能晚于命令返回），再重放提早到达的事件 */
  private registerSession(id: SessionId, deviceCode: string): void {
    this.store.dispatch({ type: 'sessionAdd', id, deviceCode });
    this.store.dispatch({ type: 'core', e: { type: 'sessionState', sessionId: id, state: 'ready' }, now: Date.now() });
    this.flushEarly(id);
  }

  /** 连接成功后：对端上已有终端（例如上次会话遗留）的，作为新标签附着 */
  private async attachExisting(sessionId: SessionId): Promise<void> {
    try {
      const terms = await this.backend.listTerms(sessionId);
      for (const t of terms) {
        const st = this.store.getState();
        if (findTermKey(st, sessionId, t.termId)) continue;
        const key = `t${this.keySeq++}`;
        this.store.dispatch({ type: 'termAdd', tab: makeTab({ key, sessionId, profile: t.profile, title: t.title || this.defaultTitle(t.profile), remoteId: t.termId, status: t.attachedByOther ? 'busy' : 'open' }) });
        this.flushEarly(sessionId, t.termId);
      }
    } catch {
      /* 列表失败不影响新建终端 */
    }
  }

  /** 取消进行中的 connect（等待对方确认时）；connect 本身会以 CANCELLED 失败 */
  async cancelConnect(requestId: string): Promise<void> {
    await this.backend.cancelConnect(requestId).catch((e) => this.toast(this.errorText(e), 'error'));
  }

  /** 已关闭（如密码错误）的会话：用新密码重新连接，并把原有标签接回新会话（按偏移续传） */
  async reconnectSession(oldId: SessionId, password: string): Promise<void> {
    const old = this.store.getState().sessions[oldId];
    if (!old) return;
    const newId = await this.backend.connect(old.deviceCode, password, newRequestId());
    this.registerSession(newId, old.deviceCode);
    const st = this.store.getState();
    const remote = await this.backend.listTerms(newId).catch(() => []);
    for (const key of st.tabOrder) {
      const tab = st.terms[key];
      if (tab.sessionId !== oldId) continue;
      const alive = tab.remoteId ? remote.find((r) => r.termId === tab.remoteId) : undefined;
      if (!alive || !tab.remoteId) continue;
      this.store.dispatch({ type: 'termRebind', key, sessionId: newId });
      const rt = this.runtimes.get(key);
      const size = rt?.size() ?? { cols: 120, rows: 30 };
      await this.backend
        .attachTerm({ sessionId: newId, termId: tab.remoteId, cols: size.cols, rows: size.rows, lastSeq: rt?.renderedOffset ?? 0 }, (f) => this.runtimes.get(key)?.onOutput(f))
        .catch((e) => this.onAttachError(key, e));
      this.flushEarly(newId, tab.remoteId);
    }
    this.store.dispatch({ type: 'sessionRemove', id: oldId });
    // 没接回去的标签随旧会话一起移除；释放其运行时
    this.pruneRuntimes();
    void this.attachExisting(newId);
  }

  async disconnect(sessionId: SessionId): Promise<void> {
    await this.backend.disconnect(sessionId).catch(() => {});
    this.store.dispatch({ type: 'sessionRemove', id: sessionId });
    this.pruneRuntimes();
  }

  private pruneRuntimes(): void {
    const st = this.store.getState();
    for (const [k, rt] of this.runtimes) {
      if (!st.terms[k]) {
        rt.dispose();
        this.runtimes.delete(k);
        this.composers.delete(k);
        this.pendingOpen.delete(k);
      }
    }
  }

  // ———————————————————— 主控：终端 ————————————————————

  defaultTitle(profile: TermProfile): string {
    return profile === 'claude' ? 'Claude Code' : '终端';
  }

  /** 新建标签；真正的 open_term 在标签挂载、拿到尺寸后由 startTerm 执行 */
  newTerm(sessionId: SessionId, profile: TermProfile, opts: PendingOpen = {}): string | null {
    const st = this.store.getState();
    const session = st.sessions[sessionId];
    if (!session || !canSend(session.phase)) {
      this.toast(notReadyHint(session?.phase), 'error');
      return null;
    }
    const key = `t${this.keySeq++}`;
    const n = st.tabOrder.filter((k) => st.terms[k].profile === profile).length + 1;
    const base = this.defaultTitle(profile);
    this.pendingOpen.set(key, opts);
    this.store.dispatch({ type: 'termAdd', tab: makeTab({ key, sessionId, profile, title: n > 1 ? `${base} ${n}` : base }) });
    return key;
  }

  runtime(key: string): TermRuntime {
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = new TermRuntime({
        backend: this.backend,
        getTab: () => this.store.getState().terms[key],
        getSettings: () => this.store.getState().settings,
        isDark: () => resolveDark(this.store.getState().settings?.controller.theme ?? 'auto'),
        onTogglePassthrough: () => this.togglePassthrough(key),
        onReturnKey: () => this.setPassthrough(key, 'off'),
        onPrintable: (ch) => this.composers.get(key)?.focus(ch),
        onError: (m) => this.toast(m, 'error'),
      });
      this.runtimes.set(key, rt);
    }
    return rt;
  }

  /** 标签挂载到 DOM 后调用：打开新终端或附着已有终端 */
  async startTerm(key: string): Promise<void> {
    const rt = this.runtime(key);
    const tab = this.store.getState().terms[key];
    if (!tab || !rt.mounted) return;
    // 占用/被接管/已不存在的标签不附着，也不重试
    if (tab.status !== 'opening' && tab.status !== 'open') return;
    const { cols, rows } = rt.size();
    try {
      if (tab.remoteId) {
        await this.backend.attachTerm({ sessionId: tab.sessionId, termId: tab.remoteId, cols, rows, lastSeq: 0 }, rt.onOutput);
        rt.forceResize();
        return;
      }
      const opts = this.pendingOpen.get(key);
      if (!opts) return;
      this.pendingOpen.delete(key);
      const opened = await this.backend.openTerm(
        { sessionId: tab.sessionId, profile: tab.profile, cols, rows, shellId: opts.shellId, cwd: opts.cwd, command: opts.command, launch: opts.launch },
        rt.onOutput,
      );
      this.store.dispatch({ type: 'termOpened', key, remoteId: opened.termId, title: opened.title });
      this.flushEarly(tab.sessionId, opened.termId);
      rt.forceResize();
      if (tab.profile === 'claude') {
        const feats = this.store.getState().sessions[tab.sessionId]?.features ?? [];
        if (feats.includes(Features.appCommands)) void this.backend.commandListReq(tab.sessionId, opened.termId).catch(() => {});
        // 选择历史会话：打开的是 Claude Code 自己的选择菜单，进入临时直通
        if (opts.launch?.resume === 'pick') this.setPassthrough(key, 'temp', ['enter', 'esc']);
      }
    } catch (e) {
      this.onAttachError(key, e);
    }
  }

  /** attach/open 失败：TERM_BUSY 等转为标签状态（不重试、不接管），其它显示为失败 */
  private onAttachError(key: string, e: unknown): void {
    const err = toCommandError(e);
    const blocked = blockedStatusFromCode(err.code);
    if (blocked) {
      this.store.dispatch({ type: 'termBlocked', key, status: blocked });
      this.toast(blockedText(blocked), 'error');
    } else {
      this.store.dispatch({ type: 'termFailed', key, reason: err.message });
      this.toast(err.message, 'error');
    }
  }

  async closeTerm(key: string): Promise<void> {
    const tab = this.store.getState().terms[key];
    if (!tab) return;
    // 占用/被接管/已不存在的终端不属于本端，关闭标签时不能去关远端终端
    if (tab.remoteId && tab.status !== 'exited' && !isBlocked(tab.status)) {
      await this.backend.closeTerm(tab.sessionId, tab.remoteId).catch(() => {});
    }
    this.store.dispatch({ type: 'termRemove', key });
    this.pruneRuntimes();
  }

  activate(key: string): void {
    this.store.dispatch({ type: 'activate', key });
  }

  /** 以 delta 切换标签（Ctrl+Tab） */
  cycleTab(delta: number): void {
    const st = this.store.getState();
    if (st.tabOrder.length === 0) return;
    const i = st.activeKey ? st.tabOrder.indexOf(st.activeKey) : -1;
    const n = st.tabOrder.length;
    this.activate(st.tabOrder[(i + delta + n) % n]);
  }

  /** 把文本填进某个标签的输入框并聚焦（命令面板选中自定义命令） */
  fillComposer(key: string, text: string): void {
    this.composers.get(key)?.setText(text);
  }

  // ———————————————————— 直通 ————————————————————

  registerComposer(key: string, h: ComposerHandle | null): void {
    if (h) this.composers.set(key, h);
    else this.composers.delete(key);
  }

  setPassthrough(key: string, mode: PassthroughMode, returnKeys: string[] = []): void {
    this.store.dispatch({ type: 'passthrough', key, mode, returnKeys });
    this.syncPassthroughFocus(key);
  }

  togglePassthrough(key: string): void {
    const tab = this.store.getState().terms[key];
    if (!tab) return;
    this.setPassthrough(key, tab.passthrough === 'off' ? 'on' : 'off');
  }

  /** 直通 → 焦点给 xterm；退出直通 → 焦点回输入框 */
  private syncPassthroughFocus(key: string): void {
    const tab = this.store.getState().terms[key];
    if (!tab || this.store.getState().activeKey !== key) return;
    // 等 React 把输入框渲染/隐藏后再移焦点
    setTimeout(() => {
      if (tab.passthrough === 'off') this.composers.get(key)?.focus();
      else this.runtimes.get(key)?.focus();
    }, 0);
  }

  // ———————————————————— 提交 / 输入 ————————————————————

  async submit(key: string, text: string, attachments: FileId[]): Promise<boolean> {
    const tab = this.store.getState().terms[key];
    const session = tab && this.store.getState().sessions[tab.sessionId];
    if (!tab || !tab.remoteId || !session) return false;
    if (!canSend(session.phase)) {
      this.toast(notReadyHint(session.phase), 'error');
      return false;
    }
    try {
      await this.backend.termSubmit(tab.sessionId, tab.remoteId, text, attachments);
      return true;
    } catch (e) {
      this.toast(this.errorText(e), 'error');
      return false;
    }
  }

  sendInput(key: string, bytes: Uint8Array): void {
    const tab = this.store.getState().terms[key];
    const session = tab && this.store.getState().sessions[tab.sessionId];
    if (!tab || !tab.remoteId || !session) return;
    if (!canSend(session.phase)) {
      this.toast(notReadyHint(session.phase), 'error');
      return;
    }
    void this.backend.termInput(tab.sessionId, tab.remoteId, bytes).catch((e) => this.toast(this.errorText(e), 'error'));
  }

  // ———————————————————— 动作 ————————————————————

  async runAction(key: string, def: ActionDef, args: Record<string, string>): Promise<boolean> {
    const st = this.store.getState();
    const tab = st.terms[key];
    if (!tab || !tab.remoteId) return false;
    // 确认框里显示被控端即将执行的动作标题，防止“点了 A 实际执行 B”
    if (def.confirm) {
      const argText = Object.values(args).filter(Boolean).join(' ');
      const ok = await confirmDialog({
        title: argText ? `${def.title}：${argText}` : def.title,
        message: def.confirm,
        okText: '执行',
      });
      if (!ok) return false;
    }
    if (tab.app?.stateful && tab.app.activity === 'busy' && def.kind !== 'keys') this.toast('将在当前回合结束后执行');
    try {
      const r = await this.backend.termAction(tab.sessionId, tab.remoteId, def.id, args);
      if (r.passthrough) this.setPassthrough(key, 'temp', r.returnKeys);
      return true;
    } catch (e) {
      this.toast(actionErrorText(toCommandError(e) as CommandError), 'error');
      return false;
    }
  }

  /** 把一段文本当作消息提交（命令面板里的自定义命令） */
  async submitCommand(key: string, text: string): Promise<void> {
    await this.submit(key, text, []);
  }

  // ———————————————————— 上传 ————————————————————

  async uploadPath(sessionId: SessionId, path: string) {
    return this.backend.uploadPath(sessionId, path);
  }

  async uploadBytes(sessionId: SessionId, name: string, mime: string, data: Uint8Array) {
    return this.backend.uploadBytes({ sessionId, name, mime, data });
  }
}
