import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { DeviceRecord } from '../db/repos/index.js';

export type ConnState = 'wait_auth' | 'ready' | 'closed';

/** 一条信令连接的状态与发送方法 */
export class Conn {
  readonly id = randomBytes(8).toString('hex');
  state: ConnState = 'wait_auth';
  readonly nonce = randomBytes(32).toString('base64');
  device?: DeviceRecord;
  appVersion = '';
  protoVer = 1;
  minProtoVer = 1;
  /** 是否被主动踢掉/封禁（之后不再处理任何消息） */
  dead = false;
  lastSeen = Date.now();
  /** 同一连接上的消息必须按序处理：auth 之后紧跟的消息要等 auth 完成 */
  chain: Promise<void> = Promise.resolve();
  /** 本连接作为主控端、正在等待被控端处理的会话。等待期间不按“45 秒无消息”断开 */
  readonly pendingSessions = new Set<string>();
  /** 协议层 ping 的存活标记：两轮扫描内没回 pong 就断开 */
  alive = true;
  msgWindowStart = Date.now();
  msgCount = 0;

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
  ) {}

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(t: string, d: unknown = {}, id?: string): void {
    if (!this.open) return;
    // 对端读得太慢，发送缓冲堆到 1MB 就直接断开，避免撑大内存
    if (this.ws.bufferedAmount > 1024 * 1024) {
      this.ws.terminate();
      return;
    }
    const m: { t: string; id?: string; d: unknown } = { t, d };
    if (id !== undefined) m.id = id;
    this.ws.send(JSON.stringify(m));
  }

  close(code: number, reason = ''): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, reason.slice(0, 100));
      } catch {
        this.ws.terminate();
      }
      // 对端不配合关闭时强制断开
      const t = setTimeout(() => this.ws.terminate(), 2000);
      t.unref();
    }
  }
}
