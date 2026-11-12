/**
 * 信令客户端（浏览器 WebSocket）。协议见 server/tools/rterm-client.ts 顶部注释：
 * hello → auth（Ed25519 签名 "rterm-auth-v1\n<nonce>\n<device_id>"）→ auth.ok；之后心跳、connect.request 等。
 * Web 端只做主控端：认证时带 accept:false，别人连不到这台“设备”。
 */
import { signMessage } from './crypto';
import { APP_VERSION, type Identity } from './identity';
import { b64encode, backoff, deferred, sleep, type Deferred } from './util';

const enc = new TextEncoder();

export type SignalErrorKind = 'connect' | 'offline' | 'timeout' | 'closed' | 'cancelled' | 'server' | 'bad_response';

export class SignalError extends Error {
  constructor(
    readonly kind: SignalErrorKind,
    /** kind = connect 时是 connect.err 的错误码（UNAVAILABLE 等） */
    readonly code: string = '',
  ) {
    super(`${kind}${code ? `:${code}` : ''}`);
    this.name = 'SignalError';
  }

  /** 给界面看的文字（与 Rust SignalError::user_text 一致） */
  userText(): string {
    if (this.kind === 'connect') {
      switch (this.code) {
        case 'UNAVAILABLE': return '设备不在线或设备码有误';
        case 'REJECTED': return '对方拒绝了连接';
        case 'RATE_LIMITED': return '操作太频繁，请稍后再试';
        case 'LOCKED': return '对方设备已临时锁定';
        case 'VERSION': return '请升级客户端';
        case 'BANNED': return '本设备已被封禁';
        case 'NO_RELAY': return '服务繁忙，请稍后再试';
        default: return `连接失败（${this.code}）`;
      }
    }
    switch (this.kind) {
      case 'offline': return '未连接到服务器';
      case 'timeout': return '服务器无响应';
      case 'cancelled': return '已取消';
      case 'closed': return '与服务器的连接已断开';
      default: return '服务器返回了异常数据';
    }
  }
}

export interface ConnectOk {
  sessionId: string;
  relayUrl: string;
  ticket: string;
  peer: { publicKey: string; platform: string; protoVer: number };
}

export interface ConnectHandle {
  /** 请求已送达被控端、进入“等待对方确认”阶段时 resolve 会话 id（直接出结果则不会 resolve） */
  pending: Promise<string>;
  result: Promise<ConnectOk>;
  /** 取消等待（幂等）：result 以 cancelled 失败 */
  cancel(): void;
}

export interface SignalEvents {
  onState(online: boolean): void;
  onNotice(level: string, code: string, text: string): void;
  /** 信令认证返回 UNKNOWN_DEVICE：调用方重新注册并返回新身份；返回 null 表示放弃 */
  onUnknownDevice(): Promise<Identity | null>;
  onUpgradeRequired(): void;
}

interface Msg {
  t: string;
  id?: string;
  d: Record<string, unknown>;
}

interface Req {
  resolve: (m: Msg) => void;
  reject: (e: unknown) => void;
  onPending?: (sid: string) => void;
}

const HELLO_TIMEOUT = 8000;
const AUTH_TIMEOUT = 8000;
const REQ_TIMEOUT = 10_000;
const IDLE_TIMEOUT = 45_000;
const CLOSE_REPLACED = 4409;
const CLOSE_BANNED = 4403;

export class SignalClient {
  private ws: WebSocket | null = null;
  private online = false;
  private stopped = false;
  private kicked = false;
  private seq = 0;
  private reqs = new Map<string, Req>();
  private lastRx = 0;
  private wake: Deferred<void> | null = null;
  private onlineWaiters: Array<() => void> = [];
  deviceCode: string;

  constructor(
    private identity: Identity,
    private getUrl: () => Promise<string>,
    private ev: SignalEvents,
  ) {
    this.deviceCode = identity.deviceCode;
  }

  get isOnline(): boolean {
    return this.online;
  }

  get currentIdentity(): Identity {
    return this.identity;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.resolve();
    this.ws?.close(1000);
  }

  /** 网络切换 / 页面重新可见：立即重试连接 */
  networkChanged(): void {
    this.kicked = false;
    this.wake?.resolve();
  }

