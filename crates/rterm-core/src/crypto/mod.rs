//! 加密层：SPAKE2 握手 + AEAD 记录（《实现方案.md》4.5，《开发指南.md》T28、T29）。
use argon2::{Algorithm, Argon2, Params, Version};

pub mod handshake;
pub mod keys;
pub mod record;

pub use handshake::{Established, HsError};
pub use keys::SessionKeys;
pub use record::{RecordError, Sealer};

/// 临时密码字符集（去掉容易混淆的字符），8 位。
pub const TEMP_PASSWORD_CHARSET: &str = "abcdefghjkmnpqrstuvwxyz23456789";

/// 主控端用户输入的是哪一种密码：恰好 8 位且全部属于临时密码字符集 -> 0（临时密码）；否则 -> 1（固定密码）。
/// （固定密码设置时已禁止“恰好 8 位且全在字符集内”，见 T30）
pub fn password_kind_of(input: &str) -> u32 {
    if input.chars().count() == 8 && input.chars().all(|c| TEMP_PASSWORD_CHARSET.contains(c)) {
        0
    } else {
        1
    }
}

/// 加密层错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    /// 口令派生（Argon2id）失败或任务被取消。调用方必须把它当作失败，不能退化成固定的密钥（审查 L2）。
    #[error("口令派生失败：{0}")]
    Kdf(String),
}

/// 异步版 `derive_pw_key`（放进 `spawn_blocking`，不卡其他任务）。
pub async fn derive_pw_key_async(
    password: String,
    host_code: String,
) -> Result<[u8; 32], CryptoError> {
    tokio::task::spawn_blocking(move || {
        let pw = zeroize::Zeroizing::new(password);
        derive_pw_key(&pw, &host_code)
    })
    .await
    .map_err(|e| CryptoError::Kdf(format!("派生任务未完成：{e}")))?
}

/// 密码处理：`Argon2id(密码, salt = "rterm-v1" || 被控端设备码, m = 19MiB, t = 2, p = 1)`，输出 32 字节。
/// 网络层负责实现；被控端 guard 和主控端都调用它。
///
/// 比较耗时（debug 构建约 0.8 秒），异步环境里要放进 `spawn_blocking`。
///
/// 失败返回 `Err`：设置固定密码时不保存，握手时直接失败；任何地方都不能用全零密钥顶替（审查 L2）。
pub fn derive_pw_key(password: &str, host_code: &str) -> Result<[u8; 32], CryptoError> {
    derive_with_cost(password, host_code, 19 * 1024)
}

fn derive_with_cost(password: &str, host_code: &str, m_kib: u32) -> Result<[u8; 32], CryptoError> {
    let params = Params::new(m_kib, 2, 1, Some(32)).map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = format!("rterm-v1{host_code}");
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt.as_bytes(), &mut out)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_kind_by_format() {
        assert_eq!(password_kind_of("abc23456"), 0);
        assert_eq!(password_kind_of("zzzz9999"), 0);
        // 含被排除的易混淆字符（i l o 0 1）-> 固定密码
        assert_eq!(password_kind_of("abcdefgi"), 1);
        assert_eq!(password_kind_of("abc2345"), 1); // 7 位
        assert_eq!(password_kind_of("abc234567"), 1); // 9 位
        assert_eq!(password_kind_of("ABC23456"), 1); // 大写不在字符集
        assert_eq!(password_kind_of(""), 1);
    }

    #[tokio::test]
    async fn async_derive_matches_sync() {
        assert_eq!(
            derive_pw_key_async("abc23456".into(), "123456789".into())
                .await
                .expect("kdf"),
            derive_pw_key("abc23456", "123456789").expect("kdf")
        );
    }

    #[test]
    fn pw_key_deterministic_and_salted() {
        let a = derive_pw_key("abc23456", "123456789").expect("kdf");
        assert_eq!(a, derive_pw_key("abc23456", "123456789").expect("kdf"));
        assert_ne!(a, derive_pw_key("abc23457", "123456789").expect("kdf"));
        assert_ne!(a, derive_pw_key("abc23456", "123456780").expect("kdf"));
        assert_ne!(a, [0u8; 32]);
    }

    /// 审查 L2：派生失败必须返回错误，而不是全零密钥。
    #[test]
    fn kdf_failure_is_an_error_not_a_zero_key() {
        // m_cost 小于 8 KiB（p=1 时的下限）：Params::new 失败
        let r = derive_with_cost("abc23456", "123456789", 1);
        assert!(matches!(r, Err(CryptoError::Kdf(_))), "得到 {r:?}");
        // 参数合法时才有结果，且不是全零
        assert_ne!(
            derive_with_cost("abc23456", "123456789", 8).expect("ok"),
            [0u8; 32]
        );
    }
}
