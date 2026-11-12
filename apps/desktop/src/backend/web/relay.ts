/**
 * 中继连接 + 握手 + 加密多路复用（对应 Rust 的 relay.rs 与 mux.rs，控制端一侧）。
 * 一条 WebSocket 二进制消息 = 一条记录：握手阶段 0x01||Handshake(明文)，之后 0x02||AEAD 密文(Frame)。
 */
import {
  REC_HANDSHAKE,
  Sealer,
  Spake2A,
  concat,
  confirmMac,
  deriveKeys,
  equalBytes,
  randomBytes,
  signMessage,
  transcript,
  verifyMac,
  verifySignature,
} from './crypto';
import type { Identity } from './identity';
import { decodeFrame, decodeHandshake, encodeFrame, encodeHandshake, type Frame } from './proto';
import { CodedError, deferred } from './util';

const enc = new TextEncoder();

export const PROTO_VER = 1;
/** 单条记录上限（整条 WebSocket 消息）与单个 Frame 明文上限 */
export const MAX_RECORD = 128 * 1024;
export const MAX_FRAME_PLAIN = MAX_RECORD - 17;
/** 批量数据（文件块）大小 */
export const BULK_CHUNK = 32 * 1024;

const INTERACTIVE_QUEUE = 256;
const BULK_QUEUE = 32;
const HANDSHAKE_TIMEOUT = 10_000;
/** 底层缓冲超过这个值就暂停写出（背压） */
const WS_HIGH_WATER = 512 * 1024;

const CLOSE_PEER_GONE = 4003;

export function closeCodeText(code: number): string {
  switch (code) {
    case 4001: return '票据无效或过期';
    case 4002: return '配对超时（对端未连上）';
    case 4003: return '对端已断开';
    case 4004: return '超出速率限制';
    case 4005: return '超出流量配额';
    case 4006: return '服务端维护，请重连';
    case 4007: return '消息过大或类型错误';
    default: return '连接已关闭';
  }
}

export type EstablishErrorKind =
  | 'bad_password'
  | 'peer_key_changed'
  | 'signal_key_mismatch'
  | 'bad_signature'
  | 'relay_closed'
  | 'connect'
  | 'timeout'
  | 'protocol';

export class EstablishError extends Error {
  constructor(
    readonly kind: EstablishErrorKind,
    message = '',
    readonly code: number | null = null,
    readonly known?: Uint8Array,
    readonly actual?: Uint8Array,
  ) {
    super(message || kind);
    this.name = 'EstablishError';
  }

  /** 重试是否可能成功（网络类可以，密码/安全类不应自动重试） */
  get retryable(): boolean {
    switch (this.kind) {
      case 'connect':
      case 'timeout':
        return true;
      case 'relay_closed':
        return this.code !== 4001 && this.code !== 4005 && this.code !== 4007;
      default:
        return false;
    }
  }
}

// ———————————————————— 中继 WebSocket ————————————————————

