/**
 * 控制端的终端表与按偏移去重（对应 Rust controller/term.rs，纯逻辑，不做 IO）。
 *
 * 对每个终端维护：
 * - received：已经交给界面的输出流偏移（重连后作为 TermAttach.last_seq）；
 * - rendered：界面通过 term_ack 告知的已渲染偏移；
 * - 通道号：被控端分配，只在当前这条连接内有效，重连后要重新附着才有新的通道号。
 */

/** 终端复位序列（ESC c）。被控端在回放无法衔接时先发它。 */
export const RESET_SEQ = Uint8Array.of(0x1b, 0x63);

export interface TermSize {
  cols: number;
  rows: number;
}

export type Dedup = { drop: true } | { drop: false; seq: number; data: Uint8Array };

const isReset = (d: Uint8Array): boolean => d.length === 2 && d[0] === RESET_SEQ[0] && d[1] === RESET_SEQ[1];

/**
 * 按偏移裁剪一段输出：
 * - end <= received：整段重复，丢弃；
 * - seq < received < end：与已收部分重叠，裁掉前面的重叠；
 * - seq >= received：正常衔接（seq > received 说明被控端的缓冲已覆盖了中间的数据，原样交出）；
 * - 例外：附着后的第一段如果恰好是复位序列且跨过 received，原样交出，否则裁剪会留下半个转义序列。
 */
export function dedup(received: number, seq: number, data: Uint8Array, firstAfterAttach: boolean): Dedup {
  if (data.length === 0) return { drop: true };
  const end = seq + data.length;
  if (firstAfterAttach && isReset(data) && seq < received && end > received) return { drop: false, seq, data };
  if (end <= received) return { drop: true };
  if (seq >= received) return { drop: false, seq, data };
  return { drop: false, seq: received, data: data.subarray(received - seq) };
}

export interface TermEntry {
  id: string;
  /** 当前连接里的通道号；未附着时为 null */
  channel: number | null;
  size: TermSize;
  received: number;
  rendered: number;
  /** 已经告知被控端的确认偏移 */
  ackedSent: number;
  exited: boolean;
  /** 被另一个会话接管（收到 TERM_DETACHED）；重连时不再自动附着 */
  takenElsewhere: boolean;
  /** 附着时被拒绝（TERM_BUSY）；不抢占 */
  busy: boolean;
  /** 刚附着，还没收到第一段输出 */
  freshAttach: boolean;
}

export class TermTable {
  private byId = new Map<string, TermEntry>();
  private byChannel = new Map<number, string>();

  get(id: string): TermEntry | undefined {
    return this.byId.get(id);
  }

  idOfChannel(ch: number): string | undefined {
    return this.byChannel.get(ch);
  }

  /** 附着成功：登记通道号。终端不存在则新建（偏移从 0 开始） */
  onAttached(id: string, channel: number, size: TermSize): void {
    const old = this.byId.get(id)?.channel;
    if (old !== undefined && old !== null) this.byChannel.delete(old);
    let e = this.byId.get(id);
    if (!e) {
      e = { id, channel: null, size, received: 0, rendered: 0, ackedSent: 0, exited: false, takenElsewhere: false, busy: false, freshAttach: false };
      this.byId.set(id, e);
    }
    e.channel = channel;
    e.size = size;
    e.freshAttach = true;
    e.takenElsewhere = false;
    e.busy = false;
    // 被控端以 last_seq（= received）作为确认基准
    e.ackedSent = e.received;
    this.byChannel.set(channel, id);
  }

  remove(id: string): TermEntry | undefined {
    const e = this.byId.get(id);
    if (!e) return undefined;
    this.byId.delete(id);
    if (e.channel !== null) this.byChannel.delete(e.channel);
    return e;
  }

  /** 连接断开：所有通道号作废，终端记录保留（偏移用于重连续传） */
  dropChannels(): void {
    this.byChannel.clear();
    for (const e of this.byId.values()) {
      e.channel = null;
      e.freshAttach = false;
    }
  }

  markTaken(id: string): void {
    const e = this.byId.get(id);
    if (!e) return;
    if (e.channel !== null) this.byChannel.delete(e.channel);
    e.channel = null;
    e.takenElsewhere = true;
  }

  markBusy(id: string): void {
    const e = this.byId.get(id);
    if (e) e.busy = true;
  }

  /** 重连后需要重新附着的终端：已退出和被接管的不在其中 */
  resumable(): Array<{ id: string; lastSeq: number; size: TermSize }> {
    return [...this.byId.values()]
      .filter((e) => !e.exited && !e.takenElsewhere)
      .map((e) => ({ id: e.id, lastSeq: e.received, size: e.size }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 收到一段输出：按偏移去重后返回需要交给界面的 (终端, seq, 数据) */
  onOutput(ch: number, seq: number, data: Uint8Array): { term: string; seq: number; data: Uint8Array } | null {
    const id = this.byChannel.get(ch);
    const e = id ? this.byId.get(id) : undefined;
    if (!id || !e) return null;
    const first = e.freshAttach;
    e.freshAttach = false;
    const r = dedup(e.received, seq, data, first);
    if (r.drop) return null;
    e.received = r.seq + r.data.length;
    return { term: id, seq: r.seq, data: r.data };
  }

  /** 界面确认已渲染到 consumed。返回需要发给被控端的 (通道号, 确认偏移)；没有新进展或未附着时返回 null */
  noteRendered(id: string, consumed: number): { channel: number; offset: number } | null {
    const e = this.byId.get(id);
    if (!e) return null;
    const c = Math.min(consumed, e.received);
    if (c > e.rendered) e.rendered = c;
    if (e.channel === null) return null;
    if (e.rendered > e.ackedSent) {
      e.ackedSent = e.rendered;
      return { channel: e.channel, offset: e.rendered };
    }
    return null;
  }
}
