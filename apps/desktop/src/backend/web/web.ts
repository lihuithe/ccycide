/**
 * Web 版 Backend：在浏览器里直接实现主控端（身份、信令、SPAKE2 握手、加密会话），不经过任何服务端网关。
 * 服务端（信令 + 中继）只看到密文；设备私钥只存在本浏览器档案里。
 *
 * 一个浏览器档案 = 一台设备 = 同一时刻只有一个活动标签页（Web Locks）。第二个标签页打开时提示“已在另一个标签页使用”，
 * 可以选择接管（原标签页随即刷新并看到同样的提示）。不同浏览器 / 无痕窗口是各自独立的设备。
 */
import { defaultSettings } from '../mockData';
import type { Backend } from '../index';
import { toCommandError } from '../index';
import type {
  CoreEvent,
  DragDropEvent,
  KnownHost,
  LocalInfo,
  OutputHandler,
  Settings,
  TermAttachParams,
  TermOpenParams,
  TermOpened,
  UploadBytesParams,
  UploadStarted,
} from '../types';
import { derivePwKey, passwordKindOf } from './crypto';
import { APP_VERSION, fetchSignalUrl, loadOrCreateIdentity, reRegister, type Identity } from './identity';
import { Profile } from './proto';
import { EstablishError, establishController } from './relay';
import { ConnectCtl, ConnectError, Session, connectErrorCode, toConnectError, type ConnectSpec, type Connected, type Connector } from './session';
import { SignalClient, SignalError } from './signal';
import { kvGet, kvSet } from './storage';
import { CodedError, b64decode, b64encode } from './util';

const LOCK_NAME = 'rterm-web-active';

declare global {
  interface Window {
    /** 部署时可在 index.html 里覆盖 API 地址；默认与页面同源（Caddy 把 /v1/* 反代到 API） */
    __RTERM_API_URL__?: string;
  }
}

function apiUrl(): string {
  return window.__RTERM_API_URL__ || import.meta.env.VITE_RTERM_API_URL || window.location.origin;
}

// ———————————————————— 单标签页锁 ————————————————————

/**
 * 同一浏览器档案只允许一个活动标签页。拿不到锁时抛 ACTIVE_ELSEWHERE（界面显示“接管”按钮，调用 takeOverActiveTab）；
 * 持有锁的标签页被别的标签页接管时，锁请求会被中止，这里让页面刷新，刷新后会看到同样的提示。
 */
async function acquireTabLock(): Promise<void> {
  if (!('locks' in navigator)) return; // 极旧的浏览器：放弃保护
  const granted = new Promise<boolean>((resolve) => {
    void navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        if (lock === null) return undefined;
        return new Promise<void>(() => {}); // 持有到页面关闭
      })
      .catch(() => {
        // 被 steal：本标签页失去了活动资格
        window.location.reload();
      });
  });
  if (!(await granted)) throw new CodedError('ACTIVE_ELSEWHERE', 'RTerm 已在这个浏览器的另一个标签页打开。同一个浏览器只能有一个活动标签页，请切换到那个标签页，或点击“接管”。');
}

/** 接管：抢走锁，原标签页会刷新并看到提示 */
export async function takeOverActiveTab(): Promise<void> {
  await new Promise<void>((resolve) => {
    void navigator.locks
      .request(LOCK_NAME, { steal: true }, () => {
        resolve();
        return new Promise<void>(() => {});
      })
      .catch(() => window.location.reload());
  });
  window.location.reload();
}

// ———————————————————— 已记住的设备 ————————————————————

interface KnownRec {
  publicKey: string;
  alias?: string;
  lastConnected?: string;
}

const knownKey = 'knownHosts';
const settingsKey = 'settings';

function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  const s = saved ?? {};
  return {
    host: { ...d.host, ...s.host },
    controller: { ...d.controller, ...s.controller },
    server: { ...d.server, ...s.server },
    app: { ...d.app, ...s.app, safetyNoticeAcked: true },
  };
}

// ———————————————————— 终端输出路由 ————————————————————

interface Route {
  handler: OutputHandler | null;
  pending: Array<{ seq: number; data: Uint8Array }>;
}

const key = (sid: string, term: string): string => `${sid}\u0000${term}`;
const MAX_PENDING_FRAMES = 2048;

// ———————————————————— 连接器 ————————————————————

