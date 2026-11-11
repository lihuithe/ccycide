import type { Redis } from 'ioredis';
import type { PresenceInfo, PresenceStore } from './types.js';

const key = (code: string): string => `presence:${code}`;

function toHash(i: PresenceInfo): Record<string, string> {
  return {
    instanceId: i.instanceId,
    connId: i.connId,
    deviceId: String(i.deviceId),
    deviceUid: i.deviceUid,
    deviceCode: i.deviceCode,
    accept: i.accept ? '1' : '0',
    protoVer: String(i.protoVer),
    minProtoVer: String(i.minProtoVer),
    platform: i.platform,
    publicKey: i.publicKey,
    appVersion: i.appVersion,
    ip: i.ip,
    region: i.region,
  };
}

function fromHash(h: Record<string, string>): PresenceInfo | null {
  if (!h || !h.connId || !h.instanceId) return null;
  return {
    instanceId: h.instanceId,
    connId: h.connId,
    deviceId: Number(h.deviceId),
    deviceUid: h.deviceUid ?? '',
    deviceCode: h.deviceCode ?? '',
    accept: h.accept === '1',
    protoVer: Number(h.protoVer ?? 1),
    minProtoVer: Number(h.minProtoVer ?? 1),
    platform: h.platform ?? '',
    publicKey: h.publicKey ?? '',
    appVersion: h.appVersion ?? '',
    ip: h.ip ?? '',
    region: h.region ?? '',
  };
}

// 仅当 connId 匹配时执行。KEYS[1]=键，ARGV[1]=connId，ARGV[2]=动作，ARGV[3]=ttl 秒，ARGV[4]=值
const GUARDED = `
local cur = redis.call('HGET', KEYS[1], 'connId')
if cur ~= ARGV[1] then return 0 end
if ARGV[2] == 'del' then redis.call('DEL', KEYS[1]) return 1 end
if ARGV[2] == 'accept' then redis.call('HSET', KEYS[1], 'accept', ARGV[4]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

/** Redis 实现：presence:{device_code} Hash，有效期 90 秒，每次心跳续期 */
export class RedisPresenceStore implements PresenceStore {
  constructor(
    private redis: Redis,
    private ttlSec = 90,
  ) {}

  async set(code: string, info: PresenceInfo): Promise<PresenceInfo | null> {
    // MULTI 内先读旧值再覆盖，保证“读旧-写新”原子
    const res = await this.redis
      .multi()
      .hgetall(key(code))
      .del(key(code))
      .hset(key(code), toHash(info))
      .expire(key(code), this.ttlSec)
      .exec();
    const old = res?.[0]?.[1] as Record<string, string> | undefined;
    return old && Object.keys(old).length > 0 ? fromHash(old) : null;
  }

  async get(code: string): Promise<PresenceInfo | null> {
    const h = await this.redis.hgetall(key(code));
    return Object.keys(h).length > 0 ? fromHash(h) : null;
  }

  async refresh(code: string, connId: string): Promise<boolean> {
    return (await this.redis.eval(GUARDED, 1, key(code), connId, 'refresh', this.ttlSec, '')) === 1;
  }

  async setAccept(code: string, connId: string, accept: boolean): Promise<boolean> {
    return (await this.redis.eval(GUARDED, 1, key(code), connId, 'accept', this.ttlSec, accept ? '1' : '0')) === 1;
  }

  async remove(code: string, connId: string): Promise<boolean> {
    return (await this.redis.eval(GUARDED, 1, key(code), connId, 'del', this.ttlSec, '')) === 1;
  }

  async count(): Promise<number> {
    let n = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 1000);
      cursor = next;
      n += keys.length;
    } while (cursor !== '0');
    return n;
  }
}
