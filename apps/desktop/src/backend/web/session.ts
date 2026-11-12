/**
 * 控制端会话（对应 Rust controller/session.rs + connect.rs + upload.rs）。
 *
 * 一台被控端一个会话：Ready →（链路意外断开）→ Reconnecting（退避重试，期间用户操作返回"尚未连接"）→
 * 重连成功后 TermList + 对每个已打开的终端 TermAttach{last_seq} → Ready；
 * 不可重试的错误（密码错误等）或用户断开 / 对方 Bye → Closed(原因)。
 *
 * 与 Rust 版的差别：JS 单线程，没有 actor 通道；链路关闭通过 Link.closed 通知，命令直接作为 async 方法。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ActionCatalog,
  ActionOutcome,
  AppNotice,
  AppState,
  CommandList,
  CoreEvent,
  HostInfo,
  TermInfo,
  TermModes,
} from '../types';
import { EstablishError, Link, type LinkCloseInfo, closeCodeText } from './relay';
import { SignalError } from './signal';
import type { Frame } from './proto';
import { TermTable, type TermSize } from './terms';
import { CodedError, backoff, deferred, sleep, timeoutAfter, type Deferred } from './util';

/** 本端声明的能力（与 Rust FEATURES 一致） */
export const FEATURES = ['file.upload', 'term.submit', 'app.actions', 'app.state', 'app.commands'];

export interface Timing {
  backoffBase: number;
  backoffMax: number;
  requestTimeout: number;
  helloTimeout: number;
  resyncTimeout: number;
  pingInterval: number;
  idleTimeout: number;
  sendTimeout: number;
  uploadStall: number;
  progressInterval: number;
}

export const DEFAULT_TIMING: Timing = {
  backoffBase: 1000,
  backoffMax: 15_000,
  requestTimeout: 15_000,
  helloTimeout: 10_000,
  resyncTimeout: 15_000,
  pingInterval: 5000,
  idleTimeout: 45_000,
  sendTimeout: 15_000,
  uploadStall: 60_000,
  progressInterval: 100,
};

const PENDING_TTL = 60_000;
const TERM_BUSY_TEXT = '该终端正被其他设备使用';
const UPLOAD_WINDOW = 1024 * 1024;
const UPLOAD_CHUNK = 32 * 1024;
const MAX_CONCURRENT_UPLOADS = 8;
/** 控制端分配的 file_id 从这里开始，避免与请求编号（req_id）重叠：被控端的 Error.ref_id 两者通用 */
const FILE_ID_BASE = 2 ** 32;

// ———————————————————— 连接尝试 ————————————————————

/** 一次连接尝试的外部控制：观察"已进入等待对方确认"，随时取消 */
export class ConnectCtl {
  cancelled = false;
  awaiting = false;
  onAwaiting: (() => void) | null = null;
  private canceller: (() => void) | null = null;

  cancel(): void {
    this.cancelled = true;
    this.canceller?.();
  }

  attach(cancel: () => void): void {
    this.canceller = cancel;
    if (this.cancelled) cancel();
  }

  setAwaiting(): void {
    if (this.awaiting) return;
    this.awaiting = true;
    this.onAwaiting?.();
  }
}

export interface ConnectSpec {
  hostCode: string;
  pwKey: Uint8Array;
  /** 0 临时密码 / 1 固定密码 */
  pwKind: number;
  knownHostKey: Uint8Array | null;
  acceptKeyChange: boolean;
  /** 首次连接时的取消 / 进度控制；重连尝试里为 undefined */
  ctl?: ConnectCtl;
}

export interface Connected {
  link: Link;
  peerPublicKey: Uint8Array;
}

/** 取得一条已加密的会话链路（生产用信令 + 中继握手；测试可替换） */
export interface Connector {
  connect(spec: ConnectSpec): Promise<Connected>;
}

export type ConnectErrorKind = 'signal' | 'establish' | 'hello_timeout' | 'hello_rejected' | 'link_lost';

export class ConnectError extends Error {
  constructor(
    readonly kind: ConnectErrorKind,
    message: string,
    readonly signal?: SignalError,
    readonly establish?: EstablishError,
  ) {
    super(message);
    this.name = 'ConnectError';
  }

  /** 自动重连是否值得继续：密码错误、被拒绝、被锁定、版本不兼容、封禁、公钥变化等不重试 */
  get retryable(): boolean {
    switch (this.kind) {
      case 'signal': {
        const e = this.signal!;
        switch (e.kind) {
          case 'connect': return ['UNAVAILABLE', 'RATE_LIMITED', 'NO_RELAY'].includes(e.code);
          case 'offline':
          case 'timeout':
          case 'closed':
          case 'server':
          case 'bad_response':
            return true;
          default: return false;
        }
      }
      case 'establish': return this.establish!.retryable;
      case 'hello_timeout':
      case 'link_lost': return true;
      default: return false;
    }
  }

  get isBadPassword(): boolean {
    return this.kind === 'establish' && this.establish!.kind === 'bad_password';
  }

  userText(): string {
    if (this.kind === 'signal') return this.signal!.userText();
    if (this.kind === 'establish') {
      if (this.establish!.kind === 'bad_password') return '密码错误';
      if (this.establish!.kind === 'peer_key_changed') return '对方设备的公钥发生了变化，请确认后再连接';
    }
    return this.message;
  }
}

