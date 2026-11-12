import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Ctx } from '../context.js';
import { newUlid } from '../crypto.js';
import { WriteQueue } from '../db/repos/resilient.js';
import type { BusMessage, PresenceInfo } from '../store/index.js';
import { clientIp, rateKeyIp } from '../util/ip.js';
import { every } from '../util/time.js';
import { Conn, type ConnState } from './conn.js';
import { dispatch, handleAuth, resolvePending, type Pending } from './handlers.js';
import { CLOSE, SIGNAL_PATH, metricMsgType, parseMsg } from './protocol.js';
import { applyRelayEvent } from './sessions.js';

/** 供管理接口调用的控制面 */
export interface SignalControl {
  /** 踢掉某设备码当前的连接（可跨实例） */
  kickDevice(code: string, reason: string): Promise<void>;
  /** 向所有在线设备（或指定设备码）发 notice */
  sendNotice(level: string, text: string, code?: string): Promise<void>;
  onlineCount(): Promise<number>;
  localConnCount(): number;
}

/** 被控端所在实例上记录的“来自其他实例的待处理请求”：用于把答复转回去，以及判断主控端那边是否已经丢失 */
interface RemoteSession {
  origin: string;
  hostDeviceId: number;
  hostUid: string;
  /** 收到 connect.incoming 的被控端连接 */
  connId: string;
  controllerCode: string;
  controllerConnId: string;
  timer: NodeJS.Timeout;
}

