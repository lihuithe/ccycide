/**
 * RTerm 服务端协议的 Node 参考客户端，同时是自动化测试的基础。
 * Rust 客户端实现注册 / 信令 / 中继时可以对照这里的每一个字节。
 *
 * ── 协议要点（与《实现方案.md》4.2–4.4、《开发指南.md》T3/T4 一致）──
 *
 * 1. 注册 POST {http}/v1/devices/register
 *    签名串（UTF-8，\n 连接，末尾无换行）：
 *      "rterm-register-v1\n<public_key base64>\n<platform>\n<arch>\n<kind>\n<ts>"
 *    public_key / signature 都是标准 base64（带 padding）。signature = Ed25519(私钥, 签名串)。
 *    响应：{ device_id: "<ULID>", device_code: "<9 位数字>" }
 *
 * 2. 信令 WebSocket {ws}/v1/signal
 *    ← {"t":"hello","d":{"nonce":"<base64>","server_time":<秒>}}
 *    → {"t":"auth","id":"1","d":{"device_id":..., "sig":<base64>, "app_version":"..","proto_ver":1}}
 *       sig = Ed25519(私钥, "rterm-auth-v1\n" + nonce + "\n" + device_id)，nonce 用 hello 里的原样字符串
 *    ← {"t":"auth.ok","d":{"device_code":"..","heartbeat_sec":20}}   或 auth.err {code}
 *    之后每 20 秒发 {"t":"ping","id":"..."}，收 pong；45 秒收不到任何消息就应当判定断线。
 *
 * 3. 发起连接（被控端开启“连接确认”时可以等任意久，服务端没有固定超时，所以票据在被控端同意之后才签发）
 *    主控 → {"t":"connect.request","id":"7","d":{"target_code":"<被控设备码>"}}
 *    主控 ← {"t":"connect.pending","id":"7","d":{"session_id"}}      已送达被控端，等待对方处理；只是进度，最终响应仍是下面的 ok / err
 *    被控 ← {"t":"connect.incoming","d":{"session_id","from":{device_code,platform,public_key,region}}}   不带 relay_url / ticket
 *    被控 → {"t":"connect.accept","d":{"session_id"}}  或 connect.reject {session_id, reason?}（想等多久都行，直到用户操作）
 *    被控 ← {"t":"connect.go","d":{"session_id","relay_url","ticket"}}   同意之后才下发，票据 30 秒有效，立刻去连中继
 *    主控 ← {"t":"connect.ok","id":"7","d":{"session_id","relay_url","ticket","peer":{public_key,platform,proto_ver}}}   沿用原请求 id
 *         或 {"t":"connect.err","id":"7","d":{"code":"UNAVAILABLE|REJECTED|RATE_LIMITED|LOCKED|VERSION|BANNED|NO_RELAY","reason"?}}
 *    主控 → {"t":"connect.cancel","d":{"session_id"}}   取消等待（无响应）；被控 ← {"t":"connect.cancelled","d":{"session_id"}} 撤掉确认弹窗
 *    主控端信令断开等同取消；被控端信令断开（或服务端判定被控端丢失）主控端收到 connect.err UNAVAILABLE；
 *    服务端投递给被控端失败时主控端立即收到 connect.err UNAVAILABLE + reason=deliver_failed。
 *    等待期间主控端仍要照常每 20 秒发 ping；服务端不会因为“正在等待确认”而断开连接，兜底上限 CONNECT_PENDING_MAX_SEC（默认 3600 秒，
 *    到期主控端收到 connect.err REJECTED reason=timeout）。
 *
 * 4. 中继 WebSocket：连接 `${relay_url}/v1/relay?ticket=${ticket}`（relay_url 不含路径，客户端自己拼 /v1/relay）
 *    只收发二进制消息，一条 WebSocket 消息 = 一条加密层记录，中继原样转发，单条不超过 128KB。
 *    关闭码：4001 票据无效/已用 4002 配对超时(15s) 4003 对端已断开 4004 限速 4005 超出日配额 4006 中继维护 4007 消息过大或非二进制。
 *    每张票据只能用一次；两端都连上后才开始转发，先到的一端发的数据中继会缓存。
 *
 * 5. 密码失败上报（被控端）：{"t":"session.report","d":{"session_id","event":"auth_failed"}}
 *    event 取值：auth_ok / auth_failed / closed / host_locked（host_locked 带 detail.lock_sec）。
 *    被控端 5 次失败后，主控端的 connect.request 会收到 LOCKED。
 *
 * ── 命令行用法 ──
 *   npm run client:demo                       端到端演示：连接 → 中继互发；被控端迟迟不确认（默认 16 秒，--delay-sec 调整）；主控端取消；被控端拒绝
 *   npm run client:host                       常驻被控端，自动接受并回显
 *   npm run client:connect -- <设备码> "消息"   作为主控端连接指定设备并发一条消息
 * 通用参数：--http http://127.0.0.1:8080   --identity <文件，默认 tools/.identity/<角色>.json>
 */
