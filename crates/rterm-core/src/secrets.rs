//! 机密存储：系统钥匙串优先，不可用时退回 0600 权限的文件。两种实现在同一个 trait 后面。
//!
//! 条目名约定：`device-key`（设备私钥 32 字节）、`fixed-pw-key`（固定密码的 pw_key）等。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

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

/// 文件存储：每个条目一个文件，Unix 上目录 0700、文件 0600；Windows 上目录 DACL 仅当前用户
/// （保护型，不继承父目录的访问项；审查 L7）。
pub struct FileStore {
    dir: PathBuf,
    /// 权限不合格的警告只记一次
    warned: AtomicBool,
}

impl FileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            warned: AtomicBool::new(false),
        }
    }

    /// 创建目录并收紧权限；收紧失败只记警告，不阻止写入（钥匙串不可用时这是唯一的存储）。
    fn ensure_dir(&self) -> Result<(), SecretError> {
        std::fs::create_dir_all(&self.dir).map_err(|e| SecretError::Io(e.to_string()))?;
        if let Err(e) = private_dir::restrict(&self.dir) {
            tracing::warn!("无法把机密目录权限收紧为仅当前用户：{e}");
        }
        Ok(())
    }

    /// 读取前验证目录权限；不合格则警告并尝试重新收紧。
    fn verify_dir(&self) {
        if !self.dir.exists() {
            return;
        }
        match private_dir::is_private(&self.dir) {
            Ok(true) => {}
            Ok(false) => {
                if !self.warned.swap(true, Ordering::Relaxed) {
                    tracing::warn!("机密目录的访问权限过宽，正在收紧为仅当前用户");
                }
                if let Err(e) = private_dir::restrict(&self.dir) {
                    tracing::warn!("收紧机密目录权限失败：{e}");
                }
            }
            Err(e) => {
                if !self.warned.swap(true, Ordering::Relaxed) {
                    tracing::warn!("无法验证机密目录的访问权限：{e}");
                }
            }
        }
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
        let path = self.path(name)?;
        self.verify_dir();
        match std::fs::read(path) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(SecretError::Io(e.to_string())),
        }
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        let path = self.path(name)?;
        self.ensure_dir()?;
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
    // 目录 DACL 已是仅当前用户且可继承（见 `private_dir`），新文件自动继承
    std::fs::write(path, data)
}

#[cfg(unix)]
mod private_dir {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    pub fn restrict(dir: &Path) -> std::io::Result<()> {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }

    pub fn is_private(dir: &Path) -> std::io::Result<bool> {
        Ok(std::fs::metadata(dir)?.permissions().mode() & 0o077 == 0)
    }
}

