//! 设备身份：Ed25519 密钥对。私钥存在 `SecretStore`（系统钥匙串或 0600 文件）。
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

use crate::secrets::{SecretError, SecretStore, DEVICE_KEY};

pub fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .ok()
}

/// 本机身份（私钥）。`Debug` 不打印私钥。
pub struct Identity {
    key: SigningKey,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Identity(pk={})", b64(&self.public_key()))
    }
}

impl Identity {
    /// 生成新密钥。用 `from_bytes(rand::random())` 避开 rand 与 ed25519-dalek 的随机数接口版本匹配问题。
    pub fn generate() -> Self {
        Self {
            key: SigningKey::from_bytes(&rand::random::<[u8; 32]>()),
        }
    }

    pub fn from_bytes(seed: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(seed),
        }
    }

    /// 从存储读取；没有则生成并保存。返回 `(身份, 是否新生成)`。
    pub fn load_or_create(store: &dyn SecretStore) -> Result<(Self, bool), SecretError> {
        // `get` 出错（钥匙串暂时不可用）直接向上返回：只有"确实不存在"才会生成新身份（审查 L7）
        if let Some(raw) = store.get(DEVICE_KEY)? {
            return match <[u8; 32]>::try_from(raw.as_slice()) {
                Ok(seed) => Ok((Self::from_bytes(&seed), false)),
                // 长度异常也不静默重新生成：那会替换设备身份，所有主控端会看到公钥变化
                Err(_) => Err(SecretError::Io(format!(
                    "存储中的设备私钥长度异常（{} 字节），为避免静默替换设备身份已停止；如确认损坏，请手动删除 {DEVICE_KEY} 条目后重试",
                    raw.len()
                ))),
            };
        }
        let id = Self::generate();
        store.set(DEVICE_KEY, &id.key.to_bytes())?;
        Ok((id, true))
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn public_key_b64(&self) -> String {
        b64(&self.public_key())
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.key.sign(msg).to_bytes()
    }
}

/// 验证 Ed25519 签名（公钥 32 字节，签名 64 字节）。
///
/// L12：使用 `verify_strict`——拒绝小阶（弱）公钥和不规范（可延展）的签名。
/// 普通 `verify` 对小阶公钥会接受“任意消息”的伪造签名。握手里的对端公钥来自信令、签名来自对端，
/// 严格校验后，握手认证不再依赖“对端公钥是正常生成的”这一假设。
pub fn verify_signature(public_key: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let Ok(pk) = <[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(sig) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    vk.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(&sig))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    #[test]
    fn sign_and_verify() {
        let id = Identity::generate();
        let sig = id.sign(b"hello");
        assert!(verify_signature(&id.public_key(), b"hello", &sig));
        assert!(!verify_signature(&id.public_key(), b"hellO", &sig));
        let other = Identity::generate();
        assert!(!verify_signature(&other.public_key(), b"hello", &sig));
        assert!(!verify_signature(&id.public_key()[..31], b"hello", &sig));
    }

    /// L12：小阶（弱）公钥必须被拒绝。
    /// 公钥 = 单位元（编码 01 00..00），签名 = (R = 单位元, S = 0) 对任意消息都满足普通 `verify`，
    /// 即攻击者无需私钥就能“签名”；`verify_strict` 会拒绝。
    #[test]
    fn small_order_public_key_is_rejected() {
        let mut pk = [0u8; 32];
        pk[0] = 1;
        let mut sig = [0u8; 64];
        sig[0] = 1;
        // 前提：普通 verify 确实会接受（否则这个测试没有意义）
        use ed25519_dalek::Verifier;
        let vk = VerifyingKey::from_bytes(&pk).expect("单位元是合法编码");
        assert!(vk
            .verify(b"anything", &ed25519_dalek::Signature::from_bytes(&sig))
            .is_ok());
        assert!(!verify_signature(&pk, b"anything", &sig));
        assert!(!verify_signature(&pk, b"other message", &sig));
    }

    #[test]
    fn load_or_create_is_stable() {
        let store = MemoryStore::default();
        let (a, created) = Identity::load_or_create(&store).unwrap();
        assert!(created);
        let (b, created) = Identity::load_or_create(&store).unwrap();
        assert!(!created);
        assert_eq!(a.public_key(), b.public_key());
    }

    /// 审查 L7：长度异常的私钥不能被静默替换。
    #[test]
    fn corrupt_key_is_an_error_not_regenerated() {
        let store = MemoryStore::default();
        store.set(DEVICE_KEY, &[1, 2, 3]).unwrap();
        assert!(Identity::load_or_create(&store).is_err());
        // 原值没有被覆盖
        assert_eq!(store.get(DEVICE_KEY).unwrap(), Some(vec![1, 2, 3]));
    }

    /// 审查 L7：存储读取失败（不是"不存在"）时，不能生成并保存新身份。
    #[test]
    fn read_failure_never_creates_a_new_identity() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        struct Flaky {
            inner: MemoryStore,
            fail_get: AtomicBool,
            sets: AtomicUsize,
        }
        impl SecretStore for Flaky {
            fn kind(&self) -> &'static str {
                "flaky"
            }
            fn get(&self, n: &str) -> Result<Option<Vec<u8>>, SecretError> {
                if self.fail_get.load(Ordering::SeqCst) {
                    Err(SecretError::Unavailable("钥匙串未解锁".into()))
                } else {
                    self.inner.get(n)
                }
            }
            fn set(&self, n: &str, v: &[u8]) -> Result<(), SecretError> {
                self.sets.fetch_add(1, Ordering::SeqCst);
                self.inner.set(n, v)
            }
            fn delete(&self, n: &str) -> Result<(), SecretError> {
                self.inner.delete(n)
            }
        }
        let store = Flaky {
            inner: MemoryStore::default(),
            fail_get: AtomicBool::new(false),
            sets: AtomicUsize::new(0),
        };
        let (first, created) = Identity::load_or_create(&store).unwrap();
        assert!(created);
        assert_eq!(store.sets.load(Ordering::SeqCst), 1);
        // 钥匙串暂时读不出来
        store.fail_get.store(true, Ordering::SeqCst);
        assert!(Identity::load_or_create(&store).is_err());
        assert_eq!(
            store.sets.load(Ordering::SeqCst),
            1,
            "读取失败时不能写入新密钥"
        );
        // 恢复后拿到的还是原来的身份
        store.fail_get.store(false, Ordering::SeqCst);
        let (again, created) = Identity::load_or_create(&store).unwrap();
        assert!(!created);
        assert_eq!(again.public_key(), first.public_key());
    }
}