/** 转成前端 CommandError 的 code */
export function connectErrorCode(e: ConnectError): string {
  if (e.kind === 'signal') {
    const s = e.signal!;
    if (s.kind === 'connect') return ['UNAVAILABLE', 'REJECTED', 'RATE_LIMITED', 'LOCKED', 'VERSION', 'BANNED', 'NO_RELAY'].includes(s.code) ? s.code : 'UNKNOWN';
    if (s.kind === 'cancelled') return 'CANCELLED';
    if (s.kind === 'offline' || s.kind === 'timeout' || s.kind === 'closed') return 'NETWORK';
    return 'UNKNOWN';
  }
  if (e.kind === 'establish') {
    switch (e.establish!.kind) {
      case 'bad_password': return 'PASSWORD_WRONG';
      case 'peer_key_changed': return 'PEER_KEY_CHANGED';
      case 'connect':
      case 'timeout':
      case 'relay_closed': return 'NETWORK';
      default: return 'UNKNOWN';
    }
  }
  return e.kind === 'hello_timeout' || e.kind === 'link_lost' ? 'NETWORK' : 'UNKNOWN';
}

export type CloseReason =
  | { kind: 'user' }
  | { kind: 'bad_password' }
  | { kind: 'peer_key_changed' }
  | { kind: 'refused'; text: string }
  | { kind: 'host_bye'; text: string }
  | { kind: 'cancelled' };

export function closeReasonText(r: CloseReason): string {
  switch (r.kind) {
    case 'user': return '用户断开';
    case 'bad_password': return '密码错误';
    case 'peer_key_changed': return '对方设备的公钥发生了变化';
    case 'refused': return r.text;
    case 'host_bye': return r.text ? `对方已断开（${r.text}）` : '对方已断开';
    case 'cancelled': return '已取消';
  }
}

export function closeReasonCode(r: CloseReason): string {
  switch (r.kind) {
    case 'user': return 'USER';
    case 'bad_password': return 'PASSWORD_WRONG';
    case 'peer_key_changed': return 'PEER_KEY_CHANGED';
    case 'refused': return 'REFUSED';
    case 'host_bye': return 'HOST_BYE';
    case 'cancelled': return 'CANCELLED';
  }
}

function closeReasonFromError(e: ConnectError): CloseReason {
  if (e.isBadPassword) return { kind: 'bad_password' };
  if (e.kind === 'establish' && e.establish!.kind === 'peer_key_changed') return { kind: 'peer_key_changed' };
  if (e.kind === 'signal' && e.signal!.kind === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'refused', text: e.userText() };
}

/** 一次完整的建立：连接器取链路 → 发 Hello → 等 HelloAck */
async function establishConn(connector: Connector, spec: ConnectSpec, timing: Timing, appVersion: string): Promise<{ link: Link; peerKey: Uint8Array; ack: Frame['helloAck'] }> {
  const { link, peerPublicKey } = await connector.connect(spec);
  const early: Frame[] = [];
  let onAck: ((f: Frame) => void) | null = null;
  link.onFrame = (f) => (onAck ? onAck(f) : early.push(f));
  try {
    await link.send(0, 'hello', { protoVer: 1, minProtoVer: 1, appVersion, features: FEATURES });
  } catch {
    link.abort();
    throw new ConnectError('link_lost', '连接在建立过程中断开');
  }
  const waitAck = new Promise<Frame['helloAck']>((resolve, reject) => {
    const handle = (f: Frame): void => {
      if (f.body === 'helloAck') resolve(f.helloAck);
      else if (f.body === 'error') reject(new ConnectError('hello_rejected', `被控端拒绝了会话: ${f.error.code}: ${f.error.message}`));
      else if (f.body === 'bye') reject(new ConnectError('hello_rejected', `被控端拒绝了会话: 对方断开: ${f.bye.reason}`));
      // HelloAck 之前的其它帧（例如 Pong）忽略
    };
    for (const f of early.splice(0)) handle(f);
    onAck = handle;
    void link.closed.promise.then(() => reject(new ConnectError('link_lost', '连接在建立过程中断开')));
  });
  try {
    const ack = await Promise.race([waitAck, timeoutAfter(timing.helloTimeout, () => new ConnectError('hello_timeout', '被控端没有响应握手后的问候'))]);
    if ((ack as { protoVer: number }).protoVer < 1) throw new ConnectError('hello_rejected', '协议版本不兼容');
    return { link, peerKey: peerPublicKey, ack };
  } catch (e) {
    link.abort();
    throw e;
  }
}

// ———————————————————— 会话 ————————————————————

export interface HostSnapshot {
  info: HostInfo;
  features: Set<string>;
  appVersion: string;
  protoVer: number;
}

export interface SessionHooks {
  emit(ev: CoreEvent): void;
  /** 终端输出（已按偏移去重） */
  onOutput(sessionId: string, term: string, seq: number, data: Uint8Array): void;
}

type Pending =
  | { kind: 'open'; size: TermSize; resolve: (id: string) => void; reject: (e: unknown) => void; at: number }
  | { kind: 'attach'; size: TermSize; resolve: (() => void) | null; reject: ((e: unknown) => void) | null; resync: boolean; term: string; at: number };

type ListWaiter = { kind: 'user'; resolve: (t: Frame['termListResp']['terms']) => void; reject: (e: unknown) => void } | { kind: 'resync' };

interface Conn {
  link: Link;
  peerKey: Uint8Array;
  lastRx: number;
  lastPing: number;
  dead: boolean;
  resync: { outstanding: Set<number>; listPending: boolean; deadline: number } | null;
}

interface UploadTask {
  fileId: number;
  accept: Deferred<void>;
  done: Deferred<string>;
  acked: number;
  error: string | null;
  cancelled: boolean;
  /** 收到任何消息（确认、错误、取消）时唤醒等待窗口的循环 */
  wake: Deferred<void> | null;
}

export interface UploadSourceBytes {
  name: string;
  mime: string;
  data: Blob | Uint8Array;
}

