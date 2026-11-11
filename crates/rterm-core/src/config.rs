//! 本地配置：`config.json`（结构见《实现方案.md》17.2），原子写入，带 `schema_version`。
//! 数据目录用 `directories` 取各平台标准位置。
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 当前配置结构版本。结构变化时递增，并在 `migrate` 里加迁移步骤。
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("读写配置失败: {0}")]
    Io(String),
    #[error("配置文件版本 {found} 高于本程序支持的 {supported}，请升级客户端")]
    TooNew { found: u32, supported: u32 },
}

// ---------------------------------------------------------------- 目录

/// 本地目录布局。
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    /// 平台标准目录：Windows `%APPDATA%\RTerm\`，macOS `~/Library/Application Support/RTerm/`，
    /// Linux `~/.config/rterm/` 与 `~/.local/share/rterm/`。
    /// 环境变量 `RTERM_DATA_DIR` 可整体覆盖（同一台机器跑多个实例、测试）。
    pub fn standard() -> Option<Self> {
        if let Ok(root) = std::env::var("RTERM_DATA_DIR") {
            if !root.trim().is_empty() {
                return Some(Self::from_root(root));
            }
        }
        let base = directories::BaseDirs::new()?;
        if cfg!(target_os = "linux") {
            Some(Self {
                config_dir: base.config_dir().join("rterm"),
                data_dir: base.data_dir().join("rterm"),
            })
        } else {
            let d = base.config_dir().join("RTerm");
            Some(Self {
                config_dir: d.clone(),
                data_dir: d,
            })
        }
    }

    /// 所有内容放在同一个根目录下（测试、便携模式）。
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            config_dir: root.clone(),
            data_dir: root,
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }
    /// 文件形式机密存储的目录（钥匙串不可用时使用）
    pub fn secrets_dir(&self) -> PathBuf {
        self.config_dir.join("secrets")
    }
    pub fn inbox_dir(&self) -> PathBuf {
        self.data_dir.join("inbox")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
}

