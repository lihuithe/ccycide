import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { ticketSecrets } from '../config.js';
import type { BaseCtx } from '../context.js';
import { clientIp, rateKeyIp } from '../util/ip.js';
import { every } from '../util/time.js';
import { utcDate } from '../util/time.js';
import { TokenBucket } from './limiter.js';
import { verifyTicket, type Ticket } from './ticket.js';

/** 中继使用的 WebSocket 关闭码，见《实现方案.md》4.4 */
export const RELAY_CLOSE = {
  TICKET_INVALID: 4001,
  PAIR_TIMEOUT: 4002,
  PEER_GONE: 4003,
  RATE_LIMIT: 4004,
  QUOTA: 4005,
  MAINTENANCE: 4006,
  BAD_MESSAGE: 4007,
} as const;

export const RELAY_PATH = '/v1/relay';

/** 配对前先到的一端，最多缓存这么多数据；超过说明对方行为异常 */
const EARLY_MAX_BYTES = 256 * 1024;
const EARLY_MAX_MSGS = 64;
/** 按字节上报流量配额的批量大小 */
const QUOTA_FLUSH_BYTES = 256 * 1024;
/** 带宽使用率的参考上限（1Gbps），仅用于节点负载上报 */
const NIC_BYTES_PER_SEC = 125_000_000;

class Peer {
  ws: WebSocket;
  ticket: Ticket | null = null;
  session: Session | null = null;
  other: Peer | null = null;
  alive = true;
  /** 配对前收到的消息 */
  early: Buffer[] = [];
  earlyBytes = 0;
  pairTimer: NodeJS.Timeout | null = null;
  pauseReasons = new Set<'bp' | 'rate'>();
  bpTimer: NodeJS.Timeout | null = null;
  rateTimer: NodeJS.Timeout | null = null;
  bucket: TokenBucket | null = null;
  quotaPending = 0;
  quotaBlocked = false;
  closed = false;
  /** 来源计数键（IPv6 按 /64 归一），null 表示没有计入 */
  ipKey: string | null = null;
  /** 已计入设备并发连接数的设备 ID */
  countedDid: string | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  get role(): 'c' | 'h' {
    return this.ticket!.role;
  }
}

interface Session {
  sid: string;
  c: Peer;
  h: Peer;
  bytesC2h: number;
  bytesH2c: number;
  closing: boolean;
}

export class RelayServer {
  readonly http: HttpServer;
  private wss: WebSocketServer;
  /** 等待配对的一端 */
  private waiting = new Map<string, Peer>();
  /** 并发连接数：按来源（IPv6 /64）、按设备 */
  private ipConns = new Map<string, number>();
  private didConns = new Map<string, number>();
  private sessions = new Map<string, Session>();
  private timers: NodeJS.Timeout[] = [];
  private draining = false;
  private bytesWindow = 0;
  private lastBandwidth = 0;