export class Session {
  phase: 'connecting' | 'awaitingApproval' | 'ready' | 'reconnecting' | 'closed' = 'connecting';
  host: HostSnapshot | null = null;
  rttMs: number | null = null;
  peerKey: Uint8Array = new Uint8Array(0);
  closeReason: CloseReason | null = null;
  readonly termMeta = new Map<string, { title: string; shell: string }>();

  private conn: Conn | null = null;
  private terms = new TermTable();
  private nextReq = 1;
  private nextMsg = 1;
  private nextFile = FILE_ID_BASE;
  private pending = new Map<number, Pending>();
  private listWaiters: ListWaiter[] = [];
  private actions = new Map<number, { resolve: (o: ActionOutcome) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private uploads = new Map<number, UploadTask>();
  private doneFiles = new Set<number>();
  private hostFeatures = new Set<string>();
  private pendingCloses: string[] = [];
  private ackBoard = new Map<string, number>();
  private ackScheduled = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private wake: Deferred<void> | null = null;

  private constructor(
    readonly id: string,
    private connector: Connector,
    private spec: ConnectSpec,
    private timing: Timing,
    private appVersion: string,
    private hooks: SessionHooks,
  ) {}

  /**
   * 连接被控端并完成 Hello/HelloAck。成功时会话已处于 Ready；失败抛 ConnectError（首次连接不自动重试，由界面决定）。
   * 连上之后的断线才会自动重连。
   */
  static async connect(
    id: string,
    connector: Connector,
    spec: ConnectSpec,
    hooks: SessionHooks,
    appVersion: string,
    timing: Timing = DEFAULT_TIMING,
  ): Promise<Session> {
    const s = new Session(id, connector, spec, timing, appVersion, hooks);
    let est;
    try {
      est = await establishConn(connector, spec, timing, appVersion);
    } catch (e) {
      const ce = e instanceof ConnectError ? e : toConnectError(e);
      s.closeReason = closeReasonFromError(ce);
      s.phase = 'closed';
      hooks.emit({ type: 'sessionState', sessionId: id, state: 'closed', reason: closeReasonText(s.closeReason), reasonCode: closeReasonCode(s.closeReason) });
      throw ce;
    }
    s.spec = { ...spec, ctl: undefined };
    s.attach(est.link, est.peerKey);
    s.beginConnection(est.ack, false);
    s.tickTimer = setInterval(() => s.tick(), Math.max(20, Math.min(1000, timing.pingInterval / 3)));
    return s;
  }

  // ———————————————————— 状态与事件 ————————————————————

  private emit(ev: CoreEvent): void {
    this.hooks.emit(ev);
  }

  private setPhase(p: Session['phase'], extra: { attempt?: number; retryInMs?: number } = {}): void {
    if (this.phase === p && p !== 'reconnecting') return;
    this.phase = p;
    if (p === 'closed') return;
    this.emit({ type: 'sessionState', sessionId: this.id, state: p, ...extra });
  }

  private noticeError(term: string, code: string, message: string): void {
    this.emit({
      type: 'appNotice',
      sessionId: this.id,
      termId: term,
      notice: { kind: 'error', title: code, text: message, noticeId: '0', toolName: '', toolSummary: '', resolved: false, truncated: false },
    });
  }

  get state(): Session['phase'] {
    return this.phase;
  }

  get features(): string[] {
    return [...this.hostFeatures];
  }

  // ———————————————————— 链路 ————————————————————

  private attach(link: Link, peerKey: Uint8Array): void {
    const now = Date.now();
    const conn: Conn = { link, peerKey, lastRx: now, lastPing: now, dead: false, resync: null };
    this.conn = conn;
    this.peerKey = peerKey;
    link.onFrame = (f) => {
      conn.lastRx = Date.now();
      this.onFrame(conn, f);
    };
    void link.closed.promise.then((info) => this.onLinkClosed(conn, info));
  }

  private async send(conn: Conn, channel: number, branch: string, value: object, bulk = false): Promise<void> {
    if (conn.dead || conn.link.isClosed) throw new CodedError('NOT_READY', '尚未连接（重连中）');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        conn.link.send(channel, branch, value, bulk),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('send timeout')), this.timing.sendTimeout);
        }),
      ]);
    } catch {
      conn.dead = true;
      conn.link.abort('发送失败');
      throw new CodedError('NOT_READY', '尚未连接（重连中）');
    } finally {
      clearTimeout(timer);
    }
  }

  private onLinkClosed(conn: Conn, info: LinkCloseInfo): void {
    if (this.conn !== conn || this.closing) return;
    const why = info.code !== null && info.code >= 4000 ? closeCodeText(info.code) : info.reason || '连接已断开';
    this.conn = null;
    this.onLost();
    this.setPhase('reconnecting');
    void this.reconnectLoop(why);
  }

  /** 链路断开后的清理：待回复的请求失败，上传任务得知连接中断，通道号作废 */
  private onLost(): void {
    const err = new CodedError('NOT_READY', '尚未连接（重连中）');
    for (const p of this.pending.values()) {
      if (p.kind === 'open') p.reject(err);
      else p.reject?.(err);
    }
    this.pending.clear();
    for (const w of this.listWaiters) if (w.kind === 'user') w.reject(err);
    this.listWaiters = [];
    for (const a of this.actions.values()) {
      clearTimeout(a.timer);
      a.reject(err);
    }
    this.actions.clear();
    for (const u of this.uploads.values()) u.wake?.resolve();
    this.uploads.clear();
    this.doneFiles.clear();
    this.terms.dropChannels();
  }

  private tick(): void {
    const conn = this.conn;
    if (!conn || this.closing) return;
    const now = Date.now();
    if (now - conn.lastRx > this.timing.idleTimeout) {
      conn.link.abort('连接超时（长时间没有收到数据）');
      return;
    }
    if (now - conn.lastPing >= this.timing.pingInterval) {
      conn.lastPing = now;
      void this.send(conn, 0, 'ping', { ts: now }).catch(() => {});
    }
    for (const [k, p] of this.pending) if (now - p.at >= PENDING_TTL) this.pending.delete(k);
    if (conn.resync && now >= conn.resync.deadline) {
      void this.finishResync(conn);
    }
  }

  // ———————————————————— 建立 / 重连 ————————————————————

  /** 一条新连接（Hello 已完成）接入会话：记录被控端能力，发 HostInfo；重连时开始恢复终端，否则直接 Ready */
  private beginConnection(ack: Frame['helloAck'], resume: boolean): void {
    const conn = this.conn!;
    const h = ack.host ?? {};
    const info: HostInfo = {
      platform: h.platform ?? '',
      arch: h.arch ?? '',
      hostname: h.hostname ?? '',
      username: h.username ?? '',
      homeDir: h.homeDir ?? '',
      shells: (h.shells ?? []).map((s: { id: string; name: string; path: string; isDefault: boolean }) => ({ id: s.id, name: s.name, path: s.path, isDefault: s.isDefault })),
      claudeAvailable: !!h.claudeAvailable,
      claudeVersion: h.claudeVersion ?? '',
      maxFileSize: h.maxFileSize ?? 0,
    };
    this.hostFeatures = new Set<string>(ack.features ?? []);
    this.host = { info, features: this.hostFeatures, appVersion: ack.appVersion ?? '', protoVer: ack.protoVer ?? 1 };
    // 之后的重连以首次认证的公钥为准，公钥变化会被拒绝
    this.spec = { ...this.spec, knownHostKey: conn.peerKey, acceptKeyChange: false };
    this.emit({ type: 'hostInfo', sessionId: this.id, info, features: [...this.hostFeatures] });
    this.doneFiles.clear();

    for (const t of this.pendingCloses.splice(0)) void this.send(conn, 0, 'termClose', { termId: t, kill: true }).catch(() => {});

    if (resume && this.terms.resumable().length > 0) {
      conn.resync = { outstanding: new Set(), listPending: true, deadline: Date.now() + this.timing.resyncTimeout };
      this.listWaiters.push({ kind: 'resync' });
      void this.send(conn, 0, 'termList', {}).catch(() => {});
    } else {
      this.setPhase('ready');
    }
  }

  /** 退避重连。不可恢复的原因会让会话关闭 */
  private async reconnectLoop(_firstWhy: string): Promise<void> {
    let attempt = 0;
    while (!this.closing) {
      const delay = backoff(this.timing.backoffBase, this.timing.backoffMax, attempt);
      this.setPhase('reconnecting', { attempt: attempt + 1, retryInMs: delay });
      this.wake = deferred<void>();
      await Promise.race([sleep(delay), this.wake.promise]);
      this.wake = null;
      if (this.closing) return;
      try {
        const est = await establishConn(this.connector, this.spec, this.timing, this.appVersion);
        if (this.closing) {
          est.link.abort();
          return;
        }
        this.attach(est.link, est.peerKey);
        this.beginConnection(est.ack, true);
        return;
      } catch (e) {
        const ce = e instanceof ConnectError ? e : toConnectError(e);
        if (!ce.retryable) {
          this.finishClose(closeReasonFromError(ce));
          return;
        }
        attempt += 1;
      }
    }
  }

  /** 网络恢复 / 页面重新可见：重连退避中则立即重试 */
  reconnectNow(): void {
    this.wake?.resolve();
  }

  private finishClose(reason: CloseReason): void {
    if (this.phase === 'closed') return;
    this.closing = true;
    this.closeReason = reason;
    this.phase = 'closed';
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    const c = this.conn;
    this.conn = null;
    this.onLost();
    this.wake?.resolve();
    c?.link.abort('会话结束');
    this.emit({ type: 'sessionState', sessionId: this.id, state: 'closed', reason: closeReasonText(reason), reasonCode: closeReasonCode(reason) });
  }

  /** 主动断开：先发 Bye（最多等 2 秒），然后关闭 */
  async disconnect(): Promise<void> {
    if (this.phase === 'closed') return;
    const c = this.conn;
    if (c && !c.dead) {
      await Promise.race([this.send(c, 0, 'bye', { reason: 'user' }), sleep(2000)]).catch(() => {});
    }
    this.finishClose({ kind: 'user' });
  }

  // ———————————————————— 命令 ————————————————————

  private ready(): Conn {
    if (this.phase === 'closed') throw new CodedError('CLOSED', '会话已关闭');
    if (this.phase !== 'ready' || !this.conn) throw new CodedError('NOT_READY', '尚未连接（重连中）');
    return this.conn;
  }

  private allocReq(): number {
    return this.nextReq++;
  }

  private withTimeout<T>(p: Promise<T>, ms = this.timing.requestTimeout): Promise<T> {
    return Promise.race([p, timeoutAfter(ms, () => new CodedError('TIMEOUT', '请求超时'))]);
  }

  async openTerm(o: { profile: number; shellId: string; cwd: string; cols: number; rows: number; command: string; launch?: object }): Promise<string> {
    const conn = this.ready();
    const req = this.allocReq();
    const size = { cols: o.cols, rows: o.rows };
    const p = new Promise<string>((resolve, reject) => {
      this.pending.set(req, { kind: 'open', size, resolve, reject, at: Date.now() });
    });
    p.catch(() => {});
    try {
      await this.send(conn, 0, 'termOpen', { reqId: req, profile: o.profile, shellId: o.shellId, cwd: o.cwd, cols: o.cols, rows: o.rows, command: o.command, launch: o.launch });
    } catch (e) {
      this.pending.delete(req);
      throw e;
    }
    try {
      return await this.withTimeout(p);
    } catch (e) {
      this.pending.delete(req);
      throw e;
    }
  }

  async listTerms(): Promise<TermInfo[]> {
    const conn = this.ready();
    const p = new Promise<Frame['termListResp']['terms']>((resolve, reject) => this.listWaiters.push({ kind: 'user', resolve, reject }));
    p.catch(() => {});
    await this.send(conn, 0, 'termList', {});
    const terms = await this.withTimeout(p);
    return terms.map((t: { termId: string; title: string; profile: number; attachedByOther: boolean }) => ({
      termId: t.termId,
      title: t.title,
      profile: (['shell', 'claude', 'custom'] as const)[t.profile] ?? 'shell',
      shell: this.termMeta.get(t.termId)?.shell ?? '',
      attachedByOther: t.attachedByOther,
    }));
  }

  async attachTerm(term: string, size: TermSize, fromSeq: number | null): Promise<void> {
    const conn = this.ready();
    const req = this.allocReq();
    // 界面给的偏移比已交付的小（界面重建过）：回退到那里重新交付；比已交付的大则不理会
    const e = this.terms.get(term);
    if (fromSeq !== null && e && fromSeq < e.received) {
      e.received = fromSeq;
      e.rendered = Math.min(e.rendered, fromSeq);
    }
    const lastSeq = e ? e.received : (fromSeq ?? 0);
    const p = new Promise<void>((resolve, reject) => this.pending.set(req, { kind: 'attach', size, resolve, reject, resync: false, term, at: Date.now() }));
    p.catch(() => {});
    try {
      await this.send(conn, 0, 'termAttach', { reqId: req, termId: term, lastSeq, cols: size.cols, rows: size.rows });
    } catch (err) {
      this.pending.delete(req);
      throw err;
    }
    try {
      await this.withTimeout(p);
    } catch (err) {
      this.pending.delete(req);
      throw err;
    }
  }

  private attachedChannel(term: string): number {
    const e = this.terms.get(term);
    if (!e) throw new CodedError('TERM_NOT_FOUND', `终端不存在：${term}`);
    if (e.channel === null) throw new CodedError('TERM_NOT_FOUND', `终端不存在：${term}`);
    return e.channel;
  }

  async termInput(term: string, data: Uint8Array): Promise<void> {
    const conn = this.ready();
    await this.send(conn, this.attachedChannel(term), 'termInput', { data });
  }

  async termSubmit(term: string, text: string, attachments: number[]): Promise<number> {
    const conn = this.ready();
    const ch = this.attachedChannel(term);
    const missing = attachments.find((f) => !this.doneFiles.has(f));
    if (missing !== undefined) throw new CodedError('BAD_REQUEST', `附件 ${missing} 尚未上传完成`);
    const msgId = this.nextMsg++;
    await this.send(conn, ch, 'termSubmit', { msgId, text, attachments, pressEnter: true });
    return msgId;
  }

  async termResize(term: string, size: TermSize): Promise<void> {
    const e = this.terms.get(term);
    if (!e) throw new CodedError('TERM_NOT_FOUND', `终端不存在：${term}`);
    e.size = size;
    if (e.channel === null || !this.conn || this.phase !== 'ready') return; // 离线只记录尺寸，重连后附着时带上
    await this.send(this.conn, e.channel, 'termResize', { cols: size.cols, rows: size.rows });
  }

  async closeTerm(term: string): Promise<void> {
    this.terms.remove(term);
    this.termMeta.delete(term);
    if (!this.conn || this.phase !== 'ready') {
      this.pendingCloses.push(term);
      return;
    }
    await this.send(this.conn, 0, 'termClose', { termId: term, kill: true });
  }

  /** 执行动作目录里的动作，等待被控端的结果（最多 20 秒） */
  async termAction(term: string, actionId: string, args: Record<string, string>): Promise<ActionOutcome> {
    const conn = this.ready();
    const ch = this.attachedChannel(term);
    const req = this.allocReq();
    const p = new Promise<ActionOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.actions.delete(req);
        reject(new CodedError('TIMEOUT', '被控端没有响应'));
      }, 20_000);
      this.actions.set(req, { resolve, reject, timer });
    });
    p.catch(() => {});
    try {
      await this.send(conn, ch, 'termAction', { reqId: req, actionId, args });
    } catch (e) {
      const a = this.actions.get(req);
      if (a) clearTimeout(a.timer);
      this.actions.delete(req);
      throw e;
    }
    return p;
  }

  async commandListReq(term: string): Promise<void> {
    const conn = this.ready();
    await this.send(conn, this.attachedChannel(term), 'commandListReq', {});
  }

  /** 界面确认已渲染到 consumed（同步调用，节流由调用方做）：只记最大值，随后批量发送 TermAck */
  termAck(term: string, consumed: number): void {
    const cur = this.ackBoard.get(term) ?? 0;
    if (consumed > cur) this.ackBoard.set(term, consumed);
    if (!this.ackScheduled) {
      this.ackScheduled = true;
      queueMicrotask(() => {
        this.ackScheduled = false;
        this.flushAcks();
      });
    }
  }

  private flushAcks(): void {
    const board = [...this.ackBoard];
    this.ackBoard.clear();
    for (const [term, consumed] of board) {
      const r = this.terms.noteRendered(term, consumed);
      if (r && this.conn && !this.conn.dead) void this.send(this.conn, r.channel, 'termAck', { consumed: r.offset }).catch(() => {});
    }
  }

  // ———————————————————— 收到的帧 ————————————————————

  private onFrame(conn: Conn, f: Frame): void {
    const ch = f.channel;
    switch (f.body) {
      case 'ping':
        void this.send(conn, 0, 'pong', { ts: f.ping.ts }).catch(() => {});
        return;
      case 'pong': {
        const now = Date.now();
        if (f.pong.ts > 0 && now >= f.pong.ts) {
          this.rttMs = now - f.pong.ts;
          this.emit({ type: 'latency', sessionId: this.id, ms: this.rttMs });
        }
        return;
      }
      case 'bye':
        this.finishClose({ kind: 'host_bye', text: f.bye.reason });
        return;
      case 'actionCatalog':
        this.emit({ type: 'actionCatalog', sessionId: this.id, catalog: toCatalog(f.actionCatalog) });
        return;
      case 'termOpened':
        this.onTermOpened(conn, f.termOpened);
        return;
      case 'termListResp':
        this.onTermList(conn, f.termListResp);
        return;
      case 'error':
        this.onError(conn, ch, f.error);
        return;
      case 'fileAccept':
        this.uploads.get(f.fileAccept.fileId)?.accept.resolve();
        return;
      case 'fileAck': {
        const u = this.uploads.get(f.fileAck.fileId);
        if (u) {
          u.acked = Math.max(u.acked, f.fileAck.received);
          u.wake?.resolve();
        }
        return;
      }
      case 'fileDone': {
        // 先登记再转给上传任务：界面收到 uploadDone 后马上 term_submit 时附件已就绪
        this.doneFiles.add(f.fileDone.fileId);
        this.uploads.get(f.fileDone.fileId)?.done.resolve(f.fileDone.remotePath);
        return;
      }
      case 'termOutput': {
        const r = this.terms.onOutput(ch, f.termOutput.seq, f.termOutput.data);
        if (r) this.hooks.onOutput(this.id, r.term, r.seq, r.data);
        return;
      }
      case 'termState': {
        const term = this.terms.idOfChannel(ch);
        if (term) {
          const s = f.termState;
          const state: TermModes = { bracketedPaste: s.bracketedPaste, altScreen: s.altScreen, appCursor: s.appCursor, mouse: s.mouse, title: s.title };
          this.emit({ type: 'termState', sessionId: this.id, termId: term, state });
        }
        return;
      }
      case 'termExit': {
        const term = this.terms.idOfChannel(ch);
        if (term) {
          const e = this.terms.get(term);
          if (e) e.exited = true;
          this.emit({ type: 'termExit', sessionId: this.id, termId: term, code: f.termExit.code });
        }
        return;
      }
      case 'appState': {
        const term = this.terms.idOfChannel(ch);
        if (term) this.emit({ type: 'appState', sessionId: this.id, termId: term, state: toAppState(f.appState) });
        return;
      }
      case 'appNotice': {
        const term = this.terms.idOfChannel(ch);
        if (term) this.emit({ type: 'appNotice', sessionId: this.id, termId: term, notice: toNotice(f.appNotice) });
        return;
      }
      case 'termActionResult': {
        const r = f.termActionResult;
        const a = this.actions.get(r.reqId);
        if (!a) return;
        this.actions.delete(r.reqId);
        clearTimeout(a.timer);
        if (r.ok) a.resolve({ passthrough: !!r.passthrough, returnKeys: r.returnKeys ?? [] });
        else a.reject(actionError(String(r.error ?? '')));
        return;
      }
      case 'commandList': {
        const term = this.terms.idOfChannel(ch);
        if (term) {
          const list: CommandList = {
            commands: (f.commandList.commands ?? []).map((c: { name: string; description: string; argumentHint: string; source: string }) => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint,
              source: c.source,
            })),
          };
          this.emit({ type: 'commandList', sessionId: this.id, termId: term, list });
        }
        return;
      }
      default:
        // HelloAck 重复、未知分支等：忽略
        return;
    }
  }

  private onTermOpened(conn: Conn, o: Frame['termOpened']): void {
    const p = this.pending.get(o.reqId);
    if (!p) return;
    this.pending.delete(o.reqId);
    if (p.kind === 'open') {
      this.terms.onAttached(o.termId, o.channel, p.size);
      this.termMeta.set(o.termId, { title: o.title, shell: o.shell });
      p.resolve(o.termId);
    } else {
      this.terms.onAttached(o.termId, o.channel, p.size);
      p.resolve?.();
      if (p.resync) {
        // 触发远端程序按当前尺寸重绘
        void this.send(conn, o.channel, 'termResize', { cols: p.size.cols, rows: p.size.rows }).catch(() => {});
        conn.resync?.outstanding.delete(o.reqId);
        void this.maybeFinishResync(conn);
      }
    }
  }

  private onTermList(conn: Conn, r: Frame['termListResp']): void {
    const waiters = this.listWaiters.splice(0);
    for (const w of waiters) {
      if (w.kind === 'user') w.resolve(r.terms);
      else void this.doResync(conn, r.terms);
    }
  }

  /** 重连后的恢复：对仍然存在的终端发 TermAttach{last_seq}，已经不存在的通知界面 */
  private async doResync(conn: Conn, listed: Array<{ termId: string }>): Promise<void> {
    const alive = new Set(listed.map((t) => t.termId));
    for (const t of this.terms.resumable()) {
      if (!alive.has(t.id)) {
        this.termVanished(t.id);
        continue;
      }
      const req = this.allocReq();
      this.pending.set(req, { kind: 'attach', size: t.size, resolve: null, reject: null, resync: true, term: t.id, at: Date.now() });
      conn.resync?.outstanding.add(req);
      try {
        await this.send(conn, 0, 'termAttach', { reqId: req, termId: t.id, lastSeq: t.lastSeq, cols: t.size.cols, rows: t.size.rows });
      } catch {
        return;
      }
    }
    if (conn.resync) conn.resync.listPending = false;
    await this.maybeFinishResync(conn);
  }

  /** 被控端上已经没有这个终端（被控端重启或终端被清理） */
  private termVanished(term: string): void {
    this.terms.remove(term);
    this.emit({ type: 'termExit', sessionId: this.id, termId: term, code: -1 });
    this.noticeError(term, 'TERM_NOT_FOUND', '终端已不存在（被控端可能已重启或已清理）');
  }

  private async maybeFinishResync(conn: Conn): Promise<void> {
    if (conn.resync && !conn.resync.listPending && conn.resync.outstanding.size === 0) await this.finishResync(conn);
  }

  private async finishResync(conn: Conn): Promise<void> {
    conn.resync = null;
    this.setPhase('ready');
  }

  private onError(conn: Conn, ch: number, e: { code: string; message: string; refId: number }): void {
    if (ch !== 0) {
      // 终端通道上的错误：TERM_DETACHED 表示被另一个会话接管
      const term = this.terms.idOfChannel(ch);
      if (!term) return;
      if (e.code === 'TERM_DETACHED') {
        this.terms.markTaken(term);
        this.noticeError(term, e.code, '该终端已在别处打开');
      } else {
        this.noticeError(term, e.code, e.message);
      }
      return;
    }
    if (e.refId !== 0) {
      const p = this.pending.get(e.refId);
      if (p) {
        this.pending.delete(e.refId);
        const err = new CodedError(e.code, e.message);
        if (p.kind === 'attach' && p.resync) {
          conn.resync?.outstanding.delete(e.refId);
          if (e.code === 'TERM_NOT_FOUND') this.termVanished(p.term);
          else if (e.code === 'TERM_BUSY') {
            // 被其他设备占用：不抢占、不重试，标记为被占用，不阻塞会话 Ready
            this.terms.markBusy(p.term);
            this.noticeError(p.term, 'TERM_BUSY', TERM_BUSY_TEXT);
          } else this.noticeError(p.term, e.code, e.message);
          void this.maybeFinishResync(conn);
        } else if (p.kind === 'attach' && e.code === 'TERM_BUSY') {
          this.terms.markBusy(p.term);
          p.reject?.(err);
          this.noticeError(p.term, 'TERM_BUSY', TERM_BUSY_TEXT);
        } else if (p.kind === 'open') p.reject(err);
        else p.reject?.(err);
        return;
      }
      const u = this.uploads.get(e.refId);
      if (u) {
        u.error = `被控端拒绝: ${e.code}: ${e.message}`;
        u.wake?.resolve();
        u.accept.reject(new Error(u.error));
        return;
      }
    }
  }

  // ———————————————————— 上传 ————————————————————

  /** 开始上传，返回 fileId；进度、完成、失败以 uploadProgress/uploadDone/uploadFailed 事件送回 */
  async upload(src: UploadSourceBytes): Promise<{ fileId: number; name: string; size: number }> {
    const conn = this.ready();
    if (!this.hostFeatures.has('file.upload')) throw new CodedError('FILE_DISABLED', '被控端不支持或已关闭文件接收');
    const size = src.data instanceof Blob ? src.data.size : src.data.byteLength;
    const max = this.host?.info.maxFileSize ?? 0;
    if (max > 0 && size > max) throw new CodedError('FILE_TOO_LARGE', `文件过大（${size} 字节，被控端上限 ${max} 字节）`);
    if (this.uploads.size >= MAX_CONCURRENT_UPLOADS) throw new CodedError('RATE_LIMITED', '同时上传的文件过多');
    const name = src.name.trim() === '' ? 'file' : src.name;
    const mime = src.mime.trim() === '' ? 'application/octet-stream' : src.mime;
    const fileId = this.nextFile++;
    const task: UploadTask = { fileId, accept: deferred<void>(), done: deferred<string>(), acked: 0, error: null, cancelled: false, wake: null };
    task.accept.promise.catch(() => {});
    task.done.promise.catch(() => {});
    this.uploads.set(fileId, task);
    void this.runUpload(conn, task, { ...src, name, mime }, size);
    return { fileId, name, size };
  }

  cancelUpload(fileId: number): void {
    const u = this.uploads.get(fileId);
    if (!u) return;
    u.cancelled = true;
    u.wake?.resolve();
    u.accept.reject(new Error('已取消'));
  }

  private async runUpload(conn: Conn, u: UploadTask, src: UploadSourceBytes, size: number): Promise<void> {
    const emitFail = (reason: string): void => this.emit({ type: 'uploadFailed', sessionId: this.id, fileId: String(u.fileId), reason });
    let lastProgress = 0;
    let lastSent = -1;
    const progress = (sent: number, force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastProgress < this.timing.progressInterval) return;
      if (sent === lastSent) return;
      lastProgress = now;
      lastSent = sent;
      this.emit({ type: 'uploadProgress', sessionId: this.id, fileId: String(u.fileId), sent, total: size });
    };
    const check = (): void => {
      if (u.cancelled) throw new UploadError('已取消', 'cancel');
      if (u.error) throw new UploadError(u.error, 'remote');
      if (!this.uploads.has(u.fileId)) throw new UploadError('连接中断，上传失败', 'lost');
    };
    const stall = (what: string): Promise<never> => timeoutAfter(this.timing.uploadStall, () => new UploadError(`被控端无响应（${what}）`, 'stalled'));

    try {
      await this.send(conn, 0, 'fileBegin', { fileId: u.fileId, name: src.name, size, mime: src.mime });
      try {
        await Promise.race([u.accept.promise, stall('等待接受')]);
      } catch (e) {
        if (e instanceof UploadError) throw e;
        check();
        throw new UploadError('连接中断，上传失败', 'lost');
      }
      check();

      const hasher = sha256.create();
      let sent = 0;
      while (sent < size) {
        // 发送窗口：已发送且未被 FileAck 确认的字节达到窗口就暂停
        while (sent - u.acked >= UPLOAD_WINDOW) {
          u.wake = deferred<void>();
          await Promise.race([u.wake.promise, stall('等待确认')]);
          u.wake = null;
          check();
        }
        check();
        const want = Math.min(UPLOAD_CHUNK, size - sent);
        const chunk = new Uint8Array(await (src.data instanceof Blob ? src.data.slice(sent, sent + want).arrayBuffer() : Promise.resolve(src.data.slice(sent, sent + want).buffer)));
        if (chunk.length === 0) throw new UploadError('读取文件失败: 文件在上传期间被截断', 'io');
        hasher.update(chunk);
        await this.send(conn, 0, 'fileChunk', { fileId: u.fileId, offset: sent, data: chunk }, true);
        check();
        sent += chunk.length;
        progress(sent, false);
      }
      progress(size, true);
      // FileEnd 必须和数据块走同一个（批量）队列：交互队列优先，走交互队列会让它超过还没发出的数据块
      await this.send(conn, 0, 'fileEnd', { fileId: u.fileId, sha256: hasher.digest() }, true);
      const remotePath = await Promise.race([u.done.promise, stall('等待校验结果'), waitFail(u)]);
      this.emit({ type: 'uploadDone', sessionId: this.id, fileId: String(u.fileId), remotePath });
    } catch (e) {
      const err = e instanceof UploadError ? e : new UploadError(e instanceof Error ? e.message : '上传失败', 'lost');
      if (err.kind === 'cancel' || err.kind === 'io' || err.kind === 'stalled') {
        void this.send(conn, 0, 'fileCancel', { fileId: u.fileId, reason: err.message }).catch(() => {});
      }
      emitFail(err.kind === 'lost' ? '连接中断，上传失败' : err.message);
    } finally {
      this.uploads.delete(u.fileId);
    }
  }
}

