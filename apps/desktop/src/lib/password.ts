/** 密码相关的纯逻辑（方案 5.5.6） */

/** 临时密码字符集：去掉易混淆的 0 O 1 l I */
export const TEMP_PASSWORD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export const FIXED_PASSWORD_MIN = 10;
export const FIXED_PASSWORD_MIN_CLASSES = 3;

/** 字符类别数：小写、大写、数字、其他（与核心库 char_classes 一致） */
export function passwordClasses(pw: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let other = false;
  for (const ch of pw) {
    if (ch >= 'a' && ch <= 'z') lower = true;
    else if (ch >= 'A' && ch <= 'Z') upper = true;
    else if (ch >= '0' && ch <= '9') digit = true;
    else other = true;
  }
  return [lower, upper, digit, other].filter(Boolean).length;
}

/**
 * 前端预检：长度与字符类别。常见弱口令（词表、键盘序列、含设备码等）由核心库判定，
 * 以错误码 WEAK_PASSWORD 和中文 message 返回，界面原样展示。
 * 通过返回 null，否则返回中文错误。
 */
export function validateFixedPassword(pw: string): string | null {
  if ([...pw].length < FIXED_PASSWORD_MIN) return `至少 ${FIXED_PASSWORD_MIN} 位`;
  if (passwordClasses(pw) < FIXED_PASSWORD_MIN_CLASSES) {
    return `需包含大写字母、小写字母、数字、符号中的至少 ${FIXED_PASSWORD_MIN_CLASSES} 类`;
  }
  return null;
}