  constructor(private ctx: BaseCtx) {
    // 单条消息上限 128KB。ws 自己的 maxPayload 设为两倍：超过 128KB 时由我们用 4007 关闭，
    // 而不是让 ws 用 1009 关闭，这样客户端能拿到文档约定的关闭码。
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: ctx.cfg.tunables.relayMaxMessage * 2 });
    this.http = createServer((req, res) => this.onHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 当前等待配对的连接数（测试用） */
  get waitingCount(): number {
    return this.waiting.size;
  }

  /** 当前计入来源 / 设备并发限制的连接总数（测试用，用来确认连接关闭后计数被释放） */
  get connCounters(): { ips: number; devices: number } {
    const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
    return { ips: sum(this.ipConns), devices: sum(this.didConns) };
  }

  get isDraining(): boolean {
    return this.draining;
  }

  async listen(port: number, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    this.startTimers();
    await this.report();
    return (this.http.address() as AddressInfo).port;
  }

  private startTimers(): void {
    const t = this.ctx.cfg.tunables;
    // 协议层心跳：每 30 秒 ping，上一轮没回 pong 的断开，清理半开连接
    this.timers.push(
      every(t.relayPingMs, () => {
        for (const ws of this.wss.clients) {
          const peer = this.peerOf.get(ws);
          if (peer && !peer.alive) {
            ws.terminate();
            continue;
          }
          if (peer) peer.alive = false;
          try {
            ws.ping();
          } catch {
            ws.terminate();
          }
        }
      }),
    );
    // 每 10 秒向注册表上报负载，30 秒没上报视为下线
    this.timers.push(every(10_000, () => void this.report()));
    // 每 30 秒给进行中的会话续期“同时会话数”计数
    this.timers.push(
      every(30_000, () => {
        for (const s of this.sessions.values()) void this.touchTracker(s);
      }),
    );
  }

  private peerOf = new WeakMap<WebSocket, Peer>();

  private async report(): Promise<void> {
    const { cfg, stores, log } = this.ctx;
    const now = Date.now();
    const bw = Math.min(1, this.bytesWindow / 10 / NIC_BYTES_PER_SEC);
    this.bytesWindow = 0;
    this.lastBandwidth = bw;
    try {
      await stores.registry.report(
        {
          name: cfg.relay.nodeName,
          region: cfg.relay.region,
          publicUrl: cfg.relay.publicUrl,
          sessions: this.sessions.size,
          capacity: cfg.relay.capacity,
          bandwidth: bw,
          status: this.draining ? 'draining' : 'up',
          ts: now,
        },
        30_000,
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, '向注册表上报中继节点负载失败');
    }
  }

  // ---------- HTTP ----------

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && (path === '/healthz' || path === '/v1/healthz')) {
      const body = JSON.stringify(this.draining ? { ok: false, draining: true } : { ok: true });
      res.writeHead(this.draining ? 503 : 200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(this.ctx.metrics.render());
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND","message":"not found"}}');
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    const u = new URL(req.url ?? '/', 'http://relay');
    if (u.pathname !== RELAY_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    // 同一来源的并发连接数上限：握手之前就拒绝，不占 WebSocket 资源（安全审查建议 11）。
    // 来源 IP 只在受信任代理（TRUST_PROXY，compose 里即 caddy）后面才采用 X-Forwarded-For
    const ipKey = rateKeyIp(clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], this.ctx.trust));
    if ((this.ipConns.get(ipKey) ?? 0) >= this.ctx.cfg.tunables.maxRelayConnsPerIp) {
      this.ctx.m.relayCloses.inc({ code: 429 });
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = u.searchParams.get('ticket') ?? '';
    // 票据无效时也完成握手再用 4001 关闭，客户端才能拿到明确的原因
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, token, ipKey));
  }

  // ---------- 连接与配对 ----------

  private onConnection(ws: WebSocket, token: string, ipKey: string): void {
    const { ctx } = this;
    const peer = new Peer(ws);
    this.peerOf.set(ws, peer);
    peer.ipKey = ipKey;
    this.ipConns.set(ipKey, (this.ipConns.get(ipKey) ?? 0) + 1);

    ws.on('error', () => {});
    ws.on('pong', () => {
      peer.alive = true;
    });
    // 消息监听必须在握手完成时同步挂上：下面的票据校验有异步步骤，期间到达的数据先缓存，配对后按序转发
    ws.on('message', (data, isBinary) => this.onMessage(peer, data, isBinary));
    ws.on('close', () => this.onClose(peer));

    const ticket = verifyTicket(token, ticketSecrets(ctx.cfg), ctx.cfg.relay.nodeName);
    if (!ticket) return this.reject(peer, RELAY_CLOSE.TICKET_INVALID, 'invalid ticket');
    peer.ticket = ticket;
    if (this.draining) return this.reject(peer, RELAY_CLOSE.MAINTENANCE, 'draining');
    // 同一设备的并发连接数上限（含已配对和等待配对的）
    const did = ticket.did;
    const n = (this.didConns.get(did) ?? 0) + 1;
    this.didConns.set(did, n);
    peer.countedDid = did;
    if (n > ctx.cfg.tunables.maxRelayConnsPerDevice) return this.reject(peer, RELAY_CLOSE.RATE_LIMIT, 'too many connections for this device');

    void this.admit(peer, ticket).catch((err) => {
      ctx.log.error({ err: (err as Error).message }, '中继准入检查出错');
      this.reject(peer, RELAY_CLOSE.MAINTENANCE, 'internal error');
    });
  }

  private reject(peer: Peer, code: number, reason: string): void {
    this.ctx.m.relayCloses.inc({ code });
    try {
      peer.ws.close(code, reason);
    } catch {
      peer.ws.terminate();
    }
    const t = setTimeout(() => peer.ws.terminate(), 2000);
    t.unref();
  }

  /** 票据一次性标记、日流量配额检查，然后配对 */
  private async admit(peer: Peer, ticket: Ticket): Promise<void> {
    const { ctx } = this;
    const { kv } = ctx.stores;
    // 票据只能用一次：session_id + 角色 在存储里做一次性标记，60 秒有效
    const fresh = await kv.setNx(`ticket:used:${ticket.sid}:${ticket.role}`, '1', 60_000);
    if (!fresh) return this.reject(peer, RELAY_CLOSE.TICKET_INVALID, 'ticket already used');
    // 单设备每日流量已超限：直接拒绝
    const used = Number((await kv.get(this.quotaKey(ticket.did))) ?? 0);
    if (used >= ctx.cfg.tunables.dailyQuotaBytes) return this.reject(peer, RELAY_CLOSE.QUOTA, 'daily quota exceeded');
    if (peer.ws.readyState !== WebSocket.OPEN || peer.closed) return;
    if (this.draining) return this.reject(peer, RELAY_CLOSE.MAINTENANCE, 'draining');

    const w = this.waiting.get(ticket.sid);
    if (!w) {
      // 等待配对的连接总数上限：配对对端迟迟不来的连接最多占用这么多
      if (this.waiting.size >= ctx.cfg.tunables.maxRelayWaiting) return this.reject(peer, RELAY_CLOSE.RATE_LIMIT, 'too many unpaired connections');
      peer.pairTimer = setTimeout(() => this.onPairTimeout(peer), ctx.cfg.tunables.pairTimeoutMs);
      this.waiting.set(ticket.sid, peer);
      return;
    }
    if (w.role === ticket.role) return this.reject(peer, RELAY_CLOSE.TICKET_INVALID, 'duplicate role');
    if (w.pairTimer) clearTimeout(w.pairTimer);
    w.pairTimer = null;
    this.waiting.delete(ticket.sid);
    this.pair(w, peer);
  }

  private quotaKey(did: string): string {
    return `quota:day:${did}:${utcDate()}`;
  }

  private onPairTimeout(peer: Peer): void {
    const sid = peer.ticket!.sid;
    if (this.waiting.get(sid) !== peer) return;
    this.waiting.delete(sid);
    peer.pairTimer = null;
    this.ctx.m.pairTimeouts.inc();
    this.publishEnded(sid, 'pair_timeout', 0, 0);
    void this.ctx.stores.tracker.remove(peer.ticket!.did, sid).catch(() => {});
    this.reject(peer, RELAY_CLOSE.PAIR_TIMEOUT, 'pair timeout');
  }

  private pair(a: Peer, b: Peer): void {
    const { ctx } = this;
    const t = ctx.cfg.tunables;
    const c = a.role === 'c' ? a : b;
    const h = a.role === 'c' ? b : a;
    const s: Session = { sid: a.ticket!.sid, c, h, bytesC2h: 0, bytesH2c: 0, closing: false };
    this.sessions.set(s.sid, s);
    for (const p of [c, h]) {
      p.session = s;
      // 单会话带宽：4MB/s，允许短时突发 8MB。两个方向各用一个令牌桶，互不挤占
      p.bucket = new TokenBucket(t.sessionBytesPerSec, t.sessionBurstBytes);
    }
    c.other = h;
    h.other = c;
    ctx.m.relaySessions.set(this.sessions.size);
    void this.touchTracker(s);
    this.publish({ type: 'paired', sid: s.sid, node: ctx.cfg.relay.nodeName, ts: Date.now() });
    // 把配对前缓存的数据按原顺序转发（同步完成，不会和后续消息交错）
    for (const p of [c, h]) {
      const buf = p.early;
      p.early = [];
      p.earlyBytes = 0;
      for (const m of buf) this.forward(p, m);
    }
  }

  // ---------- 转发 ----------

  private onMessage(peer: Peer, data: RawData, isBinary: boolean): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    peer.alive = true;
    if (!isBinary) return this.reject(peer, RELAY_CLOSE.BAD_MESSAGE, 'binary only');
    const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (buf.length > this.ctx.cfg.tunables.relayMaxMessage) return this.reject(peer, RELAY_CLOSE.BAD_MESSAGE, 'message too large');
    if (!peer.session) {
      // 还没配对（对端未到，或票据校验未完成）：缓存起来
      if (peer.early.length >= EARLY_MAX_MSGS || peer.earlyBytes + buf.length > EARLY_MAX_BYTES) {
        return this.reject(peer, RELAY_CLOSE.BAD_MESSAGE, 'too much data before pairing');
      }
      peer.early.push(buf);
      peer.earlyBytes += buf.length;
      return;
    }
    this.forward(peer, buf);
  }

  private forward(src: Peer, buf: Buffer): void {
    const s = src.session;
    const dst = src.other;
    if (!s || !dst || s.closing) return;
    const n = buf.length;
    if (src.role === 'c') s.bytesC2h += n;
    else s.bytesH2c += n;
    this.bytesWindow += n;
    this.ctx.m.relayBytes.inc({ dir: src.role === 'c' ? 'c2h' : 'h2c' }, n);

    // 流量配额：批量累加，超限则关闭整个会话（4005）
    src.quotaPending += n;
    if (src.quotaPending >= QUOTA_FLUSH_BYTES) void this.flushQuota(src);

    if (dst.ws.readyState === WebSocket.OPEN) {
      dst.ws.send(buf, { binary: true });
    }

    const { relayHighWater: HIGH, relayLowWater: LOW } = this.ctx.cfg.tunables;
    // 背压：对端发不出去（网络慢）时暂停读取源端，TCP 流控会把压力一路传回发送方，中继内存不会被撑大
    if (dst.ws.bufferedAmount > HIGH && !src.bpTimer) {
      this.pause(src, 'bp');
      src.bpTimer = setInterval(() => {
        if (dst.ws.readyState !== WebSocket.OPEN || src.ws.readyState !== WebSocket.OPEN) {
          this.stopBp(src);
          return;
        }
        if (dst.ws.bufferedAmount < LOW) this.stopBp(src);
      }, 20);
    }
    // 单会话带宽限速：令牌不够时暂停读取，等令牌恢复
    const wait = src.bucket!.take(n);
    if (wait > 0 && !src.rateTimer) {
      this.pause(src, 'rate');
      src.rateTimer = setTimeout(() => {
        src.rateTimer = null;
        this.resume(src, 'rate');
      }, wait);
    }
  }

  private stopBp(p: Peer): void {
    if (p.bpTimer) clearInterval(p.bpTimer);
    p.bpTimer = null;
    this.resume(p, 'bp');
  }

  private pause(p: Peer, why: 'bp' | 'rate'): void {
    const was = p.pauseReasons.size;
    p.pauseReasons.add(why);
    if (was === 0 && p.ws.readyState === WebSocket.OPEN) p.ws.pause();
  }

  private resume(p: Peer, why: 'bp' | 'rate'): void {
    p.pauseReasons.delete(why);
    if (p.pauseReasons.size === 0 && p.ws.readyState === WebSocket.OPEN) p.ws.resume();
  }

  private async flushQuota(p: Peer): Promise<void> {
    const n = p.quotaPending;
    if (n === 0 || !p.ticket) return;
    p.quotaPending = 0;
    try {
      const total = await this.ctx.stores.kv.incrBy(this.quotaKey(p.ticket.did), n, 48 * 3600_000);
      if (total >= this.ctx.cfg.tunables.dailyQuotaBytes && p.session && !p.quotaBlocked) {
        p.quotaBlocked = true;
        this.closeSession(p.session, RELAY_CLOSE.QUOTA, 'quota', 'daily quota exceeded');
      }
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, '写入流量配额失败');
    }
  }

  // ---------- 关闭 ----------

  private release(map: Map<string, number>, key: string | null): void {
    if (key === null) return;
    const n = (map.get(key) ?? 1) - 1;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }

  private onClose(peer: Peer): void {
    peer.closed = true;
    this.release(this.ipConns, peer.ipKey);
    this.release(this.didConns, peer.countedDid);
    peer.ipKey = peer.countedDid = null;
    if (peer.pairTimer) clearTimeout(peer.pairTimer);
    if (peer.bpTimer) clearInterval(peer.bpTimer);
    if (peer.rateTimer) clearTimeout(peer.rateTimer);
    peer.pairTimer = peer.bpTimer = null;
    peer.rateTimer = null;
    const t = peer.ticket;
    if (!t) return;
    if (this.waiting.get(t.sid) === peer) {
      // 还在等对端就自己走了
      this.waiting.delete(t.sid);
      this.publishEnded(t.sid, 'closed', 0, 0);
      void this.ctx.stores.tracker.remove(t.did, t.sid).catch(() => {});
      return;
    }
    const s = peer.session;
    if (s && !s.closing) {
      // 一端关闭，另一端也关闭（4003 对端已断开）
      this.closeSession(s, RELAY_CLOSE.PEER_GONE, 'closed', 'peer disconnected', peer);
    }
  }

  /** 结束一个会话：关闭两端（除 skip 外）、回传字节数、释放计数 */
  private closeSession(s: Session, code: number, reason: string, wsReason: string, skip?: Peer): void {
    if (s.closing) return;
    s.closing = true;
    for (const p of [s.c, s.h]) {
      if (p === skip) continue;
      this.stopBp(p);
      if (p.rateTimer) clearTimeout(p.rateTimer);
      p.rateTimer = null;
      this.reject(p, code, wsReason);
    }
    this.sessions.delete(s.sid);
    this.ctx.m.relaySessions.set(this.sessions.size);
    void this.flushQuota(s.c);
    void this.flushQuota(s.h);
    this.publishEnded(s.sid, reason, s.bytesC2h, s.bytesH2c);
    void this.ctx.stores.tracker.remove(s.c.ticket!.did, s.sid).catch(() => {});
    void this.ctx.stores.tracker.remove(s.h.ticket!.did, s.sid).catch(() => {});
  }

  private publishEnded(sid: string, reason: string, c2h: number, h2c: number): void {
    this.publish({ type: 'ended', sid, node: this.ctx.cfg.relay.nodeName, reason, bytesC2h: c2h, bytesH2c: h2c, ts: Date.now() });
  }

  private publish(ev: Parameters<BaseCtx['stores']['sessionEvents']['publish']>[0]): void {
    this.ctx.stores.sessionEvents.publish(ev).catch((err) => {
      this.ctx.log.warn({ err: (err as Error).message }, '回传会话事件失败');
    });
  }

  private async touchTracker(s: Session): Promise<void> {
    const { tracker } = this.ctx.stores;
    await tracker.touch(s.c.ticket!.did, s.sid, 90_000).catch(() => {});
    await tracker.touch(s.h.ticket!.did, s.sid, 90_000).catch(() => {});
  }

  // ---------- 优雅下线 ----------

  /**
   * 收到 SIGTERM 后：停止接受新配对，在注册表里标记“排空”；
   * 先等现有会话自然结束（最多 drainWaitSec，默认 0），然后对剩余连接发 4006，客户端会自动重连到其他节点，
   * 最多再等 drainGraceSec 秒让连接收尾，最后释放资源。
   */
  async shutdown(): Promise<void> {
    const { cfg, log, stores } = this.ctx;
    if (this.draining) return;
    this.draining = true;
    log.info({ sessions: this.sessions.size }, '中继开始排空');
    this.http.close();
    await this.report();

    const waitUntil = Date.now() + cfg.relay.drainWaitSec * 1000;
    while (this.sessions.size > 0 && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 200));

    for (const ws of this.wss.clients) {
      const peer = this.peerOf.get(ws);
      if (peer) this.reject(peer, RELAY_CLOSE.MAINTENANCE, 'server maintenance');
      else ws.close(RELAY_CLOSE.MAINTENANCE);
    }
    const graceUntil = Date.now() + cfg.relay.drainGraceSec * 1000;
    while (this.wss.clients.size > 0 && Date.now() < graceUntil) await new Promise((r) => setTimeout(r, 50));
    for (const ws of this.wss.clients) ws.terminate();

    for (const t of this.timers) clearInterval(t);
    await stores.registry.remove(cfg.relay.nodeName).catch(() => {});
    this.wss.close();
    this.http.closeAllConnections();
    log.info('中继已退出排空');
  }

  /** 当前带宽使用率（测试和指标用） */
  get bandwidth(): number {
    return this.lastBandwidth;
  }
}