import { EventEmitter } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, type RawData } from 'ws';
import { authSignString, registerSignString } from '../src/crypto.js';

// ---------- 身份与注册 ----------

export interface Identity {
  deviceId: string;
  deviceCode: string;
  /** PKCS8 DER 的 base64 */
  privateKey: string;
  /** 32 字节原始公钥的 base64 */
  publicKey: string;
}

export interface KeyPair {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // SPKI DER 的最后 32 字节就是原始公钥
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKeyRaw: Buffer.from(der.subarray(der.length - 32)) };
}

export function signB64(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

export interface RegisterOptions {
  platform?: string;
  arch?: string;
  kind?: string;
  osVersion?: string;
  appVersion?: string;
  /** 覆盖时间戳（测试用） */
  ts?: number;
  /** 篡改签名（测试用） */
  tamperSignature?: boolean;
}

export interface RegisterResponse {
  status: number;
  body: { device_id?: string; device_code?: string; error?: { code: string; message: string; retry_after?: number } };
}

/** 调用注册接口并返回原始状态码和响应体 */
export async function postRegister(http: string, kp: KeyPair, opts: RegisterOptions = {}): Promise<RegisterResponse> {
  const platform = opts.platform ?? 'windows';
  const arch = opts.arch ?? 'x86_64';
  const kind = opts.kind ?? 'desktop';
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const publicKeyB64 = kp.publicKeyRaw.toString('base64');
  let signature = signB64(kp.privateKey, registerSignString({ publicKeyB64, platform, arch, kind, ts }));
  if (opts.tamperSignature) {
    const raw = Buffer.from(signature, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    signature = raw.toString('base64');
  }
  const res = await fetch(`${http}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key: publicKeyB64,
      platform,
      arch,
      os_version: opts.osVersion ?? '10.0.19044',
      app_version: opts.appVersion ?? '0.1.0',
      kind,
      ts,
      signature,
    }),
  });
  return { status: res.status, body: (await res.json()) as RegisterResponse['body'] };
}

/** 生成新密钥并注册，返回完整身份 */
export async function registerNew(http: string, opts: RegisterOptions = {}): Promise<{ identity: Identity; kp: KeyPair }> {
  const kp = generateKeyPair();
  const r = await postRegister(http, kp, opts);
  if (r.status !== 200 || !r.body.device_id || !r.body.device_code) {
    throw new Error(`注册失败：HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { identity: toIdentity(kp, r.body.device_id, r.body.device_code), kp };
}

export function toIdentity(kp: KeyPair, deviceId: string, deviceCode: string): Identity {
  return {
    deviceId,
    deviceCode,
    privateKey: Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64'),
    publicKey: kp.publicKeyRaw.toString('base64'),
  };
}

export function loadPrivateKey(id: Identity): KeyObject {
  return createPrivateKey({ key: Buffer.from(id.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
}

/** 由身份还原公钥对象（调试用） */
export function loadPublicKey(id: Identity): KeyObject {
  return createPublicKey(loadPrivateKey(id));
}

// ---------- 信令客户端 ----------

export interface SignalMsg {
  t: string;
  id?: string;
  d: Record<string, any>;
}

export interface ConnectOk {
  session_id: string;
  relay_url: string;
  ticket: string;
  peer: { public_key: string; platform: string; proto_ver: number };
}

/** 被控端收到的连接请求（不带票据） */
export interface Incoming {
  session_id: string;
  from: { device_code: string; platform: string; public_key: string; region: string };
}

/** 被控端同意之后收到的中继信息 */
export interface Go {
  session_id: string;
  relay_url: string;
  ticket: string;
}

export interface ConnectHandle {
  /** 服务端回 connect.pending（或直接回最终结果）之后得到 session_id；失败时为 null */
  pending: Promise<string | null>;
  /** 最终结果：connect.ok / connect.err */
  result: Promise<ConnectResult>;
  /** 取消等待 */
  cancel(): Promise<void>;
}

export type ConnectResult = { ok: true; data: ConnectOk } | { ok: false; code: string; data: Record<string, any> };

export interface SignalConnectOptions {
  appVersion?: string;
  protoVer?: number;
  minProtoVer?: number;
  /** 认证时声明是否接受连接（可选字段，默认 true） */
  accept?: boolean;
  /** 自动每 N 毫秒发一次 ping，0 表示不发 */
  pingMs?: number;
  /** 篡改签名（测试用） */
  badSignature?: boolean;
}

export class SignalClient extends EventEmitter {
  readonly messages: SignalMsg[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;
  private seq = 0;
  private waiters: Array<{ match: (m: SignalMsg) => boolean; resolve: (m: SignalMsg) => void }> = [];
  private pingTimer: NodeJS.Timeout | null = null;
  deviceCode = '';
  heartbeatSec = 20;

  constructor(
    readonly ws: WebSocket,
    readonly identity: Identity,
  ) {
    super();
    this.closed = new Promise((resolve) => {
      ws.on('close', (code) => {
        this.closeCode = code;
        if (this.pingTimer) clearInterval(this.pingTimer);
        resolve(code);
      });
    });
    ws.on('error', () => {});
    ws.on('message', (raw: RawData, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw.toString()) as SignalMsg;
      this.messages.push(m);
      this.emit('message', m);
      // t=error 不能直接当事件名发（EventEmitter 对 error 事件无监听器会抛异常）
      if (m.t !== 'error') this.emit(m.t, m);
      this.waiters = this.waiters.filter((w) => {
        if (w.match(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
  }

  /** 完整流程：连接 -> hello -> auth -> auth.ok。认证失败抛出 AuthError */
  static async connect(wsUrl: string, identity: Identity, opts: SignalConnectOptions = {}): Promise<SignalClient> {
    const ws = new WebSocket(wsUrl);
    const early: SignalMsg[] = [];
    ws.on('message', (raw: RawData) => early.push(JSON.parse(raw.toString()) as SignalMsg));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const deadline = Date.now() + 5000;
    while (early.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const hello = early.shift();
    if (!hello || hello.t !== 'hello') throw new Error(`没有收到 hello：${JSON.stringify(early)}`);
    ws.removeAllListeners('message');

    const client = new SignalClient(ws, identity);
    client.messages.push(hello);
    for (const m of early) ws.emit('message', Buffer.from(JSON.stringify(m)), false);

    const key = loadPrivateKey(identity);
    let sig = signB64(key, authSignString(hello.d.nonce, identity.deviceId));
    if (opts.badSignature) {
      const raw = Buffer.from(sig, 'base64');
      raw[0] = raw[0]! ^ 0xff;
      sig = raw.toString('base64');
    }
    const authD: Record<string, unknown> = {
      device_id: identity.deviceId,
      sig,
      app_version: opts.appVersion ?? '0.1.0',
      proto_ver: opts.protoVer ?? 1,
    };
    if (opts.minProtoVer !== undefined) authD.min_proto_ver = opts.minProtoVer;
    if (opts.accept !== undefined) authD.accept = opts.accept;
    const resP = client.waitFor((m) => m.t === 'auth.ok' || m.t === 'auth.err', 5000);
    client.sendRaw({ t: 'auth', id: client.nextId(), d: authD });
    const res = await resP;
    if (res.t === 'auth.err') {
      throw new AuthError(res.d.code);
    }
    client.deviceCode = res.d.device_code;
    client.heartbeatSec = res.d.heartbeat_sec;
    if (opts.pingMs && opts.pingMs > 0) {
      client.pingTimer = setInterval(() => client.sendRaw({ t: 'ping', id: client.nextId(), d: {} }), opts.pingMs);
      client.pingTimer.unref();
    }
    return client;
  }

  nextId(): string {
    return String(++this.seq);
  }

  sendRaw(m: { t: string; id?: string; d?: unknown }): void {
    this.ws.send(JSON.stringify(m));
  }

  /** 等待满足条件的消息（已经收到的历史消息不算，只等新的） */
  waitFor(match: (m: SignalMsg) => boolean, timeoutMs = 5000): Promise<SignalMsg> {
    return new Promise((resolve, reject) => {
      // timeoutMs 为 0 表示一直等（被控端确认可能要等很久）
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiters = this.waiters.filter((w) => w !== waiter);
              reject(new Error(`等待消息超时（${timeoutMs}ms）`));
            }, timeoutMs)
          : null;
      const waiter = {
        match,
        resolve: (m: SignalMsg) => {
          if (timer) clearTimeout(timer);
          resolve(m);
        },
      };
      this.waiters.push(waiter);
    });
  }

  /** 发请求并等待带同一 id 的响应 */
  request(t: string, d: unknown = {}, timeoutMs = 5000): Promise<SignalMsg> {
    const id = this.nextId();
    const p = this.waitFor((m) => m.id === id, timeoutMs);
    this.sendRaw({ t, id, d });
    return p;
  }

  async ping(): Promise<void> {
    const r = await this.request('ping', {});
    if (r.t !== 'pong') throw new Error(`期望 pong，收到 ${r.t}`);
  }

  setAccept(accept: boolean): void {
    this.sendRaw({ t: 'presence.update', d: { accept } });
  }

  /**
   * 发起连接。返回句柄：pending（拿到 session_id）、result（最终结果）、cancel()。
   * timeoutMs 是客户端自己等多久，0 表示一直等（对应被控端“连接确认”无限期等待）。
   */
  startConnect(targetCode: string, timeoutMs = 0): ConnectHandle {
    const id = this.nextId();
    const resultMsgP = this.waitFor((m) => m.id === id && m.t !== 'connect.pending', timeoutMs);
    const sidP = this.waitFor((m) => m.id === id, 0).then((m) => (m.d.session_id as string | undefined) ?? null);
    this.sendRaw({ t: 'connect.request', id, d: { target_code: targetCode } });
    const result: Promise<ConnectResult> = resultMsgP.then((r) =>
      r.t === 'connect.ok' ? { ok: true as const, data: r.d as ConnectOk } : { ok: false as const, code: r.d.code as string, data: r.d },
    );
    void result.catch(() => {});
    return {
      pending: sidP,
      result,
      cancel: async () => {
        const sid = await sidP;
        if (sid) this.sendRaw({ t: 'connect.cancel', d: { session_id: sid } });
      },
    };
  }

  /** 发起连接并等最终结果（connect.pending 只是进度，不算结果）。timeoutMs 默认 60 秒，0 表示一直等 */
  connectRequest(targetCode: string, timeoutMs = 60_000): Promise<ConnectResult> {
    return this.startConnect(targetCode, timeoutMs).result;
  }

  waitIncoming(timeoutMs = 5000): Promise<Incoming> {
    return this.waitFor((m) => m.t === 'connect.incoming', timeoutMs).then((m) => m.d as Incoming);
  }

  /** 等被控端的 connect.go（同意之后才会收到） */
  waitGo(sessionId: string, timeoutMs = 10_000): Promise<Go> {
    return this.waitFor((m) => m.t === 'connect.go' && m.d.session_id === sessionId, timeoutMs).then((m) => m.d as Go);
  }

  waitCancelled(sessionId: string, timeoutMs = 5000): Promise<void> {
    return this.waitFor((m) => m.t === 'connect.cancelled' && m.d.session_id === sessionId, timeoutMs).then(() => {});
  }

  accept(sessionId: string): void {
    this.sendRaw({ t: 'connect.accept', d: { session_id: sessionId } });
  }

  /** 同意并等 connect.go（先挂好监听再发 accept，不会错过） */
  acceptGo(sessionId: string, timeoutMs = 10_000): Promise<Go> {
    const p = this.waitGo(sessionId, timeoutMs);
    this.accept(sessionId);
    return p;
  }

  cancel(sessionId: string): void {
    this.sendRaw({ t: 'connect.cancel', d: { session_id: sessionId } });
  }

  reject(sessionId: string, reason?: string): void {
    this.sendRaw({ t: 'connect.reject', d: { session_id: sessionId, ...(reason ? { reason } : {}) } });
  }

  report(sessionId: string, event: string, detail?: unknown): void {
    this.sendRaw({ t: 'session.report', d: { session_id: sessionId, event, ...(detail ? { detail } : {}) } });
  }

  close(): void {
    this.ws.close(1000);
  }
}

export class AuthError extends Error {
  constructor(public code: string) {
    super(`认证失败：${code}`);
    this.name = 'AuthError';
  }
}

// ---------- 中继客户端 ----------

export class RelayConn extends EventEmitter {
  readonly received: Buffer[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    super();
    this.closed = new Promise((resolve) => {
      ws.on('close', (code) => {
        this.closeCode = code;
        resolve(code);
      });
    });
    ws.on('error', () => {});
    ws.on('message', (data: RawData, isBinary) => {
      if (!isBinary) return;
      const b = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      this.received.push(b);
      this.emit('message', b);
    });
  }

  /** 连接中继：relay_url 不含路径，这里拼上 /v1/relay?ticket= */
  static async connect(relayUrl: string, ticket: string): Promise<RelayConn> {
    const ws = new WebSocket(`${relayUrl.replace(/\/+$/, '')}/v1/relay?ticket=${encodeURIComponent(ticket)}`, { perMessageDeflate: false });
    const c = new RelayConn(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return c;
  }

  send(data: Buffer | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => this.ws.send(data, { binary: true }, (e) => (e ? reject(e) : resolve())));
  }

  /** 等待累计收到至少 n 条消息 */
  async waitCount(n: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < n) {
      if (Date.now() > deadline) throw new Error(`等待 ${n} 条中继消息超时，已收到 ${this.received.length}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  close(code = 1000): void {
    this.ws.close(code);
  }
}

// ---------- 命令行 ----------

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function wsOf(http: string): string {
  return http.replace(/^http/, 'ws') + '/v1/signal';
}

async function loadOrRegister(http: string, role: string): Promise<{ identity: Identity }> {
  const file = arg('identity') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.identity', `${role}.json`);
  if (existsSync(file)) return { identity: JSON.parse(readFileSync(file, 'utf8')) as Identity };
  const { identity } = await registerNew(http, { platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2));
  console.log(`已注册新设备，身份保存在 ${file}`);
  return { identity };
}

/** 端到端演示：连接 -> 中继互发；被控端迟迟不确认；主控端取消；被控端拒绝 */
async function demo(http: string): Promise<void> {
  const delaySec = Number(arg('delay-sec', '16'));
  const step = (s: string): void => console.log(`[演示] ${s}`);
  const host = (await registerNew(http)).identity;
  const ctl = (await registerNew(http)).identity;
  step(`注册完成：被控端 ${host.deviceCode}，主控端 ${ctl.deviceCode}`);

  const hostSig = await SignalClient.connect(wsOf(http), host, { pingMs: 5000 });
  const ctlSig = await SignalClient.connect(wsOf(http), ctl, { pingMs: 5000 });
  step('两端信令认证通过（auth.ok）');

  // ---- 场景 1：立即同意，中继互发 ----
  {
    const incomingP = hostSig.waitIncoming();
    const h = ctlSig.startConnect(host.deviceCode);
    const incoming = await incomingP;
    if ('ticket' in incoming) throw new Error('connect.incoming 不应该带票据');
    step(`被控端收到 connect.incoming（来自 ${incoming.from.device_code}，session ${incoming.session_id}），没有票据`);
    const goP = hostSig.acceptGo(incoming.session_id);
    const result = await h.result;
    if (!result.ok) throw new Error(`连接失败：${result.code}`);
    const go = await goP;
    step(`同意之后才下发票据：被控端收到 connect.go，主控端收到 connect.ok（中继 ${result.data.relay_url}）`);

    const [hostRelay, ctlRelay] = await Promise.all([RelayConn.connect(go.relay_url, go.ticket), RelayConn.connect(result.data.relay_url, result.data.ticket)]);
    const a = randomBytes(1000);
    const b = randomBytes(5000);
    await ctlRelay.send(a);
    await hostRelay.send(b);
    await Promise.all([hostRelay.waitCount(1), ctlRelay.waitCount(1)]);
    if (!hostRelay.received[0]!.equals(a)) throw new Error('被控端收到的数据与主控端发送的不一致');
    if (!ctlRelay.received[0]!.equals(b)) throw new Error('主控端收到的数据与被控端发送的不一致');
    step('中继互发成功：主控 -> 被控 1000 字节，被控 -> 主控 5000 字节，内容逐字节一致');
    hostSig.report(incoming.session_id, 'auth_ok');
    ctlRelay.close();
    const code = await hostRelay.closed;
    step(`主控端断开后，被控端中继连接收到关闭码 ${code}（期望 4003）`);
  }

  // ---- 场景 2：被控端迟迟不确认（模拟“连接确认”弹窗没人点），之后仍能连上 ----
  {
    const incomingP = hostSig.waitIncoming();
    const t0 = Date.now();
    const h = ctlSig.startConnect(host.deviceCode);
    const sid = await h.pending;
    step(`主控端收到 connect.pending（session ${sid}），被控端 ${delaySec} 秒后才点同意…`);
    const incoming = await incomingP;
    await new Promise((r) => setTimeout(r, delaySec * 1000));
    const goP = hostSig.acceptGo(incoming.session_id);
    const result = await h.result;
    if (!result.ok) throw new Error(`延迟同意后连接失败：${result.code}`);
    const go = await goP;
    const [hostRelay, ctlRelay] = await Promise.all([RelayConn.connect(go.relay_url, go.ticket), RelayConn.connect(result.data.relay_url, result.data.ticket)]);
    await ctlRelay.send(Buffer.from('late hello'));
    await hostRelay.waitCount(1);
    step(`延迟 ${Math.round((Date.now() - t0) / 1000)} 秒后同意，仍然连上并互发成功（没有 10 秒超时）`);
    hostRelay.close();
    await ctlRelay.closed;
  }

  // ---- 场景 3：主控端取消，被控端的确认弹窗被撤掉 ----
  {
    const incomingP = hostSig.waitIncoming();
    const h = ctlSig.startConnect(host.deviceCode);
    const incoming = await incomingP;
    const cancelledP = hostSig.waitCancelled(incoming.session_id);
    await h.cancel();
    await cancelledP;
    step('主控端取消：被控端收到 connect.cancelled，可以撤掉确认弹窗');
    hostSig.accept(incoming.session_id); // 迟到的答复会被忽略
  }

  // ---- 场景 4：被控端拒绝 ----
  {
    const incomingP = hostSig.waitIncoming();
    const h = ctlSig.startConnect(host.deviceCode);
    const incoming = await incomingP;
    hostSig.reject(incoming.session_id);
    const result = await h.result;
    if (result.ok || result.code !== 'REJECTED') throw new Error('期望收到 REJECTED');
    step('被控端拒绝：主控端收到 connect.err REJECTED');
  }

  hostSig.close();
  ctlSig.close();
  console.log('演示通过');
}

/** 常驻被控端：自动接受连接，把收到的二进制数据加前缀 "echo:" 后回发 */
async function hostLoop(http: string): Promise<void> {
  const { identity } = await loadOrRegister(http, 'host');
  const sig = await SignalClient.connect(wsOf(http), identity, { pingMs: 20_000 });
  console.log(`被控端在线，设备码 ${sig.deviceCode}。等待连接…`);
  sig.on('connect.incoming', async (m: SignalMsg) => {
    const inc = m.d as Incoming;
    console.log(`收到来自 ${inc.from.device_code} 的连接请求，自动接受`);
    const go = await sig.acceptGo(inc.session_id);
    const relay = await RelayConn.connect(go.relay_url, go.ticket);
    relay.on('message', (b: Buffer) => {
      console.log(`收到 ${b.length} 字节：${b.toString('utf8').slice(0, 80)}`);
      void relay.send(Buffer.concat([Buffer.from('echo:'), b]));
    });
    await relay.closed;
    console.log('会话结束');
  });
  await sig.closed;
  console.log('信令连接断开');
}

/** 作为主控端连接指定设备，发一条消息并打印回显 */
async function connectOnce(http: string, target: string, text: string): Promise<void> {
  const { identity } = await loadOrRegister(http, 'controller');
  const sig = await SignalClient.connect(wsOf(http), identity);
  const r = await sig.connectRequest(target);
  if (!r.ok) {
    console.error(`连接失败：${r.code}`);
    sig.close();
    process.exit(1);
  }
  const relay = await RelayConn.connect(r.data.relay_url, r.data.ticket);
  await relay.send(Buffer.from(text, 'utf8'));
  await relay.waitCount(1, 10_000);
  console.log(`收到回复：${relay.received[0]!.toString('utf8')}`);
  relay.close();
  sig.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const http = arg('http', process.env.RTERM_HTTP ?? 'http://127.0.0.1:8080')!;
  const cmd = process.argv[2];
  const run = async (): Promise<void> => {
    if (cmd === 'demo') await demo(http);
    else if (cmd === 'host') await hostLoop(http);
    else if (cmd === 'connect') {
      const rest = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')));
      if (!rest[0]) throw new Error('用法：connect <设备码> [消息]');
      await connectOnce(http, rest[0], rest[1] ?? 'hello from controller');
    } else {
      console.log('用法：demo | host | connect <设备码> [消息]   参数：--http <地址> --identity <文件>');
      process.exit(2);
    }
  };
  run().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
