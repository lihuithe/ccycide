import type { KvStore } from '../store/index.js';

/** 锁定与枚举检测的参数，默认值来自实现方案 17.1 与 6.6 */
export const GUARD = {
  /** 密码错误：10 分钟内 5 次 -> 锁定 10 分钟，重复触发翻倍，上限 24 小时 */
  failWindowMs: 10 * 60_000,
  failThreshold: 5,
  lockBaseSec: 10 * 60,
  lockMaxSec: 24 * 3600,
  /** 锁定级别的保留时间：从最近一次触发锁定算起，7 天内没有再次失败才衰减。必须远大于 lockMaxSec，否则封顶锁定一结束级别就归零（安全审查 M4） */
  levelResetMs: 7 * 24 * 3600_000,
  /** 枚举：10 分钟内请求不存在的设备码 20 次 -> 封禁 1 小时 */
  missWindowMs: 10 * 60_000,
  missThreshold: 20,
  missBanSec: 3600,
};

export interface LockInfo {
  until: number;
  reason: string;
}

/**
 * 被控端锁定标记（lock:host:{device_code}）、密码失败计数、枚举计数。
 * 全部放 KvStore（Redis 或内存），多实例共享。
 */
export class Guard {
  constructor(private kv: KvStore) {}

  async getLock(code: string): Promise<LockInfo | null> {
    const raw = await this.kv.get(`lock:host:${code}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LockInfo;
    } catch {
      return { until: Date.now(), reason: 'unknown' };
    }
  }

  async lockHost(code: string, sec: number, reason: string): Promise<LockInfo> {
    const s = Math.max(1, Math.min(Math.floor(sec), GUARD.lockMaxSec));
    const info: LockInfo = { until: Date.now() + s * 1000, reason };
    await this.kv.set(`lock:host:${code}`, JSON.stringify(info), s * 1000);
    return info;
  }

  async unlockHost(code: string): Promise<void> {
    await this.kv.del(`lock:host:${code}`);
    await this.kv.del(`authfail:${code}`);
    await this.kv.del(`locklevel:${code}`);
  }

  /**
   * 记录一次密码失败。达到阈值时服务端自己也锁定该被控端（信令侧拒绝新连接），
   * 锁定时长随触发次数翻倍。返回是否触发了锁定及锁定时长。
   */
  async recordAuthFailure(code: string): Promise<{ count: number; locked: boolean; lockSec: number }> {
    const count = await this.kv.incrBy(`authfail:${code}`, 1, GUARD.failWindowMs);
    if (count < GUARD.failThreshold) return { count, locked: false, lockSec: 0 };
    const prev = Number((await this.kv.get(`locklevel:${code}`)) ?? 0);
    const level = prev + 1;
    await this.kv.set(`locklevel:${code}`, String(level), GUARD.levelResetMs);
    const lockSec = Math.min(GUARD.lockBaseSec * 2 ** (level - 1), GUARD.lockMaxSec);
    await this.lockHost(code, lockSec, 'auth_failed');
    await this.kv.del(`authfail:${code}`);
    return { count, locked: true, lockSec };
  }

  /** 记录一次“请求不存在/不在线的设备码”，返回是否达到封禁阈值 */
  async recordMiss(deviceUid: string): Promise<{ count: number; ban: boolean }> {
    const count = await this.kv.incrBy(`miss:${deviceUid}`, 1, GUARD.missWindowMs);
    if (count < GUARD.missThreshold) return { count, ban: false };
    await this.kv.del(`miss:${deviceUid}`);
    return { count, ban: true };
  }
}