#[cfg(windows)]
mod private_dir {
    //! Windows：把目录 DACL 设为“仅当前用户完全控制”的保护型 DACL（OI/CI 继承给其中的文件）。
    use std::io;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorDacl,
        GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe fn sid_to_string(sid: *mut core::ffi::c_void) -> io::Result<String> {
        let mut p: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut p) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0;
        while unsafe { *p.add(n) } != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, n) });
        unsafe { LocalFree(p as _) };
        Ok(s)
    }

    /// 当前进程用户的 SID 字符串（`S-1-5-21-…`）。
    pub fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut tok: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(tok, TokenUser, null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(tok, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            let res = if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                let tu = &*(buf.as_ptr() as *const TOKEN_USER);
                sid_to_string(tu.User.Sid)
            };
            CloseHandle(tok);
            res
        }
    }

    /// DACL 里所有“允许”访问项的 SID 字符串。没有 DACL（对所有人开放）时返回 `S-1-1-0`。
    pub fn allowed_sids(path: &Path) -> io::Result<Vec<String>> {
        let w = wide(path.as_os_str());
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut sd = null_mut();
            let rc = GetNamedSecurityInfoW(
                w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut sd,
            );
            if rc != 0 {
                return Err(io::Error::from_raw_os_error(rc as i32));
            }
            let res = (|| {
                if dacl.is_null() {
                    return Ok(vec!["S-1-1-0".to_string()]);
                }
                let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
                if GetAclInformation(
                    dacl,
                    (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                    std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let mut out = Vec::new();
                for i in 0..info.AceCount {
                    let mut ace: *mut core::ffi::c_void = null_mut();
                    if GetAce(dacl, i, &mut ace) == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let a = ace as *mut ACCESS_ALLOWED_ACE;
                    if (*a).Header.AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let sid = std::ptr::addr_of_mut!((*a).SidStart) as *mut core::ffi::c_void;
                        out.push(sid_to_string(sid)?);
                    }
                }
                Ok(out)
            })();
            LocalFree(sd as _);
            res
        }
    }

    /// 只允许当前用户、SYSTEM、Administrators 才算合格。
    pub fn is_private(path: &Path) -> io::Result<bool> {
        let me = current_user_sid()?;
        Ok(allowed_sids(path)?
            .iter()
            .all(|s| *s == me || s == "S-1-5-18" || s == "S-1-5-32-544"))
    }

    pub fn restrict(path: &Path) -> io::Result<()> {
        let me = current_user_sid()?;
        // 保护型 DACL（不继承父目录），仅当前用户完全控制，对子对象和容器继承
        apply_sddl(path, &format!("D:P(A;OICI;FA;;;{me})"))
    }

    pub fn apply_sddl(path: &Path, sddl: &str) -> io::Result<()> {
        let sddl: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut sd = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut present = 0i32;
            let mut defaulted = 0i32;
            let mut dacl: *mut ACL = null_mut();
            let res = if GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
            {
                Err(io::Error::other("无法取得 DACL"))
            } else {
                let w = wide(path.as_os_str());
                let rc = SetNamedSecurityInfoW(
                    w.as_ptr() as *mut u16,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null(),
                );
                if rc == 0 {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(rc as i32))
                }
            };
            LocalFree(sd as _);
            res
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod private_dir {
    pub fn restrict(_: &std::path::Path) -> std::io::Result<()> {
        Ok(())
    }
    pub fn is_private(_: &std::path::Path) -> std::io::Result<bool> {
        Ok(true)
    }
}

// ---------------------------------------------------------------- 内存（测试）

#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
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
            .map(|v| v.to_vec()))
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.map
            .lock()
            .map_err(|_| SecretError::Io("锁中毒".into()))?
            .insert(name.to_string(), Zeroizing::new(value.to_vec()));
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
    fn file_store_dir_is_0700() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("sec");
        let s = FileStore::new(&dir);
        s.set("k", &[1]).unwrap();
        let m = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(m & 0o777, 0o700);
    }

    /// 审查 L7：Windows 上 secrets 目录 DACL 只含当前用户，没有 Everyone / Users / Authenticated Users。
    #[cfg(windows)]
    #[test]
    fn file_store_dacl_is_current_user_only() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("sec");
        let s = FileStore::new(&dir);
        s.set("k", &[1]).unwrap();
        let me = private_dir::current_user_sid().unwrap();
        for p in [dir.clone(), dir.join("k.secret")] {
            let sids = private_dir::allowed_sids(&p).unwrap();
            assert!(sids.contains(&me), "{p:?}: {sids:?}");
            for bad in ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"] {
                assert!(!sids.iter().any(|x| x == bad), "{p:?} 含 {bad}: {sids:?}");
            }
            assert_eq!(sids.len(), 1, "{p:?}: {sids:?}");
        }
    }

    /// 读取时发现权限过宽会重新收紧。
    #[cfg(windows)]
    #[test]
    fn file_store_repairs_loose_dacl_on_read() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("sec");
        std::fs::create_dir_all(&dir).unwrap();
        // 故意放开成 Everyone 完全控制
        private_dir::apply_sddl(&dir, "D:P(A;OICI;FA;;;WD)").unwrap();
        assert!(!private_dir::is_private(&dir).unwrap());
        let s = FileStore::new(&dir);
        let _ = s.get("k").unwrap();
        assert!(private_dir::is_private(&dir).unwrap());
        let sids = private_dir::allowed_sids(&dir).unwrap();
        assert_eq!(sids, vec![private_dir::current_user_sid().unwrap()]);
    }

    #[test]
    fn memory_store_values_are_zeroizing() {
        fn assert_zod<T: zeroize::ZeroizeOnDrop>() {}
        assert_zod::<Zeroizing<Vec<u8>>>();
        let m = MemoryStore::default();
        m.set("a", &[1, 2]).unwrap();
        assert_eq!(m.get("a").unwrap(), Some(vec![1, 2]));
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
