/** 设备码、时长、体积、费用等显示格式 */

/** 去掉空格等非数字字符，只留数字 */
export function parseDeviceCode(input: string): string {
  return input.replace(/\D+/g, '');
}

/** 482913675 → "482 913 675"（3 位一组，不限定总位数） */
export function formatDeviceCode(code: string): string {
  return parseDeviceCode(code).replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** 毫秒 → "45 秒" / "3 分 12 秒" / "1 小时 5 分" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

export function platformLabel(p: string): string {
  switch (p) {
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return p;
  }
}
