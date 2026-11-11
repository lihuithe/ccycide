//! 机密存储：系统钥匙串优先，不可用时退回 0600 权限的文件。两种实现在同一个 trait 后面。
//!
//! 条目名约定：`device-key`（设备私钥 32 字节）、`fixed-pw-key`（固定密码的 pw_key）等。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const SERVICE: &str = "rterm";
/// 设备私钥的条目名
pub const DEVICE_KEY: &str = "device-key";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("机密存储不可用: {0}")]
    Unavailable(String),
    #[error("机密存储读写失败: {0}")]
    Io(String),
}

pub trait SecretStore: Send + Sync {
    /// 实现名，用于日志（"keyring" / "file" / "memory"）
    fn kind(&self) -> &'static str;
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError>;
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError>;
    fn delete(&self, name: &str) -> Result<(), SecretError>;
}

// ---------------------------------------------------------------- 系统钥匙串

/// 系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）。
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    /// 创建并探测可用性（读一个不存在的条目；平台后端初始化失败则返回 Err）。
    pub fn probe(service: &str) -> Result<Self, SecretError> {
        if let Err(e) = keyring::Entry::store_status() {
            return Err(SecretError::Unavailable(e.to_string()));
        }
        let s = Self {
            service: service.to_string(),
        };
        // 读一个探针条目：NoEntry 是正常的，其他错误说明后端不可用
        s.get("probe-nonexistent")?;
        Ok(s)
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, name)
            .map_err(|e| SecretError::Unavailable(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn kind(&self) -> &'static str {
        "keyring"
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        match self.entry(name)?.get_secret() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Unavailable(e.to_string())),
        }
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.entry(name)?
            .set_secret(value)
            .map_err(|e| SecretError::Unavailable(e.to_string()))
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Unavailable(e.to_string())),
        }
    }
}

// ---------------------------------------------------------------- 文件兜底

/// 文件存储：每个条目一个文件，Unix 上权限 0600。
pub struct FileStore {
    dir: PathBuf,
}

impl FileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn path(&self, name: &str) -> Result<PathBuf, SecretError> {
        // 条目名只允许安全字符，避免路径穿越
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(SecretError::Io(format!("非法条目名: {name}")));
        }
        Ok(self.dir.join(format!("{name}.secret")))
    }
}

impl SecretStore for FileStore {
    fn kind(&self) -> &'static str {
        "file"
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        match std::fs::read(self.path(name)?) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(SecretError::Io(e.to_string())),
        }
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        let path = self.path(name)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| SecretError::Io(e.to_string()))?;
        let tmp = path.with_extension("secret.tmp");
        write_private(&tmp, value).map_err(|e| SecretError::Io(e.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|e| SecretError::Io(e.to_string()))
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match std::fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SecretError::Io(e.to_string())),
        }
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // 文件已存在时 `mode()` 不生效，显式收紧一次
    use std::os::unix::fs::PermissionsExt;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(data)
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    // Windows 上数据目录位于用户配置目录下，默认只有当前用户和管理员可访问
    std::fs::write(path, data)
}

// ---------------------------------------------------------------- 内存（测试）

#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, Vec<u8>>>,
}

impl SecretStore for MemoryStore {
    fn kind(&self) -> &'static str {
        "memory"
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        Ok(self
            .map
            .lock()
            .map_err(|_| SecretError::Io("锁中毒".into()))?
            .get(name)
            .cloned())
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.map
            .lock()
            .map_err(|_| SecretError::Io("锁中毒".into()))?
            .insert(name.to_string(), value.to_vec());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        self.map
            .lock()
            .map_err(|_| SecretError::Io("锁中毒".into()))?
            .remove(name);
        Ok(())
    }
}

// ---------------------------------------------------------------- 组合

/// 主存储失败时落到备用存储；读取时主存储没有再查备用。
pub struct FallbackStore {
    primary: Arc<dyn SecretStore>,
    fallback: Arc<dyn SecretStore>,
}

impl FallbackStore {
    pub fn new(primary: Arc<dyn SecretStore>, fallback: Arc<dyn SecretStore>) -> Self {
        Self { primary, fallback }
    }
}

impl SecretStore for FallbackStore {
    fn kind(&self) -> &'static str {
        self.primary.kind()
    }
    /// 主存储"确实没有"才查备用；主存储出错（钥匙串暂时锁定等）时，备用里有就用备用，
    /// 备用里也没有则返回错误——不能把"读取失败"当成"不存在"，否则上层会据此重新生成设备身份（审查 L7）。
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        match self.primary.get(name) {
            Ok(Some(v)) => Ok(Some(v)),
            Ok(None) => self.fallback.get(name),
            Err(e) => match self.fallback.get(name) {
                Ok(Some(v)) => Ok(Some(v)),
                _ => Err(e),
            },
        }
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        match self.primary.set(name, value) {
            Ok(()) => Ok(()),
            Err(e) => {
                tracing::warn!("系统钥匙串写入失败，退回文件存储: {e}");
                self.fallback.set(name, value)
            }
        }
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        let a = self.primary.delete(name);
        let b = self.fallback.delete(name);
        a.and(b)
    }
}