/** 信令 connect.request + 中继握手：一次连接尝试（首次连接和自动重连都用它） */
export function makeConnector(signal: SignalClient): Connector {
  return {
    connect: async (spec: ConnectSpec): Promise<Connected> => {
      const handle = signal.connectRequest(spec.hostCode);
      spec.ctl?.attach(() => handle.cancel());
      handle.pending.then(() => spec.ctl?.setAwaiting()).catch(() => {});
      let ok;
      try {
        ok = await handle.result;
      } catch (e) {
        throw e instanceof SignalError ? new ConnectError('signal', e.userText(), e) : toConnectError(e);
      }
      try {
        const link = await establishController({
          relayUrl: ok.relayUrl,
          ticket: ok.ticket,
          sessionId: ok.sessionId,
          identity: signal.currentIdentity,
          controllerCode: signal.deviceCode,
          hostCode: spec.hostCode,
          hostPublicKey: b64decode(ok.peer.publicKey),
          pwKey: spec.pwKey,
          pwKind: spec.pwKind,
          knownHostKey: spec.knownHostKey,
          acceptKeyChange: spec.acceptKeyChange,
        });
        return { link, peerPublicKey: link.peerPublicKey };
      } catch (e) {
        throw e instanceof EstablishError ? new ConnectError('establish', e.message, undefined, e) : toConnectError(e);
      }
    },
  };
}

// ———————————————————— 创建 ————————————————————

export async function createWebBackend(): Promise<Backend> {
  await acquireTabLock();
  const api = apiUrl();
  const identity: Identity = await loadOrCreateIdentity(api);
  const web = new WebBackend(api, identity);
  await web.start();
  return web;
}

class WebBackend implements Backend {
  readonly kind = 'web' as const;

  private listeners = new Set<(e: CoreEvent) => void>();
  private dragListeners = new Set<(e: DragDropEvent) => void>();
  private sessions = new Map<string, Session>();
  private connects = new Map<string, ConnectCtl>();
  private routes = new Map<string, Route>();
  private picked = new Map<number, File>();
  private pickSeq = 1;
  private signal: SignalClient;
  private signalUrl: Promise<string> | null = null;
  private settings: Settings = mergeSettings(undefined);
  private known: Record<string, KnownRec> = {};

  constructor(
    private api: string,
    private identity: Identity,
  ) {
    this.signal = new SignalClient(identity, () => (this.signalUrl ??= fetchSignalUrl(api)), {
      onState: (online) => {
        this.emit({ type: 'signalState', online });
      },
      onNotice: () => {},
      onUnknownDevice: async () => {
        const fresh = await reRegister(this.api, this.signal.currentIdentity);
        this.identity = fresh;
        this.emit({ type: 'localInfoChanged', info: this.local() });
        return fresh;
      },
      onUpgradeRequired: () => {},
    });
  }

