import { BlockList, isIP } from 'node:net';

/** 把 ::ffff:1.2.3.4 之类的 IPv4 映射地址还原成 IPv4，其余原样返回 */
export function normalizeIp(ip: string): string {
  let s = ip.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) return m[1]!;
  return s.toLowerCase();
}

/**
 * 限流用的来源键（安全审查 M1）：IPv4 原样；IPv4 映射的 IPv6 还原为 IPv4；
 * 其余 IPv6 取前 64 位（/64）并写成 `xxxx:xxxx:xxxx:xxxx::/64`。
 * 拥有一个 /64 的攻击者有 2^64 个地址，按完整地址计数等于没有限流。
 * 只用于限流和并发连接计数；存库、封禁匹配仍用真实地址。
 */
export function rateKeyIp(ip: string): string {
  const s = normalizeIp(ip);
  if (isIP(s) !== 6) return s;
  const buf = ipToBuffer(s);
  if (!buf || buf.length !== 16) return s;
  // ::ffff:7f00:1 这种十六进制写法的 IPv4 映射地址同样还原
  if (buf.subarray(0, 10).every((b) => b === 0) && buf[10] === 0xff && buf[11] === 0xff) return [...buf.subarray(12)].join('.');
  const g = (i: number): string => buf.readUInt16BE(i * 2).toString(16);
  return `${g(0)}:${g(1)}:${g(2)}:${g(3)}::/64`;
}

/**
 * 封禁一个来源时用的记录（安全审查 M1 遗留项）：IPv4 封单个地址（kind=ip），
 * IPv6 封所在的 /64（kind=cidr）。只封单个 IPv6 地址等于没封：同一 /64 内换地址即可绕过。
 */
export function banTargetFor(ip: string): { kind: 'ip' | 'cidr'; value: string } {
  const key = rateKeyIp(ip);
  return key.endsWith('::/64') ? { kind: 'cidr', value: key } : { kind: 'ip', value: key };
}

/** IP 文本 -> VARBINARY(16) 存储格式（IPv4 为 4 字节，IPv6 为 16 字节）；非法返回 null */
export function ipToBuffer(ip: string | null | undefined): Buffer | null {
  if (!ip) return null;
  const s = normalizeIp(ip);
  const fam = isIP(s);
  if (fam === 4) {
    return Buffer.from(s.split('.').map((x) => Number(x)));
  }
  if (fam === 6) {
    // 展开 "::" 与内嵌的 IPv4 尾巴
    let head = s;
    let tail4: number[] = [];
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(head);
    if (v4) {
      tail4 = v4[1]!.split('.').map((x) => Number(x));
      head = head.slice(0, head.length - v4[1]!.length) + '0:0';
    }
    const [l, r] = head.split('::');
    const left = l ? l.split(':') : [];
    const right = r !== undefined && r !== '' ? r.split(':') : [];
    const missing = 8 - left.length - right.length;
    const groups = head.includes('::') ? [...left, ...Array(missing).fill('0'), ...right] : left;
    const buf = Buffer.alloc(16);
    groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
    if (tail4.length === 4) tail4.forEach((b, i) => (buf[12 + i] = b));
    return buf;
  }
  return null;
}

/** VARBINARY(16) -> IP 文本 */
export function bufferToIp(buf: Buffer | null | undefined): string | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length === 4) return [...buf].join('.');
  if (buf.length === 16) {
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
    return parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
  }
  return null;
}

/** 判断 ip 是否落在 cidr（如 10.0.0.0/8 或 2001:db8::/32）里；非法输入返回 false */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, lenStr] = cidr.split('/');
  if (!base) return false;
  const n = normalizeIp(ip);
  const fam = isIP(n);
  const baseFam = isIP(normalizeIp(base));
  if (!fam || !baseFam || fam !== baseFam) return false;
  const bl = new BlockList();
  try {
    if (lenStr === undefined) bl.addAddress(normalizeIp(base), fam === 4 ? 'ipv4' : 'ipv6');
    else bl.addSubnet(normalizeIp(base), Number(lenStr), fam === 4 ? 'ipv4' : 'ipv6');
    return bl.check(n, fam === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return false;
  }
}

/** 校验 CIDR / 单个 IP 的写法 */
export function isValidIpOrCidr(v: string): boolean {
  const [base, len] = v.split('/');
  if (!base) return false;
  const fam = isIP(normalizeIp(base));
  if (!fam) return false;
  if (len === undefined) return true;
  const n = Number(len);
  return Number.isInteger(n) && n >= 0 && n <= (fam === 4 ? 32 : 128);
}

/** TRUST_PROXY：'true' 表示信任所有来源；'false'/空 表示不信任；否则是逗号分隔的 IP / CIDR 列表 */
export type TrustChecker = (remoteAddress: string) => boolean;

export function createTrustChecker(spec: string): TrustChecker {
  const s = spec.trim();
  if (s === '' || s.toLowerCase() === 'false') return () => false;
  if (s.toLowerCase() === 'true') return () => true;
  const items = s.split(',').map((x) => x.trim()).filter(Boolean);
  return (remote) => items.some((c) => ipInCidr(remote, c));
}

/**
 * 取客户端真实 IP。只有当直连的对端是受信任代理时才采用 X-Forwarded-For，
 * 并取最右一项（也就是受信任代理自己追加的那一项，客户端伪造的内容都在它左边）。
 */
export function clientIp(
  remoteAddress: string | undefined,
  xff: string | string[] | undefined,
  trusted: TrustChecker,
): string {
  const remote = normalizeIp(remoteAddress ?? '0.0.0.0');
  if (xff && trusted(remote)) {
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    const last = raw.split(',').map((x) => x.trim()).filter(Boolean).pop();
    if (last && isIP(normalizeIp(last))) return normalizeIp(last);
  }
  return remote;
}