  /** 等到在线，最多等 ms 毫秒 */
  waitOnline(ms: number): Promise<boolean> {
    if (this.online) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.onlineWaiters = this.onlineWaiters.filter((w) => w !== done);
        resolve(this.online);
      };
      const t = setTimeout(done, ms);
      this.onlineWaiters.push(done);
    });
  }

  // ———————————————————— 连接循环 ————————————————————

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      if (this.kicked) {
        await this.sleepOrWake(60_000);
        continue;
      }
      let ok: boolean;
      try {
        const url = await this.getUrl();
        ok = await this.session(url);
      } catch {
        ok = false;
      }
      this.setOnline(false);
      this.failAll(new SignalError('closed'));
      if (this.stopped) break;
      attempt = ok ? 0 : attempt + 1;
      await this.sleepOrWake(backoff(ok ? 1000 : 2000, 30_000, attempt));
    }
  }

  private async sleepOrWake(ms: number): Promise<void> {
    this.wake = deferred<void>();
    await Promise.race([sleep(ms), this.wake.promise]);
    this.wake = null;
  }

  private setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    this.ev.onState(v);
    if (v) for (const w of [...this.onlineWaiters]) w();
  }

  /** 一次完整的连接：返回 true 表示曾经认证成功（用来重置退避） */
  private async session(url: string): Promise<boolean> {
    const ws = new WebSocket(url);
    this.ws = ws;
    const inbox: Msg[] = [];
    let waiter: (() => void) | null = null;
    const closed = deferred<number>();
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data) as Msg;
        if (typeof m.t !== 'string') return;
        m.d ??= {};
        inbox.push(m);
        waiter?.();
      } catch {
        /* 忽略坏消息 */
      }
    };
    ws.onclose = (e) => {
      closed.resolve(e.code);
      waiter?.();
    };
    ws.onerror = () => {};
    const next = async (ms: number): Promise<Msg | null> => {
      const deadline = Date.now() + ms;
      while (inbox.length === 0) {
        if (ws.readyState === WebSocket.CLOSED) return null;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise<void>((r) => {
          waiter = r;
          setTimeout(r, Math.min(left, 500));
        });
        waiter = null;
      }
      return inbox.shift()!;
    };

    try {
      const hello = await next(HELLO_TIMEOUT);
      if (!hello || hello.t !== 'hello') return false;
      const nonce = String(hello.d.nonce ?? '');
      const authed = await this.authenticate(ws, nonce, next);
      if (!authed) return false;
      this.lastRx = Date.now();
      this.setOnline(true);
      return await this.serve(ws, inbox, next, closed.promise);
    } finally {
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        /* 已关闭 */
      }
      this.ws = null;
      const code = await Promise.race([closed.promise, sleep(300).then(() => 0)]);
      if ((code === CLOSE_REPLACED || code === CLOSE_BANNED) && !this.kicked) {
        this.kicked = true;
        this.ev.onNotice('error', code === CLOSE_BANNED ? 'BANNED' : 'KICK', code === CLOSE_BANNED ? '本设备已被封禁' : '此设备已在别处登录，当前页面已断开');
      }
    }
  }

  private async authenticate(ws: WebSocket, nonce: string, next: (ms: number) => Promise<Msg | null>): Promise<boolean> {
    const send = (id: string, id2: Identity): void => {
      const sig = b64encode(signMessage(id2.seed, enc.encode(`rterm-auth-v1\n${nonce}\n${id2.deviceId}`)));
      ws.send(JSON.stringify({ t: 'auth', id, d: { device_id: id2.deviceId, sig, app_version: APP_VERSION, proto_ver: 1, min_proto_ver: 1, accept: false } }));
    };
    send('auth', this.identity);
    for (;;) {
      const m = await next(AUTH_TIMEOUT);
      if (!m) return false;
      if (m.t === 'auth.ok') {
        this.deviceCode = String(m.d.device_code ?? this.identity.deviceCode);
        return true;
      }
      if (m.t === 'auth.err') {
        const code = String(m.d.code ?? '');
        if (code === 'UNKNOWN_DEVICE') {
          const fresh = await this.ev.onUnknownDevice().catch(() => null);
          if (!fresh) return false;
          this.identity = fresh;
          this.deviceCode = fresh.deviceCode;
          send('auth', fresh);
          continue;
        }
        if (code === 'VERSION') this.ev.onUpgradeRequired();
        if (code === 'BANNED') {
          this.kicked = true;
          this.ev.onNotice('error', 'BANNED', '本设备已被封禁');
        }
        return false;
      }
    }
  }

  private async serve(ws: WebSocket, inbox: Msg[], next: (ms: number) => Promise<Msg | null>, closed: Promise<number>): Promise<boolean> {
    let ping = 0;
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastRx > IDLE_TIMEOUT) {
        ws.close(4408);
        return;
      }
      ws.send(JSON.stringify({ t: 'ping', id: `p${++ping}`, d: {} }));
    }, 15_000);
    let done = false;
    void closed.then(() => (done = true));
    try {
      while (!done && !this.stopped) {
        const m = await next(1000);
        if (!m) continue;
        this.lastRx = Date.now();
        this.dispatch(m);
      }
    } finally {
      clearInterval(timer);
      inbox.length = 0;
    }
    return true;
  }

  private dispatch(m: Msg): void {
    switch (m.t) {
      case 'pong':
        return;
      case 'notice':
        this.ev.onNotice(String(m.d.level ?? 'info'), 'SERVER_NOTICE', String(m.d.text ?? ''));
        return;
      case 'kick':
        this.kicked = true;
        this.ev.onNotice('error', 'KICK', '此设备已在别处登录，当前页面已断开');
        return;
      case 'connect.pending': {
        const r = m.id ? this.reqs.get(m.id) : undefined;
        if (r?.onPending && typeof m.d.session_id === 'string') r.onPending(m.d.session_id);
        return;
      }
      default: {
        // connect.ok / connect.err / error 等：按 id 配对
        const r = m.id ? this.reqs.get(m.id) : undefined;
        if (r && m.id) {
          this.reqs.delete(m.id);
          r.resolve(m);
        }
      }
    }
  }

  private failAll(e: SignalError): void {
    for (const r of this.reqs.values()) r.reject(e);
    this.reqs.clear();
  }

  private sendRaw(t: string, d: unknown, id?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new SignalError('offline');
    this.ws.send(JSON.stringify(id ? { t, id, d } : { t, d }));
  }

  // ———————————————————— 发起连接 ————————————————————

  /**
   * 发起 connect.request。被控端开了“连接确认”时可以等任意久（没有超时），期间可 cancel。
   * 信令暂时离线时最多等 5 秒。
   */
  connectRequest(targetCode: string): ConnectHandle {
    const pending = deferred<string>();
    const result = deferred<ConnectOk>();
    void pending.promise.catch(() => {});
    void result.promise.catch(() => {});
    let sid = '';
    let cancelled = false;
    let id = '';

    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      if (id) this.reqs.delete(id);
      if (sid) {
        try {
          this.sendRaw('connect.cancel', { session_id: sid });
        } catch {
          /* 信令已断开，服务端按断线处理 */
        }
      }
      result.reject(new SignalError('cancelled'));
      pending.reject(new SignalError('cancelled'));
    };

    void (async () => {
      if (!(await this.waitOnline(5000))) return result.reject(new SignalError('offline'));
      if (cancelled) return;
      id = `c${++this.seq}`;
      this.reqs.set(id, {
        reject: result.reject,
        onPending: (s) => {
          sid = s;
          pending.resolve(s);
          if (cancelled) {
            try {
              this.sendRaw('connect.cancel', { session_id: s });
            } catch {
              /* 同上 */
            }
          }
        },
        resolve: (m) => {
          if (m.t === 'connect.ok') {
            const peer = (m.d.peer ?? {}) as Record<string, unknown>;
            if (typeof m.d.relay_url !== 'string' || typeof m.d.ticket !== 'string' || typeof m.d.session_id !== 'string' || typeof peer.public_key !== 'string') {
              return result.reject(new SignalError('bad_response'));
            }
            sid = m.d.session_id;
            result.resolve({
              sessionId: m.d.session_id,
              relayUrl: m.d.relay_url,
              ticket: m.d.ticket,
              peer: { publicKey: peer.public_key, platform: String(peer.platform ?? ''), protoVer: Number(peer.proto_ver ?? 1) },
            });
          } else if (m.t === 'connect.err') {
            result.reject(new SignalError('connect', String(m.d.code ?? 'UNKNOWN')));
          } else {
            result.reject(new SignalError('server', String(m.d.code ?? m.t)));
          }
        },
      });
      try {
        this.sendRaw('connect.request', { target_code: targetCode }, id);
      } catch (e) {
        this.reqs.delete(id);
        result.reject(e);
      }
    })();

    return { pending: pending.promise, result: result.promise, cancel };
  }

  /** 单次小请求的超时保护（预留给将来的非 connect 请求） */
  static readonly REQ_TIMEOUT = REQ_TIMEOUT;
}