/** 中继连接：把到达的二进制记录排进队列，握手代码和 mux 都从这里取 */
export class RelaySocket {
  private queue: Uint8Array[] = [];
  private waiter: (() => void) | null = null;
  closeCode: number | null = null;
  closeReason = '';
  isClosed = false;
  onRecord: ((r: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) {
        // 中继只收发二进制，文本视为协议错误
        this.fail(null, '收到文本消息');
        return;
      }
      const rec = new Uint8Array(e.data);
      if (this.onRecord) this.onRecord(rec);
      else {
        this.queue.push(rec);
        this.waiter?.();
      }
    };
    ws.onclose = (e) => {
      this.fail(e.code, e.reason);
    };
    ws.onerror = () => {};
  }

  private fail(code: number | null, reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.waiter?.();
    this.onClose?.();
    try {
      this.ws.close(1000);
    } catch {
      /* 已关闭 */
    }
  }

  static connect(relayUrl: string, ticket: string): Promise<RelaySocket> {
    let url: URL;
    try {
      url = new URL(relayUrl);
    } catch {
      return Promise.reject(new EstablishError('connect', `中继地址无效 ${relayUrl}`));
    }
    if (!url.pathname.replace(/\/+$/, '').endsWith('/v1/relay')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/relay`;
    url.searchParams.set('ticket', ticket);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      const t = setTimeout(() => {
        ws.close();
        reject(new EstablishError('connect', '连接中继超时'));
      }, HANDSHAKE_TIMEOUT);
      const sock = new RelaySocket(ws);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(sock);
      };
      const prevClose = ws.onclose;
      ws.onclose = (e) => {
        clearTimeout(t);
        prevClose?.call(ws, e);
        reject(e.code >= 4000 ? new EstablishError('relay_closed', closeCodeText(e.code), e.code) : new EstablishError('connect', '连接中继失败'));
      };
    });
  }

  /** 取走已到达但还没人处理的记录（交接给 Link 时用） */
  takeQueued(): Uint8Array[] {
    return this.queue.splice(0);
  }

  /** 取下一条记录；连接关闭时返回 null */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      const r = this.queue.shift();
      if (r) return r;
      if (this.isClosed) return null;
      await new Promise<void>((res) => (this.waiter = res));
      this.waiter = null;
    }
  }

  send(rec: Uint8Array): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) throw new CodedError('NOT_READY', '连接已关闭');
    this.ws.send(rec as Uint8Array<ArrayBuffer>);
  }

  get buffered(): number {
    return this.ws.bufferedAmount;
  }

  close(): void {
    this.fail(null, '本端关闭');
  }
}

// ———————————————————— 加密多路复用 ————————————————————

export interface LinkCloseInfo {
  code: number | null;
  reason: string;
  local: boolean;
}

/**
 * 一条已加密的会话链路。发送：交互队列优先，批量队列（文件块）只在交互队列为空时发一块；
 * 队列有界，满了发送方等待（背压）；底层 WebSocket 缓冲过高时暂停写出。
 * 接收：解密、解码后交给 onFrame；任何解密失败立即关闭。
 */
interface QueuedFrame {
  channel: number;
  branch: string;
  value: object;
}

export class Link {
  private interactive: QueuedFrame[] = [];
  private bulk: QueuedFrame[] = [];
  private spaceWaiters: Array<() => void> = [];
  private pumping = false;
  private closedFlag = false;
  readonly closed = deferred<LinkCloseInfo>();
  onFrame: ((f: Frame) => void) | null = null;

  constructor(
    private sock: RelaySocket,
    private sealSend: Sealer,
    private sealRecv: Sealer,
    readonly peerPublicKey: Uint8Array,
  ) {
    sock.onRecord = (rec) => this.receive(rec);
    sock.onClose = () => this.finish({ code: sock.closeCode, reason: sock.closeReason, local: false });
    // 握手阶段已经到达、还留在队列里的记录
    for (const r of sock.takeQueued()) this.receive(r);
    if (sock.isClosed) this.finish({ code: sock.closeCode, reason: sock.closeReason, local: false });
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  private finish(info: LinkCloseInfo): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.sock.onRecord = null;
    this.sock.onClose = null;
    this.interactive.length = 0;
    this.bulk.length = 0;
    for (const w of this.spaceWaiters.splice(0)) w();
    this.closed.resolve(info);
    this.sock.close();
  }

  /** 主动中止（不等队列排空） */
  abort(reason = '本端中止'): void {
    this.finish({ code: null, reason, local: true });
  }

  private receive(rec: Uint8Array): void {
    if (this.closedFlag) return;
    if (rec.length > MAX_RECORD) return this.finish({ code: null, reason: '收到超长记录', local: false });
    let plain: Uint8Array;
    try {
      plain = this.sealRecv.open(rec);
    } catch {
      return this.finish({ code: null, reason: '记录校验失败', local: false });
    }
    let f: Frame;
    try {
      f = decodeFrame(plain);
    } catch {
      return this.finish({ code: null, reason: 'Frame 解码失败', local: false });
    }
    this.onFrame?.(f);
  }

  /** 发送一帧。交互队列满时等待；链路关闭时抛 NOT_READY */
  async send(channel: number, branch: string, value: object, bulk = false): Promise<void> {
    const q = bulk ? this.bulk : this.interactive;
    const cap = bulk ? BULK_QUEUE : INTERACTIVE_QUEUE;
    while (q.length >= cap && !this.closedFlag) await new Promise<void>((r) => this.spaceWaiters.push(r));
    if (this.closedFlag) throw new CodedError('NOT_READY', '连接已断开');
    q.push({ channel, branch, value });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closedFlag && (this.interactive.length > 0 || this.bulk.length > 0)) {
        // 底层写不动时先等，等可写再决定发哪个队列，避免批量块抢在刚到的交互帧前面
        while (this.sock.buffered > WS_HIGH_WATER && !this.closedFlag) await new Promise((r) => setTimeout(r, 5));
        if (this.closedFlag) return;
        const f = this.interactive.shift() ?? this.bulk.shift();
        if (!f) break;
        const plain = encodeFrame(f.channel, f.branch, f.value);
        if (plain.length > MAX_FRAME_PLAIN) return this.finish({ code: null, reason: '发送的 Frame 超过 128KB 上限', local: true });
        try {
          this.sock.send(this.sealSend.seal(plain));
        } catch {
          return this.finish({ code: null, reason: '发送失败', local: false });
        }
        for (const w of this.spaceWaiters.splice(0)) w();
      }
    } finally {
      this.pumping = false;
    }
  }
}

// ———————————————————— 握手 ————————————————————

export interface EstablishParams {
  relayUrl: string;
  ticket: string;
  sessionId: string;
  identity: Identity;
  controllerCode: string;
  hostCode: string;
  /** 信令 connect.ok.peer.public_key（已解码） */
  hostPublicKey: Uint8Array;
  /** Argon2id 派生值与类别 */
  pwKey: Uint8Array;
  pwKind: number;
  /** 本地记住的该被控端公钥；握手通过后若不一致返回 peer_key_changed（除非 acceptKeyChange） */
  knownHostKey: Uint8Array | null;
  acceptKeyChange: boolean;
}

function handshakeRecord(body: Parameters<typeof encodeHandshake>[0]): Uint8Array {
  return concat(Uint8Array.of(REC_HANDSHAKE), encodeHandshake(body));
}

function decodeHandshakeRecord(rec: Uint8Array): ReturnType<typeof decodeHandshake> {
  if (rec[0] !== REC_HANDSHAKE) throw new EstablishError('protocol', '握手阶段收到非握手记录');
  try {
    return decodeHandshake(rec.subarray(1));
  } catch {
    throw new EstablishError('protocol', '握手消息解码失败');
  }
}

/** 控制端：连中继 → SPAKE2 握手（照 crypto/handshake.rs）→ 加密 Link */
export async function establishController(p: EstablishParams): Promise<Link> {
  // 公钥变化要在发出任何握手消息之前判断：信令下发的公钥与本地记住的不一致且用户没确认，直接报告，不进入 PAKE
  if (p.knownHostKey && !equalBytes(p.knownHostKey, p.hostPublicKey) && !p.acceptKeyChange) {
    throw new EstablishError('peer_key_changed', '对方设备的公钥发生了变化', null, p.knownHostKey, p.hostPublicKey);
  }
  const sock = await RelaySocket.connect(p.relayUrl, p.ticket);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    sock.close();
  }, HANDSHAKE_TIMEOUT);
  try {
    // 步骤 1
    const { state, message: spakeA } = Spake2A.start(p.pwKey, enc.encode(p.controllerCode), enc.encode(p.hostCode));
    const nonceC = randomBytes(16);
    const myPk = p.identity.publicKey;
    sock.send(handshakeRecord({ init: { protoVer: PROTO_VER, spakeMsg: spakeA, publicKey: myPk, nonce: nonceC, passwordKind: p.pwKind } }));

    // 步骤 3
    const r1 = await sock.next();
    if (!r1) throw closedError(sock);
    const resp = decodeHandshakeRecord(r1);
    if (resp.body !== 'resp' || !resp.resp) throw new EstablishError('protocol', '期望 PakeResp');
    const { spakeMsg: spakeB, publicKey: hostPk, nonce: nonceH } = resp.resp;
    if (spakeB.length === 0 || spakeB.length > 64 || hostPk.length !== 32 || nonceH.length !== 16) throw new EstablishError('protocol', '握手消息长度非法');
    if (!equalBytes(hostPk, p.hostPublicKey)) throw new EstablishError('signal_key_mismatch', '对方公钥与信令下发的不一致，连接不安全');
    let shared: Uint8Array;
    try {
      shared = state.finish(spakeB);
    } catch {
      throw new EstablishError('protocol', 'spake2 finish 失败');
    }
    const t = transcript({
      protoVer: PROTO_VER,
      sessionId: p.sessionId,
      controllerCode: p.controllerCode,
      hostCode: p.hostCode,
      spakeMsgA: spakeA,
      spakeMsgB: spakeB,
      controllerPubkey: myPk,
      hostPubkey: hostPk,
      nonceC,
      nonceH,
    });
    const keys = deriveKeys(shared, t);
    sock.send(handshakeRecord({ confirm: { mac: confirmMac(keys.confirm, 'c', t), signature: signMessage(p.identity.seed, t) } }));

    // 步骤 5：被控端在步骤 4 校验失败会直接关闭连接，不回任何内容
    const r2 = await sock.next();
    if (!r2) {
      if (timedOut) throw new EstablishError('timeout', '握手超时');
      const c = sock.closeCode;
      if (c === null || c === CLOSE_PEER_GONE || c === 1000 || c === 1005 || c === 1006) throw new EstablishError('bad_password', '密码错误');
      throw closedError(sock);
    }
    const conf = decodeHandshakeRecord(r2);
    if (conf.body !== 'confirm' || !conf.confirm) throw new EstablishError('protocol', '期望 PakeConfirm');
    if (!verifyMac(keys.confirm, 'h', t, conf.confirm.mac)) throw new EstablishError('bad_password', '密码错误');
    if (!verifySignature(hostPk, t, conf.confirm.signature)) throw new EstablishError('bad_signature', '对方签名校验失败，连接不安全');

    // 握手已认证了对端，此处的公钥可信
    if (p.knownHostKey && !equalBytes(p.knownHostKey, hostPk) && !p.acceptKeyChange) {
      throw new EstablishError('peer_key_changed', '对方设备的公钥发生了变化', null, p.knownHostKey, hostPk);
    }
    clearTimeout(timer);
    return new Link(sock, new Sealer(keys.c2h), new Sealer(keys.h2c), hostPk);
  } catch (e) {
    sock.close();
    if (e instanceof EstablishError) throw e;
    if (timedOut) throw new EstablishError('timeout', '握手超时');
    if (sock.isClosed) throw closedError(sock);
    throw new EstablishError('protocol', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function closedError(sock: RelaySocket): EstablishError {
  const c = sock.closeCode;
  return new EstablishError('relay_closed', c !== null ? `中继关闭连接（${c} ${closeCodeText(c)}）` : '中继关闭连接', c);
}