class UploadError extends Error {
  constructor(
    message: string,
    readonly kind: 'cancel' | 'remote' | 'lost' | 'io' | 'stalled',
  ) {
    super(message);
  }
}

/** 等到上传被取消 / 被控端报错 / 连接中断：用于 FileEnd 之后等 FileDone 时同时响应这些情况 */
function waitFail(u: UploadTask): Promise<never> {
  return new Promise((_, reject) => {
    const poll = setInterval(() => {
      if (u.cancelled) reject(new UploadError('已取消', 'cancel'));
      else if (u.error) reject(new UploadError(u.error, 'remote'));
    }, 200);
    void u.done.promise.finally(() => clearInterval(poll));
  });
}

// ———————————————————— 转换 ————————————————————

function toConnectError(e: unknown): ConnectError {
  if (e instanceof ConnectError) return e;
  if (e instanceof SignalError) return new ConnectError('signal', e.userText(), e);
  if (e instanceof EstablishError) return new ConnectError('establish', e.message, undefined, e);
  return new ConnectError('link_lost', e instanceof Error ? e.message : String(e));
}
export { toConnectError };

function actionError(error: string): CodedError {
  const i = error.indexOf(':');
  let code = (i >= 0 ? error.slice(0, i) : error).trim() || 'UNKNOWN';
  const msg = i >= 0 ? error.slice(i + 1).trim() : '';
  if (!/^[A-Z_]+$/.test(code)) code = 'UNKNOWN';
  const message =
    msg ||
    (code === 'UNSUPPORTED' ? '当前 Claude Code 版本不支持该操作'
      : code === 'APP_NOT_RUNNING' ? '终端里没有运行 Claude Code'
      : code === 'BUSY' ? 'Claude Code 正忙，请稍后再试'
      : code === 'TERM_NOT_FOUND' ? '终端不存在'
      : error);
  return new CodedError(code, message);
}