// ---------------------------------------------------------------- 结构

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeviceCfg {
    pub device_id: Option<String>,
    pub device_code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCfg {
    pub api_url: String,
    pub use_system_certs: bool,
    /// 手动代理；None = 自动（环境变量 / 系统），空字符串 = 明确不用代理
    pub proxy: Option<String>,
    /// 上次成功获取的 `GET /v1/config` 内容，接口不可用时使用
    pub cached_config: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HostCfg {
    pub enabled: bool,
    pub require_confirm: bool,
    /// on_start | after_session | manual
    pub temp_password_policy: String,
    pub fixed_password_set: bool,
    pub file_receive: bool,
    pub max_file_size: u64,
    pub max_terminals: u32,
    pub detached_term_ttl_hours: u32,
    pub default_shell: Option<String>,
    pub notify_on_connect: bool,
    pub prevent_sleep_when_connected: bool,
    /// 终端隔离（默认开）：每台主控设备只看得到自己创建的终端
    pub isolate_terminals: bool,
    /// Claude Code 集成（hooks 状态回传）
    pub claude_integration: bool,
    /// 状态栏注入
    pub claude_statusline: bool,
    /// 在所有终端里启用集成（改动用户级 Claude Code 配置）
    pub claude_integration_all: bool,
}

impl Default for HostCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            require_confirm: false,
            temp_password_policy: "on_start".into(),
            fixed_password_set: false,
            file_receive: true,
            max_file_size: 200 * 1024 * 1024,
            max_terminals: 16,
            detached_term_ttl_hours: 24,
            default_shell: None,
            notify_on_connect: true,
            prevent_sleep_when_connected: false,
            isolate_terminals: true,
            claude_integration: true,
            claude_statusline: true,
            claude_integration_all: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnownHost {
    pub device_code: String,
    #[serde(default)]
    pub alias: Option<String>,
    /// base64(32 字节公钥)
    pub public_key: String,
    #[serde(default)]
    pub last_connected: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ControllerCfg {
    pub known_hosts: Vec<KnownHost>,
    pub scrollback: u32,
    pub font_family: Option<String>,
    pub font_size: u32,
    pub theme: String,
    pub notify_on_done: bool,
    pub notify_on_permission: bool,
}

impl Default for ControllerCfg {
    fn default() -> Self {
        Self {
            known_hosts: Vec::new(),
            scrollback: 10000,
            font_family: None,
            font_size: 14,
            theme: "auto".into(),
            notify_on_done: true,
            notify_on_permission: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppCfg {
    pub autostart: bool,
    pub close_to_tray: bool,
    pub update_channel: String,
    pub crash_report: bool,
    /// 首次启动的安全须知是否已确认
    pub safety_notice_acked: bool,
}

impl Default for AppCfg {
    fn default() -> Self {
        Self {
            autostart: false,
            close_to_tray: true,
            update_channel: "stable".into(),
            crash_report: false,
            safety_notice_acked: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub schema_version: u32,
    pub device: DeviceCfg,
    pub server: ServerCfg,
    pub host: HostCfg,
    pub controller: ControllerCfg,
    pub app: AppCfg,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            device: DeviceCfg::default(),
            server: ServerCfg::default(),
            host: HostCfg::default(),
            controller: ControllerCfg::default(),
            app: AppCfg::default(),
        }
    }
}

impl Config {
    pub fn known_host(&self, device_code: &str) -> Option<&KnownHost> {
        self.controller
            .known_hosts
            .iter()
            .find(|h| h.device_code == device_code)
    }

    /// 记住（或更新）对端公钥。
    pub fn remember_host(&mut self, device_code: &str, public_key_b64: &str, now_iso: &str) {
        if let Some(h) = self
            .controller
            .known_hosts
            .iter_mut()
            .find(|h| h.device_code == device_code)
        {
            h.public_key = public_key_b64.to_string();
            h.last_connected = Some(now_iso.to_string());
        } else {
            self.controller.known_hosts.push(KnownHost {
                device_code: device_code.to_string(),
                alias: None,
                public_key: public_key_b64.to_string(),
                last_connected: Some(now_iso.to_string()),
            });
        }
    }
}

/// 迁移：把任意旧版本的 JSON 升到当前版本。目前只有 v1，缺 `schema_version` 视为 v1。
fn migrate(mut v: serde_json::Value) -> Result<serde_json::Value, ConfigError> {
    let found = v
        .get("schema_version")
        .and_then(|x| x.as_u64())
        .unwrap_or(1) as u32;
    if found > SCHEMA_VERSION {
        return Err(ConfigError::TooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    // 将来：if found < 2 { ...改字段... }
    if let Some(o) = v.as_object_mut() {
        o.insert("schema_version".into(), SCHEMA_VERSION.into());
    }
    Ok(v)
}

/// 读取配置。文件不存在返回默认值；损坏时把坏文件改名为 `config.json.bad` 并返回默认值
/// （设备码丢失不要紧：用同一把密钥重新注册会拿回原设备码）。
pub fn load(path: &Path) -> Result<Config, ConfigError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(e) => return Err(ConfigError::Io(e.to_string())),
    };
    let value = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v,
        Err(e) => return Ok(quarantine(path, &e.to_string())),
    };
    // 版本过新要明确报错，不能当作损坏覆盖掉
    let value = migrate(value)?;
    match serde_json::from_value::<Config>(value) {
        Ok(c) => Ok(c),
        Err(e) => Ok(quarantine(path, &e.to_string())),
    }
}

/// 配置损坏：改名备份，返回默认配置。
fn quarantine(path: &Path, msg: &str) -> Config {
    tracing::warn!("配置文件损坏（{msg}），已备份为 config.json.bad 并使用默认配置");
    let _ = std::fs::rename(path, path.with_extension("json.bad"));
    Config::default()
}

/// 原子保存：先写 `config.json.tmp`，fsync，再改名为 `config.json`。
pub fn save(path: &Path, cfg: &Config) -> Result<(), ConfigError> {
    use std::io::Write;
    let io = |e: std::io::Error| ConfigError::Io(e.to_string());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(cfg).map_err(|e| ConfigError::Io(e.to_string()))?;
    {
        let mut f = std::fs::File::create(&tmp).map_err(io)?;
        f.write_all(&data).map_err(io)?;
        f.sync_all().map_err(io)?;
    }
    std::fs::rename(&tmp, path).map_err(io)
}

/// 线程安全的配置持有者：读取是克隆，修改通过 `update` 闭包并立刻原子落盘。
pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<Config>,
}

impl ConfigStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let path = path.into();
        let cfg = load(&path)?;
        Ok(Self {
            path,
            inner: Mutex::new(cfg),
        })
    }

    pub fn get(&self) -> Config {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut Config) -> R) -> Result<R, ConfigError> {
        let mut g = self
            .inner
            .lock()
            .map_err(|_| ConfigError::Io("配置锁中毒".into()))?;
        let mut next = g.clone();
        let r = f(&mut next);
        save(&self.path, &next)?;
        *g = next;
        Ok(r)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_roundtrip_and_17_2_shape() {
        let c = Config::default();
        let s = serde_json::to_string(&c).unwrap();
        let back: Config = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["host"]["max_terminals"], 16);
        assert_eq!(v["controller"]["scrollback"], 10000);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let c: Config = serde_json::from_str(r#"{"device":{"device_code":"123456789"}}"#).unwrap();
        assert_eq!(c.device.device_code.as_deref(), Some("123456789"));
        assert_eq!(c.host.max_file_size, 200 * 1024 * 1024);
    }

    #[test]
    fn save_load_atomic() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub").join("config.json");
        assert_eq!(load(&p).unwrap(), Config::default());
        let mut c = Config::default();
        c.device.device_code = Some("482913675".into());
        save(&p, &c).unwrap();
        assert!(!p.with_extension("json.tmp").exists());
        assert_eq!(load(&p).unwrap(), c);
        // 覆盖写
        c.app.autostart = true;
        save(&p, &c).unwrap();
        assert!(load(&p).unwrap().app.autostart);
    }

    #[test]
    fn corrupt_file_backed_up() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(load(&p).unwrap(), Config::default());
        assert!(d.path().join("config.json.bad").exists());
    }

    #[test]
    fn too_new_schema_is_error_and_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        std::fs::write(&p, r#"{"schema_version": 99}"#).unwrap();
        assert!(matches!(
            load(&p),
            Err(ConfigError::TooNew { found: 99, .. })
        ));
        assert!(p.exists());
    }

    #[test]
    fn store_update_persists_and_known_hosts() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        let s = ConfigStore::open(&p).unwrap();
        s.update(|c| c.remember_host("731204588", "AAAA", "2026-01-01T00:00:00Z"))
            .unwrap();
        s.update(|c| c.remember_host("731204588", "BBBB", "2026-01-02T00:00:00Z"))
            .unwrap();
        let again = ConfigStore::open(&p).unwrap().get();
        assert_eq!(again.controller.known_hosts.len(), 1);
        assert_eq!(again.known_host("731204588").unwrap().public_key, "BBBB");
    }

    #[test]
    fn paths_root_override() {
        let p = Paths::from_root("/tmp/x");
        assert!(p.config_file().ends_with("config.json"));
        assert!(Paths::standard().is_some());
    }
}