/// 默认存储：钥匙串可用就用钥匙串（文件作备用），否则只用文件，并在日志里说明。
/// 环境变量 `RTERM_NO_KEYRING=1` 强制只用文件（开发多实例、CI）。
pub fn default_store(fallback_dir: impl Into<PathBuf>) -> Arc<dyn SecretStore> {
    let file: Arc<dyn SecretStore> = Arc::new(FileStore::new(fallback_dir));
    if std::env::var("RTERM_NO_KEYRING")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        tracing::info!("RTERM_NO_KEYRING=1，使用文件存储机密");
        return file;
    }
    match KeyringStore::probe(SERVICE) {
        Ok(k) => Arc::new(FallbackStore::new(Arc::new(k), file)),
        Err(e) => {
            tracing::warn!("系统钥匙串不可用（{e}），退回到权限 0600 的文件存储");
            file
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(s: &dyn SecretStore) {
        assert_eq!(s.get("device-key").unwrap(), None);
        s.set("device-key", &[1, 2, 3]).unwrap();
        assert_eq!(s.get("device-key").unwrap(), Some(vec![1, 2, 3]));
        s.set("device-key", &[9]).unwrap();
        assert_eq!(s.get("device-key").unwrap(), Some(vec![9]));
        s.delete("device-key").unwrap();
        assert_eq!(s.get("device-key").unwrap(), None);
        s.delete("device-key").unwrap(); // 幂等
    }

    #[test]
    fn memory_store() {
        exercise(&MemoryStore::default());
    }

    #[test]
    fn file_store_roundtrip_and_name_check() {
        let d = tempfile::tempdir().unwrap();
        let s = FileStore::new(d.path().join("sec"));
        exercise(&s);
        assert!(s.set("../evil", &[1]).is_err());
        assert!(s.get("a/b").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_store_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let s = FileStore::new(d.path());
        s.set("k", &[1]).unwrap();
        let m = std::fs::metadata(d.path().join("k.secret"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(m & 0o777, 0o600);
    }

    /// 真实系统钥匙串往返（会读写当前用户的凭据库，使用独立的服务名并在结束时删除）。
    #[test]
    #[ignore = "会访问真实的系统钥匙串"]
    fn real_keyring_roundtrip() {
        let s = KeyringStore::probe("rterm-test").expect("钥匙串应可用");
        exercise(&s);
    }

    struct Broken;
    impl SecretStore for Broken {
        fn kind(&self) -> &'static str {
            "broken"
        }
        fn get(&self, _: &str) -> Result<Option<Vec<u8>>, SecretError> {
            Err(SecretError::Unavailable("x".into()))
        }
        fn set(&self, _: &str, _: &[u8]) -> Result<(), SecretError> {
            Err(SecretError::Unavailable("x".into()))
        }
        fn delete(&self, _: &str) -> Result<(), SecretError> {
            Err(SecretError::Unavailable("x".into()))
        }
    }

    #[test]
    fn fallback_store_uses_file_when_primary_broken() {
        let d = tempfile::tempdir().unwrap();
        let s = FallbackStore::new(Arc::new(Broken), Arc::new(FileStore::new(d.path())));
        s.set("k", &[7]).unwrap();
        assert_eq!(s.get("k").unwrap(), Some(vec![7]));
    }
    /// 审查 L7：钥匙串暂时出错时，不能表现成"没有这个条目"。
    #[test]
    fn fallback_get_reports_primary_errors_instead_of_none() {
        let d = tempfile::tempdir().unwrap();
        let file = Arc::new(FileStore::new(d.path()));
        let s = FallbackStore::new(Arc::new(Broken), file.clone());
        // 主存储出错、备用里也没有：必须是 Err（不是 Ok(None)）
        assert!(matches!(
            s.get("device-key"),
            Err(SecretError::Unavailable(_))
        ));
        // 备用里有（之前钥匙串写入失败时落到了文件）：用备用的
        file.set("device-key", &[5]).unwrap();
        assert_eq!(s.get("device-key").unwrap(), Some(vec![5]));
        // 主存储正常且确实没有：才回落到备用，备用没有就是 None
        let ok = FallbackStore::new(
            Arc::new(MemoryStore::default()),
            Arc::new(FileStore::new(d.path().join("other"))),
        );
        assert_eq!(ok.get("device-key").unwrap(), None);
    }
}