function toAppState(s: Frame['appState']): AppState {
  return {
    app: s.app, running: s.running, stateful: s.stateful, version: s.version,
    activity: (s.activity || 'idle') as AppState['activity'],
    model: s.model, modelId: s.modelId, effort: s.effort, fastMode: s.fastMode, thinking: s.thinking,
    contextUsedPct: s.contextUsedPct, hasContext: s.hasContext, cwd: s.cwd, sessionId: s.sessionId, sessionName: s.sessionName, costUsd: s.costUsd,
  };
}

function toNotice(n: Frame['appNotice']): AppNotice {
  return {
    kind: n.kind as AppNotice['kind'], title: n.title, text: n.text, noticeId: String(n.noticeId),
    toolName: n.toolName, toolSummary: n.toolSummary, resolved: n.resolved, truncated: n.truncated,
  };
}

function toCatalog(c: Frame['actionCatalog']): ActionCatalog {
  const options: ActionCatalog['options'] = {};
  for (const [k, v] of Object.entries((c.options ?? {}) as Record<string, { items: Array<{ value: string; label: string }> }>)) {
    options[k] = (v.items ?? []).map((o) => ({ value: o.value, label: o.label }));
  }
  return {
    catalogVer: c.catalogVer,
    app: c.app,
    actions: (c.actions ?? []).map((a: Record<string, never>) => ({
      id: a.id, title: a.title, group: a.group, placement: a.placement, kind: a.kind,
      params: ((a.params ?? []) as Array<Record<string, unknown>>).map((p) => ({
        name: p.name as string, label: p.label as string, type: p.type as 'enum' | 'text' | 'path', optionsRef: p.optionsRef as string,
        allowCustom: p.allowCustom as boolean, required: p.required as boolean, defaultValue: p.defaultValue as string,
      })),
      confirm: a.confirm, note: a.note, enabledWhen: a.enabledWhen,
    })) as ActionCatalog['actions'],
    options,
  };
}
