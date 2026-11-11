/** 密码相关的纯逻辑（方案 5.5.6） */

/** 临时密码字符集：去掉易混淆的 0 O 1 l I */
export const TEMP_PASSWORD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export const FIXED_PASSWORD_MIN = 8;

/** 校验固定密码；通过返回 null，否则返回中文错误 */
export function validateFixedPassword(pw: string): string | null {
  if (pw.length < FIXED_PASSWORD_MIN) return `至少 ${FIXED_PASSWORD_MIN} 位`;
  // 恰好 8 位且全部来自临时密码字符集的，会和临时密码混淆（主控端靠这一点区分两种密码）
  if (pw.length === 8 && [...pw].every((c) => TEMP_PASSWORD_CHARSET.includes(c))) {
    return '不能是 8 位纯字母数字，请加长或加入符号';
  }
  return null;
}