export class SignalServer implements SignalControl {
  readonly instanceId = newUlid();
  readonly conns = new Map<string, Conn>();
  /** 设备码 -> 本实例上的连接 */
  readonly byCode = new Map<string, Conn>();
  /** 会话 ID -> 等待被控端答复的请求（在主控端所在实例上） */
  readonly pending = new Map<string, Pending>();
  /** 会话 ID -> 来源实例（被控端所在实例上，用于把答复转回去） */
  readonly remote = new Map<string, RemoteSession>();
  /** 设备 uid -> 上次写 last_seen_at 的时间 */
  readonly lastTouch = new Map<string, number>();
  private ipCounts = new Map<string, number>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => Promise<void>) | null = null;
  private stopEvents: (() => void) | null = null;
  private eventQueue: WriteQueue;
  private closing = false;
  private cleanups = new Set<Promise<void>>();
  private sweepingPending = false;
  /** 已配对、尚未结束的会话数（由中继事件推算），用于统计峰值 */
  activeSessions = 0;

  constructor(readonly ctx: Ctx) {
    this.eventQueue = new WriteQueue(ctx.log, 10_000, 2000);
  }

  /** 订阅跨实例消息、启动定时器、开始消费中继事件 */
  async start(): Promise<void> {
    const { ctx } = this;
    this.unsubscribe = await ctx.stores.bus.subscribe(this.instanceId, (m) => {
      void this.onBus(m).catch((err) => ctx.log.error({ err }, '处理跨实例消息出错'));
    });
    this.timers.push(every(ctx.cfg.tunables.idleSweepMs, () => this.sweepIdle()));
    this.timers.push(every(ctx.cfg.tunables.pendingCheckMs, () => void this.sweepPending()));
    this.stopEvents = ctx.stores.sessionEvents.consume(async (ev) => {
      if (ev.type === 'paired') this.activeSessions++;
      else if (ev.type === 'ended') this.activeSessions = Math.max(0, this.activeSessions - 1);
      ctx.collector.observeSessions(this.activeSessions);
      ctx.m.relaySessions.set(this.activeSessions);
      // 数据库暂时不可用时进补写队列按序重试，不能丢（否则会话状态卡住、字节数记不上）
      await this.eventQueue.run(() => applyRelayEvent(ctx, ev), 'relay.event');
    });
  }

  /** 把本服务挂到 HTTP 服务器的 upgrade 事件上 */
  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  private reject(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== SIGNAL_PATH) return this.reject(socket, '404 Not Found');
    if (this.closing) return this.reject(socket, '503 Service Unavailable');
    socket.on('error', () => {});
    const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], this.ctx.trust);
    // 同一 IP 同时最多 50 条信令连接
    if ((this.ipCounts.get(rateKeyIp(ip)) ?? 0) >= this.ctx.cfg.tunables.maxSignalConnsPerIp) {
      return this.reject(socket, '429 Too Many Requests');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const { ctx } = this;
    const t = ctx.cfg.tunables;
    const conn = new Conn(ws, ip);
    this.conns.set(conn.id, conn);
    // 同一来源（IPv6 按 /64 归一）的并发连接数
    const ipKey = rateKeyIp(ip);
    this.ipCounts.set(ipKey, (this.ipCounts.get(ipKey) ?? 0) + 1);
    ctx.m.signalConns.set(this.conns.size);

    // 必须监听 error，否则未处理的 error 事件会让进程退出
    ws.on('error', () => {});
    ws.on('pong', () => {
      conn.alive = true;
    });

    conn.send('hello', { nonce: conn.nonce, server_time: Math.floor(Date.now() / 1000) });

    // 超时不认证就断开
    const authTimer = setTimeout(() => {
      if (conn.state === 'wait_auth') conn.close(CLOSE.AUTH, 'auth timeout');
    }, t.authTimeoutMs);
    authTimer.unref();

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return conn.close(CLOSE.BAD_MESSAGE, 'text only');
      conn.lastSeen = Date.now();
      // 单连接消息速率限制：每 10 秒最多 maxMsgsPer10s 条
      if (conn.lastSeen - conn.msgWindowStart > 10_000) {
        conn.msgWindowStart = conn.lastSeen;
        conn.msgCount = 0;
      }
      if (++conn.msgCount > t.maxMsgsPer10s) return conn.close(CLOSE.TOO_MANY, 'too many messages');
      const msg = parseMsg(raw.toString());
      if (!msg) return conn.close(CLOSE.BAD_MESSAGE, 'bad message');
      // 同一连接的消息串行处理
      conn.chain = conn.chain.then(async () => {
        if (conn.state === 'closed' || conn.dead) return;
        try {
          if (conn.state === 'wait_auth') {
            if (msg.t !== 'auth') return conn.close(CLOSE.AUTH, 'auth required');
            await handleAuth(this, conn, msg);
            if ((conn.state as ConnState) === 'ready') clearTimeout(authTimer);
            return;
          }
          // 认证通过之后才按类型计数，类型走白名单，未知类型记为 other
          ctx.m.signalMessages.inc({ t: metricMsgType(msg.t) });
          await dispatch(this, conn, msg);
        } catch (err) {
          ctx.log.error({ err, t: msg.t }, '处理消息出错');
          conn.send('error', { code: 'INTERNAL' }, msg.id);
        }
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      conn.state = 'closed';
      this.conns.delete(conn.id);
      const n = (this.ipCounts.get(ipKey) ?? 1) - 1;
      if (n <= 0) this.ipCounts.delete(ipKey);
      else this.ipCounts.set(ipKey, n);
      ctx.m.signalConns.set(this.conns.size);
      const job: Promise<void> = this.cleanup(conn)
        .catch((err) => ctx.log.warn({ err: (err as Error).message }, '清理连接状态出错'))
        .finally(() => this.cleanups.delete(job));
      this.cleanups.add(job);
    });
  }

  private async cleanup(conn: Conn): Promise<void> {
    const dev = conn.device;
    if (!dev) return;
    if (this.byCode.get(dev.code) === conn) this.byCode.delete(dev.code);
    // 只在 connId 匹配时删除，避免旧连接关闭时把新连接的在线状态删掉
    await this.ctx.stores.presence.remove(dev.code, conn.id);
    this.ctx.m.onlineDevices.set(this.byCode.size);
    // 主控端断开：它名下等待被控端处理的请求作废，并通知被控端撤掉确认弹窗
    for (const p of [...this.pending.values()]) {
      if (p.controller === conn) await resolvePending(this, p, 'fail', 'controller_gone');
    }
    // 被控端断开（含被同一设备的新连接顶替、心跳超时）：主控端收到 UNAVAILABLE
    for (const p of [...this.pending.values()]) {
      if (p.hostInstanceId === this.instanceId && p.hostConnId === conn.id) await resolvePending(this, p, 'reject', 'host_gone');
    }
    // 来自其他实例的请求：通知来源实例；消息发不出去时由对方的定期检查兜底
    for (const [sid, r] of [...this.remote]) {
      if (r.connId !== conn.id) continue;
      clearTimeout(r.timer);
      this.remote.delete(sid);
      await this.ctx.stores.bus
        .publish(r.origin, { k: 'reply', sid, hostDeviceId: r.hostDeviceId, action: 'reject', reason: 'host_gone' })
        .catch((e) => this.ctx.log.warn({ err: (e as Error).message }, '通知来源实例被控端已断开失败'));
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    const limit = this.ctx.cfg.tunables.idleTimeoutMs;
    for (const c of this.conns.values()) {
      // 正在等被控端确认的主控连接不按“无消息”断开（确认可能要等很久）；
      // 其余连接按 45 秒无消息断开
      if (c.pendingSessions.size === 0 && now - c.lastSeen > limit) {
        c.close(CLOSE.IDLE_TIMEOUT, 'idle timeout');
        continue;
      }
      // 所有连接另有协议层存活检测：两轮扫描内没回 pong 就是半开连接，直接断开
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
    this.ctx.collector.observeOnline(this.byCode.size);
  }

  // ---------- 投递 ----------

  /**
   * 向被控端投递 connect.incoming：本实例直接发，其他实例走总线。
   * 返回 false 表示确定没送到（连接已不在、目标实例已退出）；总线不可用时抛出异常。调用方据此立即给主控端返回错误。
   */
  async deliverIncoming(target: PresenceInfo, sid: string, payload: unknown, controller: { code: string; connId: string }): Promise<boolean> {
    if (target.instanceId === this.instanceId) {
      const c = this.byCode.get(target.deviceCode);
      if (!c || c.id !== target.connId || c.state !== 'ready') return false;
      c.send('connect.incoming', payload);
      return true;
    }
    const receivers = await this.ctx.stores.bus.publish(target.instanceId, {
      k: 'incoming',
      origin: this.instanceId,
      sid,
      hostCode: target.deviceCode,
      hostDeviceId: target.deviceId,
      controllerCode: controller.code,
      controllerConnId: controller.connId,
      payload,
    });
    return receivers > 0;
  }

  /** 向这条等待项对应的被控端连接投递 connect.go / connect.cancelled（被控端可能在其他实例上） */
  async toHost(p: Pick<Pending, 'sid' | 'hostCode' | 'hostInstanceId' | 'hostConnId'>, t: 'connect.go' | 'connect.cancelled', d: unknown): Promise<void> {
    if (p.hostInstanceId === this.instanceId) {
      const c = this.conns.get(p.hostConnId);
      if (c && c.state === 'ready') c.send(t, d);
      return;
    }
    await this.ctx.stores.bus.publish(p.hostInstanceId, { k: 'tohost', code: p.hostCode, connId: p.hostConnId, sid: p.sid, t, d });
  }

  private async onBus(m: BusMessage): Promise<void> {
    switch (m.k) {
      case 'incoming': {
        const c = this.byCode.get(m.hostCode);
        if (!c || c.state !== 'ready' || c.device?.id !== m.hostDeviceId) {
          await this.ctx.stores.bus.publish(m.origin, { k: 'reply', sid: m.sid, hostDeviceId: m.hostDeviceId, action: 'reject', reason: 'host_gone' });
          return;
        }
        const timer = setTimeout(() => this.remote.delete(m.sid), this.ctx.cfg.tunables.connectPendingMaxSec * 1000 + 5000);
        timer.unref();
        this.remote.set(m.sid, {
          origin: m.origin,
          hostDeviceId: m.hostDeviceId,
          hostUid: c.device.uid,
          connId: c.id,
          controllerCode: m.controllerCode,
          controllerConnId: m.controllerConnId,
          timer,
        });
        c.send('connect.incoming', m.payload);
        return;
      }
      case 'tohost': {
        if (m.t !== 'connect.go' && m.t !== 'connect.cancelled') return;
        const c = this.conns.get(m.connId);
        if (c && c.state === 'ready') c.send(m.t, m.d);
        const r = this.remote.get(m.sid);
        if (r) {
          clearTimeout(r.timer);
          this.remote.delete(m.sid);
        }
        return;
      }
      case 'reply': {
        const p = this.pending.get(m.sid);
        if (!p || p.hostDeviceId !== m.hostDeviceId) return;
        await resolvePending(this, p, m.action, m.reason);
        return;
      }
      case 'kick': {
        const c = this.conns.get(m.connId);
        if (c) this.kickConn(c, m.reason);
        return;
      }
      case 'notice': {
        if (m.code) this.byCode.get(m.code)?.send('notice', { level: m.level, text: m.text });
        else for (const c of this.byCode.values()) c.send('notice', { level: m.level, text: m.text });
        return;
      }
    }
  }

  /**
   * 定期检查挂起请求的双方是否还在，兜底处理 Pub/Sub 不持久化造成的消息丢失、对方实例退出、presence 过期：
   *  - 主控端所在实例（pending 在这里）：被控端的在线状态没了或换成了别的连接 -> 主控端收 connect.err UNAVAILABLE
   *  - 被控端所在实例（remote 在这里）：主控端的在线状态没了、换了连接，或主控端那边的等待已经结束 -> 撤掉被控端的确认弹窗
   * 存储暂时不可用时什么都不做，下一轮再查（不能因为 Redis 抖动误杀正在等待的请求）。
   */
  private async sweepPending(): Promise<void> {
    if (this.sweepingPending || this.closing) return;
    this.sweepingPending = true;
    try {
      const { presence, tracker } = this.ctx.stores;
      for (const p of [...this.pending.values()]) {
        try {
          const hp = await presence.get(p.hostCode);
          if (!hp || hp.connId !== p.hostConnId) await resolvePending(this, p, 'reject', 'host_gone');
        } catch {
          /* 存储不可用，下一轮再查 */
        }
      }
      for (const [sid, r] of [...this.remote]) {
        try {
          const cp = await presence.get(r.controllerCode);
          const alive = cp !== null && cp.connId === r.controllerConnId && (await tracker.has(`hp:${r.hostUid}`, sid));
          if (alive) continue;
          clearTimeout(r.timer);
          this.remote.delete(sid);
          const c = this.conns.get(r.connId);
          if (c && c.state === 'ready') c.send('connect.cancelled', { session_id: sid });
        } catch {
          /* 存储不可用，下一轮再查 */
        }
      }
    } finally {
      this.sweepingPending = false;
    }
  }

  /** 被控端答复的入口（handlers 调用）：本实例有等待项则直接处理，否则转发回来源实例 */
  async routeHostReply(conn: Conn, action: 'accept' | 'reject', sid: string, reason?: string): Promise<void> {
    const dev = conn.device!;
    const p = this.pending.get(sid);
    if (p) {
      // 只有目标设备本人能答复，其他人冒充一律忽略
      if (p.hostDeviceId !== dev.id) return;
      await resolvePending(this, p, action, reason);
      return;
    }
    const r = this.remote.get(sid);
    if (r && r.hostDeviceId === dev.id) {
      clearTimeout(r.timer);
      this.remote.delete(sid);
      let receivers = 0;
      try {
        receivers = await this.ctx.stores.bus.publish(r.origin, { k: 'reply', sid, hostDeviceId: dev.id, action, reason });
      } catch (e) {
        this.ctx.log.warn({ err: (e as Error).message }, '转发被控端答复失败');
      }
      // 答复没有送到（来源实例已退出或总线不可用）：撤掉被控端的弹窗，不让它一直等 connect.go
      if (receivers === 0) conn.send('connect.cancelled', { session_id: sid });
    }
  }

  /** 给某条本实例连接发 kick 并关闭 */
  kickConn(c: Conn, reason: string): void {
    c.dead = true;
    c.send('kick', { reason });
    const code = reason === 'replaced' ? CLOSE.REPLACED : reason === 'banned' ? CLOSE.BANNED : CLOSE.GOING_AWAY;
    c.close(code, reason);
  }

  // ---------- 控制面 ----------

  async kickDevice(code: string, reason: string): Promise<void> {
    const local = this.byCode.get(code);
    if (local) this.kickConn(local, reason);
    const p = await this.ctx.stores.presence.get(code);
    if (p && p.instanceId !== this.instanceId) {
      await this.ctx.stores.bus.publish(p.instanceId, { k: 'kick', code, connId: p.connId, reason });
    }
  }

  async sendNotice(level: string, text: string, code?: string): Promise<void> {
    await this.ctx.stores.bus.broadcast({ k: 'notice', level, text, code });
  }

  onlineCount(): Promise<number> {
    return this.ctx.stores.presence.count();
  }

  localConnCount(): number {
    return this.conns.size;
  }

  /** 优雅停止：不再接受新连接，通知并关闭现有连接，停掉定时器 */
  async stop(): Promise<void> {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.stopEvents?.();
    this.eventQueue.stop();
    for (const c of this.conns.values()) c.close(CLOSE.GOING_AWAY, 'server shutdown');
    // 等待连接关闭（最多 3 秒）
    const deadline = Date.now() + 3000;
    while (this.conns.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    for (const c of this.conns.values()) c.ws.terminate();
    // 等连接关闭触发的清理跑完（通知对端实例撤销 / 失败），再处理还剩下的等待项
    await Promise.race([Promise.allSettled([...this.cleanups]), new Promise((r) => setTimeout(r, 2000))]);
    for (const p of [...this.pending.values()]) await resolvePending(this, p, 'fail', 'server_shutdown').catch(() => {});
    for (const r of this.remote.values()) clearTimeout(r.timer);
    this.remote.clear();
    await this.unsubscribe?.();
    this.wss.close();
  }
}