  async start(): Promise<Identity> {
    this.settings = mergeSettings(await kvGet<Partial<Settings>>(settingsKey));
    this.known = (await kvGet<Record<string, KnownRec>>(knownKey)) ?? {};
    this.signal.start();
    const onWake = (): void => {
      this.signal.networkChanged();
      for (const s of this.sessions.values()) s.reconnectNow();
    };
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && onWake());
    this.installDragDrop();
    return this.identity;
  }

  private emit(e: CoreEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  private local(): LocalInfo {
    return {
      deviceCode: this.signal.deviceCode || this.identity.deviceCode,
      tempPassword: '',
      online: this.signal.isOnline,
      fixedPasswordSet: false,
      appVersion: APP_VERSION,
      platform: /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'macos' : 'linux',
    };
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new CodedError('NO_SUCH_SESSION', `会话不存在：${id}`);
    return s;
  }

  // ———————————————————— 本机（Web 端没有被控功能）————————————————————

  async localInfo(): Promise<LocalInfo> {
    return this.local();
  }
  async refreshTempPassword(): Promise<string> {
    return '';
  }
  async setFixedPassword(): Promise<void> {}
  async acceptIncoming(): Promise<void> {}
  async rejectIncoming(): Promise<void> {}
  async disconnectIncoming(): Promise<void> {}
  async disconnectAllIncoming(): Promise<void> {}

  async listKnownHosts(): Promise<KnownHost[]> {
    return Object.entries(this.known)
      .map(([deviceCode, r]) => ({ deviceCode, alias: r.alias, lastConnected: r.lastConnected }))
      .sort((a, b) => (b.lastConnected ?? '').localeCompare(a.lastConnected ?? ''));
  }

  async removeKnownHost(deviceCode: string): Promise<void> {
    delete this.known[deviceCode];
    await kvSet(knownKey, this.known);
  }

  // ———————————————————— 设置 ————————————————————

  async getSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async setSettings(settings: Settings): Promise<Settings> {
    this.settings = mergeSettings(settings);
    await kvSet(settingsKey, this.settings);
    return structuredClone(this.settings);
  }

  // ———————————————————— 主控 ————————————————————

  async connect(deviceCode: string, password: string, requestId: string): Promise<string> {
    const code = deviceCode.replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(code)) throw new CodedError('BAD_REQUEST', '设备码应为 9 位数字');
    if (!password) throw new CodedError('BAD_REQUEST', '请输入密码');
    const ctl = new ConnectCtl();
    ctl.onAwaiting = () => this.emit({ type: 'sessionState', sessionId: '', requestId, state: 'awaitingApproval' });
    this.connects.set(requestId, ctl);
    try {
      const pwKey = await derivePwKey(password, code);
      if (ctl.cancelled) throw new CodedError('CANCELLED', '已取消连接');
      const spec: ConnectSpec = {
        hostCode: code,
        pwKey,
        pwKind: passwordKindOf(password),
        knownHostKey: this.known[code] ? b64decode(this.known[code].publicKey) : null,
        acceptKeyChange: false,
        ctl,
      };
      const id = crypto.randomUUID();
      let session: Session;
      try {
        session = await Session.connect(
          id,
          makeConnector(this.signal),
          spec,
          {
            emit: (e) => this.emit(e),
            onOutput: (sid, term, seq, data) => this.routeOutput(sid, term, seq, data),
          },
          APP_VERSION,
        );
      } catch (e) {
        if (e instanceof ConnectError) throw new CodedError(connectErrorCode(e), e.userText());
        throw e;
      }
      this.sessions.set(id, session);
      this.known[code] = { ...this.known[code], publicKey: b64encode(session.peerKey), lastConnected: new Date().toISOString() };
      void kvSet(knownKey, this.known);
      return id;
    } finally {
      this.connects.delete(requestId);
    }
  }

  async cancelConnect(requestId: string): Promise<void> {
    this.connects.get(requestId)?.cancel();
  }

  async disconnect(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.disconnect();
    this.sessions.delete(sessionId);
    for (const k of [...this.routes.keys()]) if (k.startsWith(`${sessionId}\u0000`)) this.routes.delete(k);
  }

  // ———————————————————— 终端 ————————————————————

  private routeOutput(sid: string, term: string, seq: number, data: Uint8Array): void {
    const k = key(sid, term);
    let r = this.routes.get(k);
    if (!r) {
      r = { handler: null, pending: [] };
      this.routes.set(k, r);
    }
    if (r.handler) r.handler({ seq, data });
    else {
      r.pending.push({ seq, data });
      if (r.pending.length > MAX_PENDING_FRAMES) r.pending.shift();
    }
  }

  private register(sid: string, term: string, handler: OutputHandler, replayPending: boolean): void {
    const k = key(sid, term);
    const r = this.routes.get(k) ?? { handler: null, pending: [] };
    const pending = replayPending ? r.pending.splice(0) : (r.pending.length = 0, []);
    r.handler = handler;
    this.routes.set(k, r);
    for (const f of pending) handler(f);
  }

  async openTerm(p: TermOpenParams, onOutput: OutputHandler): Promise<TermOpened> {
    const s = this.session(p.sessionId);
    const profile = Profile[p.profile] ?? Profile.shell;
    const launch = p.launch
      ? { model: p.launch.model, permissionMode: p.launch.permissionMode, effort: p.launch.effort, resume: p.launch.resume, sessionName: p.launch.sessionName }
      : undefined;
    const termId = await s.openTerm({ profile, shellId: p.shellId ?? '', cwd: p.cwd ?? '', cols: Math.max(1, p.cols), rows: Math.max(1, p.rows), command: p.command ?? '', launch });
    const meta = s.termMeta.get(termId);
    // 终端刚打开时的输出可能已经到了路由，登记时一并交出
    this.register(p.sessionId, termId, onOutput, true);
    return { termId, title: meta?.title ?? '', shell: meta?.shell ?? '' };
  }

  async listTerms(sessionId: string) {
    return this.session(sessionId).listTerms();
  }

  async attachTerm(p: TermAttachParams, onOutput: OutputHandler): Promise<void> {
    const s = this.session(p.sessionId);
    // 先登记再附着：回放数据可能在 attach 返回前就到了
    this.register(p.sessionId, p.termId, onOutput, false);
    try {
      await s.attachTerm(p.termId, { cols: Math.max(1, p.cols), rows: Math.max(1, p.rows) }, p.lastSeq);
    } catch (e) {
      this.routes.delete(key(p.sessionId, p.termId));
      throw e;
    }
  }

  async termInput(sessionId: string, termId: string, data: Uint8Array): Promise<void> {
    await this.session(sessionId).termInput(termId, data);
  }

  async termSubmit(sessionId: string, termId: string, text: string, attachments: string[]): Promise<void> {
    await this.session(sessionId).termSubmit(termId, text, attachments.map(Number));
  }

  async termResize(sessionId: string, termId: string, cols: number, rows: number): Promise<void> {
    await this.session(sessionId).termResize(termId, { cols: Math.max(1, cols), rows: Math.max(1, rows) });
  }

  async termAck(sessionId: string, termId: string, consumed: number): Promise<void> {
    this.sessions.get(sessionId)?.termAck(termId, consumed);
  }

  async closeTerm(sessionId: string, termId: string): Promise<void> {
    await this.session(sessionId).closeTerm(termId);
    this.routes.delete(key(sessionId, termId));
  }

  async termAction(sessionId: string, termId: string, actionId: string, args: Record<string, string>) {
    return this.session(sessionId).termAction(termId, actionId, args);
  }

  async commandListReq(sessionId: string, termId: string): Promise<void> {
    await this.session(sessionId).commandListReq(termId);
  }

  // ———————————————————— 上传 ————————————————————

  /** 浏览器拿不到本地路径：选文件 / 拖放时给每个文件分配一个虚拟路径 web-file:<编号>/<文件名>，上传时凭它找回 File */
  private registerFile(f: File): string {
    const id = this.pickSeq++;
    this.picked.set(id, f);
    return `web-file:${id}/${f.name}`;
  }

  async uploadPath(sessionId: string, path: string): Promise<UploadStarted> {
    const m = /^web-file:(\d+)\//.exec(path);
    const f = m ? this.picked.get(Number(m[1])) : undefined;
    if (!f) throw new CodedError('BAD_REQUEST', '找不到要上传的文件，请重新选择');
    const r = await this.session(sessionId).upload({ name: f.name, mime: f.type, data: f });
    this.picked.delete(Number(m![1]));
    return { fileId: String(r.fileId), name: r.name, size: r.size };
  }

  async uploadBytes(p: UploadBytesParams): Promise<UploadStarted> {
    const r = await this.session(p.sessionId).upload({ name: p.name, mime: p.mime, data: p.data });
    return { fileId: String(r.fileId), name: r.name, size: r.size };
  }

  async cancelUpload(sessionId: string, fileId: string): Promise<void> {
    this.sessions.get(sessionId)?.cancelUpload(Number(fileId));
  }

  async readClipboardFiles(): Promise<string[]> {
    throw new CodedError('CLIPBOARD_UNAVAILABLE', '浏览器无法直接读取剪贴板里的文件');
  }

  // ———————————————————— 事件 / 系统能力 ————————————————————

  async onEvent(handler: (e: CoreEvent) => void): Promise<() => void> {
    this.listeners.add(handler);
    // 补一次当前的信令状态，界面启动后马上能显示在线
    queueMicrotask(() => handler({ type: 'signalState', online: this.signal.isOnline }));
    return () => this.listeners.delete(handler);
  }

  private installDragDrop(): void {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    const fire = (e: DragDropEvent): void => this.dragListeners.forEach((l) => l(e));
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth++ === 0) fire({ type: 'enter' });
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        fire({ type: 'leave' });
      }
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const files = [...(e.dataTransfer?.files ?? [])];
      fire({ type: 'drop', paths: files.map((f) => this.registerFile(f)) });
    });
  }

  async onDragDrop(handler: (e: DragDropEvent) => void): Promise<() => void> {
    this.dragListeners.add(handler);
    return () => this.dragListeners.delete(handler);
  }

  pickFiles(): Promise<string[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      const done = (): void => {
        input.remove();
      };
      input.onchange = () => {
        resolve([...(input.files ?? [])].map((f) => this.registerFile(f)));
        done();
      };
      input.oncancel = () => {
        resolve([]);
        done();
      };
      document.body.appendChild(input);
      input.click();
    });
  }

  async copyText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async notify(title: string, body: string): Promise<void> {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
    if (Notification.permission === 'granted') new Notification(title, { body });
  }

  async isAutostartEnabled(): Promise<boolean> {
    return false;
  }
  async setAutostart(): Promise<void> {}
  async checkUpdate(): Promise<null> {
    return null;
  }
  async installUpdate(): Promise<void> {}
}

export { toCommandError };
