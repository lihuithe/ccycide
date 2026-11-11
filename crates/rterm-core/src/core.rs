//! 核心库门面：界面层（Tauri）和命令行都只通过 [`Core`] 使用核心库（《开发指南.md》7.0）。
//!
//! # 结构
//! `Core::start` 读取配置、必要时向服务端注册设备、连接信令，并把下面几块装配起来：
//! - 被控端：`Guard`（密码、锁定、接入设置）+ `HostCtx`（终端、收文件）+ 对每个 `connect.incoming` 的处理任务；
//! - 主控端：`ControllerManager`（多会话、自动重连、续传）；
//! - 后台任务：信令事件、`Guard` 事件、延迟上报、服务端配置刷新。
//!
//! 事件统一从 `start` 返回的 `mpsc::Receiver<CoreEvent>` 取出，调用方必须持续取走（通道有界，慢了会反压到各会话任务）。
//! Tauri 层用 [`Core::ui_event`] 把事件转成前端契约的 JSON 结构。
//!
//! # 首次启动没有服务端
//! `start` 不会因为服务端不可达而失败：它返回正常的 `Core`，`local_info().registered == false`、
//! `last_error` 里是明确的原因，并在后台按退避自动重试注册；也可以调用 [`Core::retry_register`] 立即重试。
//! 注册成功后发 `LocalInfoChanged`，之后一切照常。注册前调用需要网络的接口返回 `NOT_REGISTERED`。
//!
//! # 对来访连接的处理（被控端）
//! `connect.incoming` -> `Guard::admit`：拒绝则回 `connect.reject`；需要确认则发 `IncomingSession{pending_confirm:true}`，
//! 等 [`Core::accept_incoming`] / [`Core::reject_incoming`]，10 秒无操作视为拒绝；放行后 `connect.accept` -> 握手 ->
//! 成功：`report_auth_success` + `session.report(auth_ok)` + `IncomingSession{pending_confirm:false}` -> `HostSession` ->
//! 结束：`report_session_end` + `session.report(closed)` + `IncomingClosed`。
//! 密码错误：`report_auth_failure` + `session.report(auth_failed)`，触发锁定时再报 `host_locked`（信令的 `accept` 只反映“允许被连接”开关，
//! 锁定期间保持在线，由服务端和 `Guard::admit` 对主控端回 `LOCKED`）。
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rterm_proto::pb;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio::task::JoinHandle;

use crate::api::{
    bootstrap_with, resolve_signal_url, ApiClient, ApiError, BootstrapError, DeviceInfo,
    ServerConfig,
};
use crate::config::{Config, ConfigStore, Paths};
use crate::controller::{
    CloseReason, ConnectRequest, Controller, ControllerManager, ControllerTiming, SignalConnector,
    TermOpenOptions, TermProfile, TermSize, UploadSource,
};
use crate::crypto::derive_pw_key_async;
use crate::dto::{
    self, ActionOutcomeDto, IncomingSessionDto, KnownHostDto, LaunchOptionsDto, TermInfoDto,
    TermOpenedDto, UiEvent, UploadStartedDto,
};
use crate::error::{codes, CoreError, CoreResult};
use crate::events::{CoreEvent, FileId, SessionId, TermId};
use crate::host::guard::{AccessSettings, Admission, Guard, GuardEvent, TempPolicy};
use crate::host::session::{HostConfig, HostCtx, HostSession};
use crate::host::term::TermConfig;
use crate::identity::{b64, b64_decode};
use crate::link::HostPasswords;
use crate::logging::mask_code;
use crate::netutil::NetOptions;
use crate::relay::{establish_host, EstablishError, HostParams, PasswordInput};
use crate::secrets::{default_store, SecretStore};
use crate::settings::Settings;
use crate::signal::{IncomingConnect, SignalClient, SignalConfig, SignalEvent};

/// 内置的服务端地址。开发默认本机；发布版在编译时用环境变量 `RTERM_DEFAULT_API_URL` 指定。
pub const DEFAULT_API_URL: &str = match option_env!("RTERM_DEFAULT_API_URL") {
    Some(u) => u,
    None => "http://127.0.0.1:8080",
};

/// 机密存储里固定密码派生值的条目名。
pub const FIXED_PW_KEY: &str = "fixed-pw-key";

/// 需要确认的来访：同一台主控设备的上一个会话结束后这么久之内重连，不再重复确认
/// （网络闪断后自动重连不应该让被控端用户再点一次）。
pub const RECONNECT_GRACE: Duration = Duration::from_secs(120);

/// 对等待确认的来访的处理结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Accept,
    Reject,
    /// 主控方取消了请求
    Cancelled,
}

/// 延迟上报间隔。
const LATENCY_INTERVAL: Duration = Duration::from_secs(5);
/// 服务端配置刷新间隔。
const CONFIG_REFRESH: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CoreKind {
    #[default]
    Desktop,
    Cli,
}

impl CoreKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreKind::Desktop => "desktop",
            CoreKind::Cli => "cli",
        }
    }
}

/// 启动参数。
#[derive(Clone)]
pub struct CoreOptions {
    /// 服务端地址（不含 `/v1`）。None：环境变量 `RTERM_API_URL` > 配置文件里的值 > [`DEFAULT_API_URL`]
    pub api_url: Option<String>,
    /// 数据目录（配置、机密文件、inbox、日志都在它下面）。None：平台标准目录（`RTERM_DATA_DIR` 可覆盖）
    pub data_dir: Option<PathBuf>,
    pub app_version: String,
    pub kind: CoreKind,
    /// `rterm-cli` 可执行文件的绝对路径（Claude Code 状态回传的 hook 命令）。None：CLI 版用自身，桌面版找同目录下的 `rterm-cli`
    pub rterm_cli: Option<PathBuf>,
    /// 手动代理，覆盖配置文件（只对本次运行生效）。None = 用配置；空字符串 = 不使用代理
    pub proxy: Option<String>,
    /// 机密存储。None：系统钥匙串，不可用时退回文件（`RTERM_NO_KEYRING=1` 强制文件）
    pub secrets: Option<Arc<dyn SecretStore>>,
    /// 启动时探测 `claude --version`（最长 5 秒）
    pub probe_claude: bool,
    /// 事件通道容量
    pub event_capacity: usize,
    /// 主控端时间参数（测试里缩短）
    pub controller_timing: Option<ControllerTiming>,
    /// 由 Core 初始化日志（按天滚动文件，保留 7 天）。调用方已自己调用过 `logging::init` 时保持 false
    pub init_logging: bool,
    /// `init_logging` 时同时输出到 stderr
    pub log_to_stderr: bool,
    /// 受信的配置签名公钥（嵌入/测试用）。None：内置公钥，可被环境变量 `RTERM_CONFIG_PUBKEY` 覆盖
    /// （仅 debug 构建，或同时设置 `RTERM_ALLOW_CONFIG_PUBKEY_OVERRIDE=1`），见 `config_sig`。
    pub config_pubkeys: Option<Vec<[u8; 32]>>,
}

impl CoreOptions {
    pub fn new(kind: CoreKind, app_version: impl Into<String>) -> Self {
        Self {
            api_url: None,
            data_dir: None,
            app_version: app_version.into(),
            kind,
            rterm_cli: None,
            proxy: None,
            secrets: None,
            probe_claude: true,
            event_capacity: 1024,
            controller_timing: None,
            init_logging: false,
            log_to_stderr: false,
            config_pubkeys: None,
        }
    }
}

impl Default for CoreOptions {
    fn default() -> Self {
        Self::new(CoreKind::Desktop, env!("CARGO_PKG_VERSION"))
    }
}

/// 本机（被控端）信息，对应前端 `LocalInfo`（多出的字段前端可忽略）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    /// 9 位数字，不含空格；尚未注册时为空
    pub device_code: String,
    pub temp_password: String,
    /// 信令是否在线
    pub online: bool,
    pub fixed_password_set: bool,
    pub app_version: String,
    /// windows | macos | linux
    pub platform: String,
    /// 设备已向服务端注册、被控端已就绪
    pub registered: bool,
    /// 没有就绪时的明确原因（如“无法连接服务器”）
    pub last_error: Option<String>,
    /// 被锁定时的剩余秒数
    pub locked_remaining_secs: Option<u64>,
    /// 当前来访会话数（已完成握手的）
    pub active_sessions: usize,
}

/// 设备码显示格式：`123 456 789`。
pub fn format_device_code(code: &str) -> String {
    let d: Vec<char> = code.chars().collect();
    d.chunks(3)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 去掉用户输入设备码里的空格、短横线，必须是 9 位数字。
pub fn normalize_device_code(input: &str) -> CoreResult<String> {
    let s: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if s.len() == 9 && s.chars().all(|c| c.is_ascii_digit()) {
        Ok(s)
    } else {
        Err(CoreError::bad_request("设备码应为 9 位数字"))
    }
}

/// `Core::connect_with` 的参数。
#[derive(Clone, Default)]
pub struct ConnectParams {
    pub device_code: String,
    pub password: String,
    /// 用户已确认接受对方公钥的变化（上一次返回 `PEER_KEY_CHANGED` 后）
    pub accept_key_change: bool,
}

/// 手写 `Debug`：不打印密码，避免日后 `{:?}` 误把它写进日志。
impl std::fmt::Debug for ConnectParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectParams")
            .field("device_code", &mask_code(&self.device_code))
            .field("password", &"<隐藏>")
            .field("accept_key_change", &self.accept_key_change)
            .finish()
    }
}

/// `Core::open_term_ui` 的参数（对应前端 `TermOpenParams`）。
#[derive(Debug, Clone, Default)]
pub struct OpenTermParams {
    /// shell | claude | custom
    pub profile: String,
    pub shell_id: String,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
    pub command: String,
    pub launch: Option<LaunchOptionsDto>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------- 本地存储（配置 + 机密）

/// 配置和机密存储的组合。`Core` 内部用它，命令行在后台进程没运行时也用它直接读写。
#[derive(Clone)]
pub struct LocalStore {
    pub paths: Paths,
    pub config: Arc<ConfigStore>,
    pub secrets: Arc<dyn SecretStore>,
}

impl LocalStore {
    /// `data_dir` 为 None 时用平台标准目录（`RTERM_DATA_DIR` 可覆盖）。
    pub fn open(
        data_dir: Option<&Path>,
        secrets: Option<Arc<dyn SecretStore>>,
    ) -> CoreResult<Self> {
        let paths = match data_dir {
            Some(d) => Paths::from_root(d),
            None => Paths::standard()
                .ok_or_else(|| CoreError::new(codes::UNKNOWN, "无法确定数据目录"))?,
        };
        std::fs::create_dir_all(&paths.config_dir)
            .and_then(|_| std::fs::create_dir_all(&paths.data_dir))
            .map_err(|e| CoreError::new(codes::UNKNOWN, format!("无法创建数据目录：{e}")))?;
        let config = Arc::new(ConfigStore::open(paths.config_file())?);
        let secrets = secrets.unwrap_or_else(|| default_store(paths.secrets_dir()));
        Ok(Self {
            paths,
            config,
            secrets,
        })
    }

    pub fn settings(&self) -> Settings {
        Settings::from_config(&self.config.get())
    }

    /// 校验并保存设置（不做热生效；`Core::set_settings` 在此之上做热生效）。
    pub fn save_settings(&self, s: &Settings) -> CoreResult<()> {
        s.validate()?;
        self.config.update(|c| s.apply_to(c))?;
        Ok(())
    }

    pub fn device_code(&self) -> Option<String> {
        self.config.get().device.device_code
    }

    pub fn load_fixed_key(&self) -> Option<[u8; 32]> {
        self.load_fixed_key_checked().ok().flatten()
    }

    /// 区分"确实没有"（`Ok(None)`）和"读取失败"（`Err`）：后者不能当作"没设置固定密码"。
    pub fn load_fixed_key_checked(&self) -> Result<Option<[u8; 32]>, crate::secrets::SecretError> {
        Ok(self
            .secrets
            .get(FIXED_PW_KEY)?
            .and_then(|raw| <[u8; 32]>::try_from(raw.as_slice()).ok()))
    }

    pub fn store_fixed_key(&self, key: Option<[u8; 32]>) -> CoreResult<()> {
        let io = |e: crate::secrets::SecretError| CoreError::new(codes::UNKNOWN, e.to_string());
        match key {
            Some(k) => self.secrets.set(FIXED_PW_KEY, &k).map_err(io)?,
            None => self.secrets.delete(FIXED_PW_KEY).map_err(io)?,
        }
        self.config
            .update(|c| c.host.fixed_password_set = key.is_some())?;
        Ok(())
    }

    /// 没有后台进程在运行时直接设置/清除固定密码（有后台进程时应走它的 IPC，否则它内存里的密码不会变）。
    pub async fn set_fixed_password_offline(&self, pw: Option<&str>) -> CoreResult<()> {
        match pw.filter(|p| !p.is_empty()) {
            None => self.store_fixed_key(None),
            Some(p) => {
                let code = self.device_code().ok_or_else(|| {
                    CoreError::new(codes::NOT_REGISTERED, "本机还没有设备码，请先运行一次 host")
                })?;
                crate::host::guard::validate_fixed_password(p, &code)
                    .map_err(|e| CoreError::new(codes::WEAK_PASSWORD, e.to_string()))?;
                // 派生失败：不保存任何东西（审查 L2：不能把全零密钥存成固定密码）
                let key = derive_pw_key_async(p.to_string(), code)
                    .await
                    .map_err(|e| {
                        CoreError::new(codes::UNKNOWN, format!("密码处理失败，未保存：{e}"))
                    })?;
                self.store_fixed_key(Some(key))
            }
        }
    }
}

// ---------------------------------------------------------------- 内部结构

struct Runtime {
    /// 重建运行时（重新注册）时置位，旧运行时的后台任务据此退出
    stop: watch::Sender<bool>,
    device_code: String,
    identity: Arc<crate::identity::Identity>,
    signal: SignalClient,
    guard: Arc<Guard>,
    host: Arc<HostCtx>,
    ctrl: ControllerManager,
}

struct Incoming {
    from_code: String,
    platform: String,
    started_at_ms: u64,
    pending_confirm: bool,
    kick: Arc<Notify>,
}

#[derive(Default)]
struct ActionWaiters {
    waiters: HashMap<(SessionId, u64), oneshot::Sender<pb::TermActionResult>>,
    /// 先于登记到达的结果（最多留 64 条）
    early: VecDeque<((SessionId, u64), pb::TermActionResult)>,
}

#[derive(Default)]
struct RegState {
    last_error: Option<String>,
    last_notice: Option<String>,
}

enum BringUpError {
    /// 网络/服务端问题，稍后重试
    Retry(String),
    Fatal(CoreError),
}

struct Inner {
    kind: CoreKind,
    app_version: String,
    api_url: String,
    store: LocalStore,
    net: NetOptions,
    info: DeviceInfo,
    rterm_cli: Option<PathBuf>,
    probe_claude: bool,
    timing: ControllerTiming,
    events: mpsc::Sender<CoreEvent>,
    ctl_events: mpsc::Sender<CoreEvent>,
    rt: RwLock<Option<Arc<Runtime>>>,
    reg: Mutex<RegState>,
    bring_lock: tokio::sync::Mutex<()>,
    retry: Notify,
    shutdown: watch::Sender<bool>,
    incoming: Mutex<HashMap<SessionId, Incoming>>,
    confirms: Mutex<HashMap<SessionId, oneshot::Sender<Decision>>>,
    /// 主控设备码 -> 最近一次获准 / 会话结束的时刻（`RECONNECT_GRACE`）
    recent_ok: Mutex<HashMap<String, std::time::Instant>>,
    /// 持有它日志才会在退出前落盘
    _log: Option<crate::logging::LogGuard>,
    actions: Mutex<ActionWaiters>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    server_cfg: Mutex<Option<ServerConfig>>,
    /// 下发配置（适配器规则、动作目录）的受信签名公钥
    config_keys: Vec<[u8; 32]>,
}

/// 核心库门面。可克隆（内部是 `Arc`）。
#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn access_settings(c: &Config) -> AccessSettings {
    AccessSettings {
        enabled: c.host.enabled,
        require_confirm: c.host.require_confirm,
        temp_password_policy: match c.host.temp_password_policy.as_str() {
            "after_session" => TempPolicy::AfterSession,
            "manual" => TempPolicy::Manual,
            _ => TempPolicy::OnStart,
        },
        notify_on_connect: c.host.notify_on_connect,
        isolate_terminals: c.host.isolate_terminals,
        ..AccessSettings::default()
    }
}

fn term_config(c: &Config) -> TermConfig {
    TermConfig {
        max_terminals: c.host.max_terminals as usize,
        detached_ttl: (c.host.detached_term_ttl_hours > 0)
            .then(|| Duration::from_secs(c.host.detached_term_ttl_hours as u64 * 3600)),
        ..TermConfig::default()
    }
}

/// 桌面版：同目录下的 `rterm-cli`；CLI 版：自身。
pub fn default_rterm_cli(kind: CoreKind) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if kind == CoreKind::Cli {
        return Some(exe);
    }
    let name = if cfg!(windows) {
        "rterm-cli.exe"
    } else {
        "rterm-cli"
    };
    let sib = exe.parent()?.join(name);
    sib.is_file().then_some(sib)
}

impl Core {
    /// 启动：读配置、注册设备（必要时）、连信令。返回核心对象和事件接收端。
    /// 失败只会因为本地问题（数据目录不可写、配置版本过新、机密存储不可用）；服务端不可达见模块文档。
    pub async fn start(opts: CoreOptions) -> CoreResult<(Core, mpsc::Receiver<CoreEvent>)> {
        let store = LocalStore::open(opts.data_dir.as_deref(), opts.secrets.clone())?;
        let cfg = store.config.get();

        let api_url = opts
            .api_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                std::env::var("RTERM_API_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
            })
            .or_else(|| Some(cfg.server.api_url.clone()).filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());
        let net = NetOptions {
            proxy: opts.proxy.clone().or_else(|| cfg.server.proxy.clone()),
            use_system_certs: cfg.server.use_system_certs,
        };
        let rterm_cli = opts
            .rterm_cli
            .clone()
            .or_else(|| default_rterm_cli(opts.kind));

        let log_guard = if opts.init_logging {
            crate::logging::init(&store.paths.logs_dir(), opts.log_to_stderr)
        } else {
            None
        };
        let (ev_tx, ev_rx) = mpsc::channel(opts.event_capacity.max(16));
        let (ctl_tx, ctl_rx) = mpsc::channel(opts.event_capacity.max(16));
        let (shutdown, _) = watch::channel(false);
        let mut timing = opts.controller_timing.clone().unwrap_or_default();
        if opts.controller_timing.is_none() {
            // 每 5 秒一次 Ping/Pong，既用于保活也用于延迟上报
            timing.ping_interval = LATENCY_INTERVAL;
        }
        let inner = Arc::new(Inner {
            kind: opts.kind,
            app_version: opts.app_version.clone(),
            api_url,
            store,
            net,
            info: DeviceInfo::detect(&opts.app_version, opts.kind.as_str()),
            rterm_cli,
            probe_claude: opts.probe_claude,
            timing,
            events: ev_tx,
            ctl_events: ctl_tx,
            rt: RwLock::new(None),
            reg: Mutex::new(RegState::default()),
            bring_lock: tokio::sync::Mutex::new(()),
            retry: Notify::new(),
            shutdown,
            incoming: Mutex::new(HashMap::new()),
            confirms: Mutex::new(HashMap::new()),
            recent_ok: Mutex::new(HashMap::new()),
            _log: log_guard,
            actions: Mutex::new(ActionWaiters::default()),
            tasks: Mutex::new(Vec::new()),
            server_cfg: Mutex::new(None),
            config_keys: opts
                .config_pubkeys
                .clone()
                .unwrap_or_else(crate::config_sig::trusted_keys),
        });
        inner.spawn_task(forward_loop(inner.clone(), ctl_rx));

        match inner.bring_up().await {
            Ok(()) => {}
            Err(BringUpError::Fatal(e)) => return Err(e),
            Err(BringUpError::Retry(msg)) => {
                tracing::warn!("启动时无法完成注册/上线：{msg}，将在后台重试");
                lock(&inner.reg).last_error = Some(msg);
                inner.spawn_task(register_retry_loop(inner.clone()));
            }
        }
        Ok((Core { inner }, ev_rx))
    }

    fn rt(&self) -> CoreResult<Arc<Runtime>> {
        self.inner.rt_opt().ok_or_else(|| {
            let why = lock(&self.inner.reg).last_error.clone();
            CoreError::new(
                codes::NOT_REGISTERED,
                match why {
                    Some(w) => format!("尚未连接到服务器：{w}"),
                    None => "尚未连接到服务器".to_string(),
                },
            )
        })
    }

    fn ctrl(&self, session: &str) -> CoreResult<Controller> {
        Ok(self.rt()?.ctrl.get(session)?)
    }

    // ------------------------------------------------------------ 本机（被控）

    pub fn local_info(&self) -> LocalInfo {
        self.inner.local_info()
    }

    /// 刷新临时密码（Argon2 在 `spawn_blocking` 里算），返回新密码。
    pub async fn refresh_temp_password(&self) -> CoreResult<String> {
        let g = self.rt()?.guard.clone();
        let pw = tokio::task::spawn_blocking(move || g.refresh_temp_password())
            .await
            .map_err(|e| CoreError::new(codes::UNKNOWN, e.to_string()))?;
        Ok(pw)
    }

    /// 设置（Some）或清除（None / 空串）固定密码。弱密码返回 `WEAK_PASSWORD`。
    pub async fn set_fixed_password(&self, pw: Option<&str>) -> CoreResult<()> {
        let rt = self.rt()?;
        match pw.filter(|p| !p.is_empty()) {
            None => {
                rt.guard.clear_fixed_password();
                self.inner.store.store_fixed_key(None)?;
            }
            Some(p) => {
                let g = rt.guard.clone();
                let p = p.to_string();
                let key = tokio::task::spawn_blocking(move || g.set_fixed_password(&p))
                    .await
                    .map_err(|e| CoreError::new(codes::UNKNOWN, e.to_string()))?
                    .map_err(|e| CoreError::new(codes::WEAK_PASSWORD, e.to_string()))?;
                self.inner.store.store_fixed_key(Some(key))?;
            }
        }
        Ok(())
    }

    /// 来访会话（含等待确认的）。
    pub fn list_incoming(&self) -> Vec<IncomingSessionDto> {
        let mut v: Vec<_> = lock(&self.inner.incoming)
            .iter()
            .map(|(id, i)| IncomingSessionDto {
                session_id: id.clone(),
                from_code: i.from_code.clone(),
                platform: i.platform.clone(),
                started_at: i.started_at_ms,
                pending_confirm: i.pending_confirm,
            })
            .collect();
        v.sort_by_key(|i| i.started_at);
        v
    }

    /// 用户同意一个等待确认的来访连接。
    pub fn accept_incoming(&self, session: &str) -> CoreResult<()> {
        self.answer_confirm(session, Decision::Accept)
    }

    pub fn reject_incoming(&self, session: &str) -> CoreResult<()> {
        self.answer_confirm(session, Decision::Reject)
    }

    fn answer_confirm(&self, session: &str, d: Decision) -> CoreResult<()> {
        let tx = lock(&self.inner.confirms).remove(session);
        match tx {
            Some(tx) => {
                let _ = tx.send(d);
                Ok(())
            }
            None => Err(CoreError::bad_request(
                "没有等待确认的连接（可能对方已取消）",
            )),
        }
    }

    /// 断开一个来访会话（已连入的踢掉；等待确认的当作拒绝）。
    pub fn disconnect_incoming(&self, session: &str) {
        if self.answer_confirm(session, Decision::Reject).is_ok() {
            return;
        }
        if let Some(i) = lock(&self.inner.incoming).get(session) {
            i.kick.notify_one();
        }
    }

    /// 断开全部来访会话。
    pub fn disconnect_all_incoming(&self) {
        let ids: Vec<String> = lock(&self.inner.incoming).keys().cloned().collect();
        for id in ids {
            self.disconnect_incoming(&id);
        }
    }

    // ------------------------------------------------------------ 设置

    pub fn get_settings(&self) -> Settings {
        self.inner.store.settings()
    }

    /// 校验、持久化并热生效；返回保存后的设置，并发 `SettingsChanged`。
    ///
    /// 热生效：允许被连接、需确认、刷新策略、终端隔离、文件接收开关与上限、终端上限、保留时长。
    /// 重启后生效：代理/系统证书、默认 shell、Claude Code 集成与状态栏。
    pub async fn set_settings(&self, s: Settings) -> CoreResult<Settings> {
        s.validate()?;
        let before = self.inner.store.config.get();
        self.inner.store.save_settings(&s)?;
        let after = self.inner.store.config.get();
        if let Some(rt) = self.inner.rt_opt() {
            self.inner.apply_hot(&rt, &after);
            if before.host.enabled != after.host.enabled {
                let _ = rt.signal.presence_update(rt.guard.settings().enabled).await;
            }
            // 挂着等确认的来访随设置变化：暂停被控 -> 全部拒绝；关闭“连接确认” -> 全部放行
            if before.host.enabled && !after.host.enabled {
                self.inner.resolve_all_pending(Decision::Reject);
            } else if before.host.require_confirm && !after.host.require_confirm {
                self.inner.resolve_all_pending(Decision::Accept);
            }
        }
        let saved = Settings::from_config(&after);
        self.inner
            .emit(CoreEvent::SettingsChanged {
                settings: Box::new(saved.clone()),
            })
            .await;
        Ok(saved)
    }

    /// 命令行 `config get`：点分路径取值（空 = 全部）。
    pub fn config_get(&self, path: &str) -> CoreResult<serde_json::Value> {
        Ok(self.get_settings().get_path(path)?)
    }

    /// 命令行 `config set`。
    pub async fn config_set(&self, path: &str, value: &str) -> CoreResult<Settings> {
        let next = self.get_settings().with_path(path, value)?;
        self.set_settings(next).await
    }

    // ------------------------------------------------------------ 已记住的被控设备

    pub fn list_known_hosts(&self) -> Vec<KnownHostDto> {
        self.inner
            .store
            .config
            .get()
            .controller
            .known_hosts
            .into_iter()
            .map(|h| KnownHostDto {
                device_code: h.device_code,
                alias: h.alias,
                last_connected: h.last_connected,
            })
            .collect()
    }

    pub fn remove_known_host(&self, device_code: &str) -> CoreResult<()> {
        self.inner.store.config.update(|c| {
            c.controller
                .known_hosts
                .retain(|h| h.device_code != device_code)
        })?;
        Ok(())
    }

    pub fn set_known_host_alias(&self, device_code: &str, alias: Option<String>) -> CoreResult<()> {
        self.inner.store.config.update(|c| {
            if let Some(h) = c
                .controller
                .known_hosts
                .iter_mut()
                .find(|h| h.device_code == device_code)
            {
                h.alias = alias.filter(|a| !a.is_empty());
            }
        })?;
        Ok(())
    }

    // ------------------------------------------------------------ 主控

    pub async fn connect(&self, device_code: &str, password: &str) -> CoreResult<SessionId> {
        self.connect_with(ConnectParams {
            device_code: device_code.to_string(),
            password: password.to_string(),
            accept_key_change: false,
        })
        .await
    }

    /// 连接被控端。首次连接某设备时记住它的公钥（TOFU）；之后公钥变化返回 `PEER_KEY_CHANGED`，
    /// 用户确认后用 `accept_key_change = true` 重新调用。
    pub async fn connect_with(&self, p: ConnectParams) -> CoreResult<SessionId> {
        let rt = self.rt()?;
        let code = normalize_device_code(&p.device_code)?;
        if p.password.is_empty() {
            return Err(CoreError::bad_request("请输入密码"));
        }
        let known = self
            .inner
            .store
            .config
            .get()
            .known_host(&code)
            .and_then(|h| b64_decode(&h.public_key));
        let sid = rt
            .ctrl
            .connect_with(ConnectRequest {
                host_code: code.clone(),
                password: PasswordInput::Plain(p.password),
                known_host_key: known,
                accept_key_change: p.accept_key_change,
            })
            .await?;
        if let Ok(c) = rt.ctrl.get(&sid) {
            let pk = c.peer_public_key();
            if !pk.is_empty() {
                let _ = self
                    .inner
                    .store
                    .config
                    .update(|cfg| cfg.remember_host(&code, &b64(&pk), &now_iso()));
            }
        }
        Ok(sid)
    }

    pub async fn disconnect(&self, session: &str) -> CoreResult<()> {
        self.rt()?.ctrl.disconnect(session).await;
        Ok(())
    }

    /// 现有主控会话 id。
    pub fn sessions(&self) -> Vec<SessionId> {
        self.inner
            .rt_opt()
            .map(|rt| rt.ctrl.sessions())
            .unwrap_or_default()
    }

    /// 被控端能力和主机信息（最近一次 `HelloAck`）。
    pub fn host_snapshot(&self, session: &str) -> Option<crate::controller::HostSnapshot> {
        self.ctrl(session).ok().and_then(|c| c.host())
    }

    pub async fn open_term(&self, session: &str, opts: TermOpenOptions) -> CoreResult<TermId> {
        Ok(self.ctrl(session)?.open_term(opts).await?)
    }

    /// 同 `open_term`，参数和返回值对应前端契约（含标题、shell 名）。
    pub async fn open_term_ui(
        &self,
        session: &str,
        p: OpenTermParams,
    ) -> CoreResult<TermOpenedDto> {
        let profile = match p.profile.as_str() {
            "" | "shell" => TermProfile::Shell,
            "claude" => TermProfile::Claude,
            "custom" => TermProfile::Custom,
            other => return Err(CoreError::bad_request(format!("未知的终端类型：{other}"))),
        };
        let opts = TermOpenOptions {
            profile,
            shell_id: p.shell_id,
            cwd: p.cwd,
            size: TermSize::new(p.cols.max(1), p.rows.max(1)),
            command: p.command,
            launch: p.launch.map(Into::into),
        };
        let c = self.ctrl(session)?;
        let term_id = c.open_term(opts).await?;
        let (title, shell) = c.term_meta(&term_id).unwrap_or_default();
        Ok(TermOpenedDto {
            term_id,
            title,
            shell,
        })
    }

    pub async fn list_terms(&self, session: &str) -> CoreResult<Vec<TermInfoDto>> {
        let c = self.ctrl(session)?;
        let terms = c.list_terms().await?;
        Ok(terms
            .iter()
            .map(|t| {
                let shell = c.term_meta(&t.term_id).map(|m| m.1).unwrap_or_default();
                TermInfoDto::from_pb(t, shell)
            })
            .collect())
    }

    /// 附着到已有终端；被控端从本端已收到的偏移之后回放。被别的设备占用时返回 `TERM_BUSY`。
    pub async fn attach_term(&self, session: &str, term: &str, size: TermSize) -> CoreResult<()> {
        Ok(self.ctrl(session)?.attach_term(term, size).await?)
    }

    /// 同 `attach_term`，另指定界面已渲染到的流偏移 `from_seq`（前端 `lastSeq`）：从该处续传。
    /// 小于控制器已交付偏移时回退并重新交付 `[from_seq, …)`；`None` 等价于 `attach_term`。
    pub async fn attach_term_from(
        &self,
        session: &str,
        term: &str,
        size: TermSize,
        from_seq: Option<u64>,
    ) -> CoreResult<()> {
        Ok(self
            .ctrl(session)?
            .attach_term_from(term, size, from_seq)
            .await?)
    }

    /// 取消一个还没连上的连接（包括正在等对方确认的）。`session` 是 `SessionState(Connecting/AwaitingApproval)`
    /// 事件里的会话 id。返回是否找到；对应的 `connect` 调用随后返回 `CANCELLED`。
    pub fn cancel_connect(&self, session: &str) -> bool {
        self.inner
            .rt_opt()
            .is_some_and(|rt| rt.ctrl.cancel_connect(session))
    }

    pub async fn term_input(&self, session: &str, term: &str, data: Vec<u8>) -> CoreResult<()> {
        Ok(self.ctrl(session)?.term_input(term, data).await?)
    }

    pub async fn term_submit(
        &self,
        session: &str,
        term: &str,
        text: String,
        attachments: Vec<FileId>,
    ) -> CoreResult<u64> {
        Ok(self
            .ctrl(session)?
            .term_submit(term, text, attachments)
            .await?)
    }

    pub async fn term_resize(&self, session: &str, term: &str, size: TermSize) -> CoreResult<()> {
        Ok(self.ctrl(session)?.term_resize(term, size).await?)
    }

    /// 同步，不会阻塞；会话不存在时忽略。
    pub fn term_ack(&self, session: &str, term: &str, consumed: u64) {
        if let Some(rt) = self.inner.rt_opt() {
            rt.ctrl.term_ack(session, term, consumed);
        }
    }

    pub async fn close_term(&self, session: &str, term: &str) -> CoreResult<()> {
        Ok(self.ctrl(session)?.close_term(term).await?)
    }

    pub async fn upload(&self, session: &str, src: UploadSource) -> CoreResult<FileId> {
        Ok(self.ctrl(session)?.upload(src).await?)
    }

    /// 上传本机文件（目录返回 `IS_DIRECTORY`）。
    pub async fn upload_path(&self, session: &str, path: &Path) -> CoreResult<UploadStartedDto> {
        let md = tokio::fs::metadata(path)
            .await
            .map_err(|e| CoreError::new(codes::UNKNOWN, format!("无法读取文件：{e}")))?;
        if md.is_dir() {
            return Err(CoreError::new(codes::IS_DIRECTORY, "不能上传文件夹"));
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let file_id = self
            .upload(session, UploadSource::Path(path.to_path_buf()))
            .await?;
        Ok(UploadStartedDto {
            file_id,
            name,
            size: md.len(),
        })
    }

    /// 上传内存里的字节（剪贴板图片）。
    pub async fn upload_bytes(
        &self,
        session: &str,
        name: &str,
        mime: &str,
        data: Vec<u8>,
    ) -> CoreResult<UploadStartedDto> {
        let size = data.len() as u64;
        let file_id = self
            .upload(
                session,
                UploadSource::Bytes {
                    name: name.to_string(),
                    mime: mime.to_string(),
                    data,
                },
            )
            .await?;
        Ok(UploadStartedDto {
            file_id,
            name: name.to_string(),
            size,
        })
    }

    pub fn cancel_upload(&self, session: &str, file: FileId) {
        if let Some(rt) = self.inner.rt_opt() {
            rt.ctrl.cancel_upload(session, file);
        }
    }

    /// 执行动作目录里的动作，等待被控端的结果（最多 20 秒）。失败时错误码为被控端给的
    /// `UNSUPPORTED` / `BAD_REQUEST` / `APP_NOT_RUNNING` / `BUSY` / `TERM_NOT_FOUND`。
    pub async fn term_action(
        &self,
        session: &str,
        term: &str,
        action_id: &str,
        args: HashMap<String, String>,
    ) -> CoreResult<ActionOutcomeDto> {
        let c = self.ctrl(session)?;
        let req = c.term_action(term, action_id, args).await?;
        let key = (session.to_string(), req);
        let rx = {
            let mut a = lock(&self.inner.actions);
            if let Some(pos) = a.early.iter().position(|(k, _)| *k == key) {
                let (_, r) = a.early.remove(pos).unwrap_or_default();
                return action_outcome(r);
            }
            let (tx, rx) = oneshot::channel();
            a.waiters.insert(key.clone(), tx);
            rx
        };
        match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(r)) => action_outcome(r),
            _ => {
                lock(&self.inner.actions).waiters.remove(&key);
                Err(CoreError::new(codes::TIMEOUT, "被控端没有响应"))
            }
        }
    }

    pub async fn command_list_req(&self, session: &str, term: &str) -> CoreResult<()> {
        Ok(self.ctrl(session)?.command_list_req(term).await?)
    }

    // ------------------------------------------------------------ 网络 / 生命周期

    /// 睡眠唤醒、网络切换时调用：信令立即重连，主控会话立即重试，未注册则立即重试注册。
    pub fn network_changed(&self) {
        self.inner.retry.notify_one();
        if let Some(rt) = self.inner.rt_opt() {
            rt.signal.reconnect_now();
            rt.ctrl.reconnect_all_now();
        }
    }

    /// 立即重试注册 / 上线（首次启动没有服务端时）。
    pub fn retry_register(&self) {
        self.inner.retry.notify_one();
    }

    /// 把核心事件转成前端契约的 JSON 事件。`TermOutput` / `ActionResult` 返回 None。
    pub fn ui_event(&self, ev: &CoreEvent) -> Option<UiEvent> {
        dto::to_ui_event(ev, |sid| {
            self.ctrl(sid)
                .ok()
                .and_then(|c| c.host())
                .map(|h| {
                    let mut f: Vec<String> = h.features.into_iter().collect();
                    f.sort();
                    f
                })
                .unwrap_or_default()
        })
    }

    /// 服务端 `/config` 下发的内容（最近一次成功或缓存）。
    pub fn server_config(&self) -> Option<ServerConfig> {
        lock(&self.inner.server_cfg).clone()
    }

    pub fn paths(&self) -> &Paths {
        &self.inner.store.paths
    }

    pub fn kind(&self) -> CoreKind {
        self.inner.kind
    }

    pub fn api_url(&self) -> &str {
        &self.inner.api_url
    }

    /// 优雅退出：断开来访和主控会话、关闭全部终端、停掉后台任务。
    pub async fn shutdown(&self) {
        let _ = self.inner.shutdown.send(true);
        self.disconnect_all_incoming();
        if let Some(rt) = self.inner.rt_opt() {
            rt.signal.shutdown();
            for s in rt.ctrl.sessions() {
                rt.ctrl.disconnect(&s).await;
            }
            rt.host.shutdown().await;
        }
        let tasks: Vec<_> = lock(&self.inner.tasks).drain(..).collect();
        for t in tasks {
            t.abort();
        }
    }
}

fn action_outcome(r: pb::TermActionResult) -> CoreResult<ActionOutcomeDto> {
    if r.ok {
        return Ok(ActionOutcomeDto {
            passthrough: r.passthrough,
            return_keys: r.return_keys,
        });
    }
    // error 形如 "BUSY" 或 "BAD_REQUEST: 原因"
    let (code, msg) = match r.error.split_once(':') {
        Some((c, m)) => (c.trim().to_string(), m.trim().to_string()),
        None => (r.error.trim().to_string(), String::new()),
    };
    let code = if code.is_empty() {
        codes::UNKNOWN.to_string()
    } else {
        code
    };
    let message = if msg.is_empty() {
        match code.as_str() {
            "UNSUPPORTED" => "当前 Claude Code 版本不支持该操作".to_string(),
            "APP_NOT_RUNNING" => "终端里没有运行 Claude Code".to_string(),
            "BUSY" => "Claude Code 正忙，请稍后再试".to_string(),
            "TERM_NOT_FOUND" => "终端不存在".to_string(),
            _ => r.error.clone(),
        }
    } else {
        msg
    };
    Err(CoreError {
        code,
        message,
        data: None,
    })
}

// ---------------------------------------------------------------- 内部实现

impl Inner {
    fn rt_opt(&self) -> Option<Arc<Runtime>> {
        self.rt.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn spawn_task<F>(&self, f: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let h = tokio::spawn(f);
        let mut t = lock(&self.tasks);
        t.retain(|h| !h.is_finished());
        t.push(h);
    }

    async fn emit(&self, ev: CoreEvent) {
        let _ = self.events.send(ev).await;
    }

    fn local_info(&self) -> LocalInfo {
        let cfg = self.store.config.get();
        let last_error = lock(&self.reg).last_error.clone();
        match self.rt_opt() {
            Some(rt) => {
                let st = rt.guard.status();
                LocalInfo {
                    device_code: rt.device_code.clone(),
                    temp_password: st.temp_password,
                    online: rt.signal.is_online(),
                    fixed_password_set: st.has_fixed_password,
                    app_version: self.app_version.clone(),
                    platform: self.info.platform.clone(),
                    registered: true,
                    last_error,
                    locked_remaining_secs: st.locked_remaining.map(|d| d.as_secs().max(1)),
                    active_sessions: st.active_sessions,
                }
            }
            None => LocalInfo {
                device_code: cfg.device.device_code.unwrap_or_default(),
                temp_password: String::new(),
                online: false,
                fixed_password_set: cfg.host.fixed_password_set,
                app_version: self.app_version.clone(),
                platform: self.info.platform.clone(),
                registered: false,
                last_error,
                locked_remaining_secs: None,
                active_sessions: 0,
            },
        }
    }

    async fn emit_local_info(&self) {
        self.emit(CoreEvent::LocalInfoChanged {
            info: Box::new(self.local_info()),
        })
        .await;
    }

    /// 登记一个等待用户确认的来访（同步），返回接收决定的通道。
    fn register_pending(&self, inc: &IncomingConnect) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        lock(&self.confirms).insert(inc.session_id.clone(), tx);
        lock(&self.incoming).insert(
            inc.session_id.clone(),
            Incoming {
                from_code: inc.from.device_code.clone(),
                platform: inc.from.platform.clone(),
                started_at_ms: now_ms(),
                pending_confirm: true,
                kick: Arc::new(Notify::new()),
            },
        );
        rx
    }

    fn resolve_all_pending(&self, d: Decision) {
        let all: Vec<_> = lock(&self.confirms).drain().collect();
        for (_, tx) in all {
            let _ = tx.send(d);
        }
    }

    fn mark_approved(&self, from_code: &str) {
        let mut m = lock(&self.recent_ok);
        m.retain(|_, t| t.elapsed() < RECONNECT_GRACE);
        m.insert(from_code.to_string(), std::time::Instant::now());
    }

    fn recently_approved(&self, from_code: &str) -> bool {
        lock(&self.recent_ok)
            .get(from_code)
            .is_some_and(|t| t.elapsed() < RECONNECT_GRACE)
    }

    fn is_current(&self, rt: &Arc<Runtime>) -> bool {
        self.rt_opt().is_some_and(|c| Arc::ptr_eq(&c, rt))
    }

    /// 服务器不认识本设备（`UNKNOWN_DEVICE`）：拆掉当前运行时，清掉旧的设备登记，用同一把密钥重新注册并重建。
    /// 设备码会变；固定密码的派生值与设备码绑定，随之作废。进行中的来访会话和终端会被结束。
    async fn re_register(self: &Arc<Self>, old: Arc<Runtime>) {
        {
            let _g = self.bring_lock.lock().await;
            if !self.is_current(&old) {
                return; // 已经重建过
            }
            *self.rt.write().unwrap_or_else(|e| e.into_inner()) = None;
        }
        tracing::warn!("服务器不认识本设备，清除旧登记并重新注册");
        let _ = old.stop.send(true);
        old.signal.shutdown();
        let ids: Vec<String> = lock(&self.incoming).keys().cloned().collect();
        for id in ids {
            if let Some(i) = lock(&self.incoming).get(&id) {
                i.kick.notify_one();
            }
        }
        for s in old.ctrl.sessions() {
            old.ctrl.disconnect(&s).await;
        }
        old.host.shutdown().await;
        let _ = self.store.store_fixed_key(None);
        let _ = self.store.config.update(|c| {
            c.device.device_id = None;
            c.device.device_code = None;
        });
        self.emit(CoreEvent::Notice {
            level: "warn".into(),
            code: "RE_REGISTERED".into(),
            text: "服务器重置了设备登记，本机已重新注册（设备码已变化，固定密码已清除）".into(),
        })
        .await;
        match self.bring_up().await {
            Ok(()) => {}
            Err(BringUpError::Retry(msg)) => {
                lock(&self.reg).last_error = Some(msg);
                self.emit_local_info().await;
                self.spawn_task(register_retry_loop(self.clone()));
            }
            Err(BringUpError::Fatal(e)) => {
                lock(&self.reg).last_error = Some(e.message);
                self.emit_local_info().await;
            }
        }
    }

    /// 设置里能热生效的部分。
    fn apply_hot(&self, rt: &Runtime, cfg: &Config) {
        rt.guard.update_settings(access_settings(cfg));
        rt.host.set_file_receive(cfg.host.file_receive);
        rt.host.set_isolate_terminals(cfg.host.isolate_terminals);
        let total = rt.host.inbox.config().max_total;
        rt.host.inbox.set_limits(cfg.host.max_file_size, total);
        rt.host.terms.set_config(term_config(cfg));
    }

    fn host_config(&self, cfg: &Config) -> HostConfig {
        let mut h = HostConfig::new(self.store.paths.data_dir.clone());
        h.app_version = self.app_version.clone();
        h.file_receive = cfg.host.file_receive;
        h.max_file_size = cfg.host.max_file_size;
        h.term = term_config(cfg);
        h.rterm_cli = self.rterm_cli.clone();
        h.claude_integration = cfg.host.claude_integration;
        h.inject_statusline = cfg.host.claude_statusline;
        h.default_shell = cfg.host.default_shell.clone();
        h.isolate_terminals = cfg.host.isolate_terminals;
        h.probe_claude = self.probe_claude;
        h
    }

    /// 注册（必要时）并装配被控端、主控端、信令。已经就绪时什么都不做。
    ///
    /// 返回装箱的 future：`re_register` 与它互相调用，装箱才能打断 async 递归的类型推导环。
    fn bring_up(
        self: &Arc<Self>,
    ) -> futures_util::future::BoxFuture<'static, Result<(), BringUpError>> {
        let this = self.clone();
        Box::pin(async move { this.bring_up_impl().await })
    }

    async fn bring_up_impl(self: &Arc<Self>) -> Result<(), BringUpError> {
        let _g = self.bring_lock.lock().await;
        if self.rt_opt().is_some() {
            return Ok(());
        }
        let boot = bootstrap_with(
            self.store.config.clone(),
            self.store.secrets.clone(),
            &self.info,
            Some(&self.api_url),
        )
        .await
        .map_err(|e| match e {
            BootstrapError::Api(a) => BringUpError::Retry(describe_api_error(&a, &self.api_url)),
            // 钥匙串暂时读不出来（登录后尚未解锁等）：绝不能因此生成新的设备身份，等一会儿重试（审查 L7）
            BootstrapError::Secrets(s @ crate::secrets::SecretError::Unavailable(_)) => {
                BringUpError::Retry(format!("系统钥匙串暂时不可用，稍后重试（{s}）"))
            }
            other => BringUpError::Fatal(CoreError::from(other)),
        })?;
        let cfg = self.store.config.get();

        // 服务端配置：拿不到就用上次缓存的
        let server_cfg = self.fetch_server_config(&cfg).await;
        *lock(&self.server_cfg) = server_cfg.clone();

        // Guard：Argon2 放进 spawn_blocking
        let code = boot.device_code.clone();
        let access = access_settings(&cfg);
        let guard = tokio::task::spawn_blocking(move || Guard::new(&code, access))
            .await
            .map_err(|e| BringUpError::Fatal(CoreError::new(codes::UNKNOWN, e.to_string())))?;
        let fixed = self.store.load_fixed_key_checked();
        let fixed_read_ok = fixed.is_ok();
        if let Err(e) = &fixed {
            // 钥匙串暂时读不出来：不要改配置里的"已设置固定密码"，固定密码暂时不可用，下次启动再读
            tracing::warn!("读取固定密码失败（{e}），本次运行固定密码暂不可用，配置保持不变");
        }
        match fixed.unwrap_or(None) {
            Some(k) => {
                guard.load_fixed_pw_key(k);
                if !cfg.host.fixed_password_set {
                    let _ = self
                        .store
                        .config
                        .update(|c| c.host.fixed_password_set = true);
                }
            }
            None => {
                if cfg.host.fixed_password_set && fixed_read_ok {
                    tracing::warn!(
                        "配置里记录了固定密码，但机密存储里没有对应的密钥，已视为未设置"
                    );
                    let _ = self
                        .store
                        .config
                        .update(|c| c.host.fixed_password_set = false);
                }
            }
        }

        let host = HostCtx::new(self.host_config(&cfg)).await;
        host.bind_guard(&guard);
        if let Some(sc) = &server_cfg {
            apply_server_config_to_host(&host, sc, &self.config_keys);
        }

        let signal_url = resolve_signal_url(&self.api_url, server_cfg.as_ref());
        let mut sc = SignalConfig::new(
            signal_url,
            boot.device_id.clone(),
            boot.identity.clone(),
            &self.app_version,
            &self.info.platform,
        );
        sc.net = self.net.clone();
        // 只上报“允许被连接”，不含锁定：锁定期间保持在线，让服务端对主控端回 LOCKED（而不是 UNAVAILABLE）
        sc.accept = guard.settings().enabled;
        let (signal, sig_rx) = SignalClient::start(sc);

        let connector = Arc::new(SignalConnector::new(
            signal.clone(),
            boot.identity.clone(),
            self.net.clone(),
        ));
        let ctrl = ControllerManager::new(
            connector,
            self.ctl_events.clone(),
            self.app_version.clone(),
            self.timing.clone(),
        );
        let rt = Arc::new(Runtime {
            stop: watch::channel(false).0,
            device_code: boot.device_code.clone(),
            identity: boot.identity.clone(),
            signal,
            guard,
            host,
            ctrl,
        });
        *self.rt.write().unwrap_or_else(|e| e.into_inner()) = Some(rt.clone());
        lock(&self.reg).last_error = None;
        tracing::info!(
            "核心已就绪：设备码 {}，服务端 {}",
            mask_code(&boot.device_code),
            self.api_url
        );

        self.spawn_task(signal_loop(self.clone(), rt.clone(), sig_rx));
        self.spawn_task(guard_loop(self.clone(), rt.clone()));
        self.spawn_task(latency_loop(self.clone(), rt.clone()));
        self.spawn_task(config_refresh_loop(self.clone(), rt));
        if let Some(sc) = &server_cfg {
            self.check_server_notices(sc).await;
        }
        self.emit_local_info().await;
        Ok(())
    }

    async fn fetch_server_config(&self, cfg: &Config) -> Option<ServerConfig> {
        let cached = || {
            cfg.server
                .cached_config
                .clone()
                .and_then(|v| serde_json::from_value::<ServerConfig>(v).ok())
        };
        let api = match ApiClient::new(&self.api_url, &self.net) {
            Ok(a) => a,
            Err(_) => return cached(),
        };
        match tokio::time::timeout(Duration::from_secs(8), api.get_config()).await {
            Ok(Ok(sc)) => {
                if let Ok(v) = serde_json::to_value(&sc) {
                    let _ = self
                        .store
                        .config
                        .update(|c| c.server.cached_config = Some(v));
                }
                Some(sc)
            }
            Ok(Err(e)) => {
                tracing::warn!("获取服务端配置失败（{e}），使用缓存");
                cached()
            }
            Err(_) => {
                tracing::warn!("获取服务端配置超时，使用缓存");
                cached()
            }
        }
    }

    /// 最低版本检查和公告。
    async fn check_server_notices(&self, sc: &ServerConfig) {
        if let Some(min) = sc.min_app_version.as_deref().filter(|m| !m.is_empty()) {
            if let (Ok(cur), Ok(minv)) = (
                semver::Version::parse(&self.app_version),
                semver::Version::parse(min),
            ) {
                if cur < minv {
                    self.emit(CoreEvent::UpgradeRequired {
                        min_version: min.to_string(),
                        current_version: self.app_version.clone(),
                        latest_version: sc.latest_app_version.clone(),
                    })
                    .await;
                }
            }
        }
        if let Some(n) = sc.notice.as_ref().filter(|n| !n.is_null()) {
            let text = n
                .get("text")
                .and_then(|t| t.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| n.to_string());
            let level = n
                .get("level")
                .and_then(|t| t.as_str())
                .unwrap_or("info")
                .to_string();
            let fresh = {
                let mut r = lock(&self.reg);
                if r.last_notice.as_deref() == Some(text.as_str()) {
                    false
                } else {
                    r.last_notice = Some(text.clone());
                    true
                }
            };
            if fresh {
                self.emit(CoreEvent::Notice {
                    level,
                    code: "SERVER_NOTICE".into(),
                    text,
                })
                .await;
            }
        }
    }
}

fn describe_api_error(e: &ApiError, api_url: &str) -> String {
    match e {
        ApiError::Network(m) => format!("无法连接服务器 {api_url}（{m}）"),
        other => format!("服务器 {api_url} 返回错误：{other}"),
    }
}

/// `/config` 下发的适配器规则和动作目录。
///
/// 这两项会被写进被控端的 PTY，所以必须带有受信公钥的有效签名（审查 H1）：
/// 缺签名或验签失败时整份忽略，只用内置规则（并记日志）。签名有效之后还要过各自的语义校验
/// （`AdapterRules::validate`、`Catalog::validate`）。
fn apply_server_config_to_host(host: &HostCtx, sc: &ServerConfig, keys: &[[u8; 32]]) {
    if sc.adapters.is_empty() && sc.claude_catalog.is_empty() {
        host.reset_adapter_rules();
        host.set_remote_catalog_json(None);
        return;
    }
    if let Err(e) = crate::config_sig::verify_server_config(sc, keys) {
        tracing::warn!("下发的适配器规则/动作目录没有通过签名校验（{e}），已忽略，使用内置规则");
        host.reset_adapter_rules();
        host.set_remote_catalog_json(None);
        return;
    }
    if !sc.adapters.is_empty() {
        let json = serde_json::json!({ "adapters": sc.adapters }).to_string();
        if let Err(e) = host.set_adapter_rules_json(&json) {
            tracing::warn!("下发的输入适配器规则无效，继续使用旧规则：{e}");
        }
    }
    if sc.claude_catalog.is_empty() {
        host.set_remote_catalog_json(None);
    } else {
        let json = serde_json::Value::Array(sc.claude_catalog.clone()).to_string();
        host.set_remote_catalog_json(Some(&json));
    }
}

fn close_code(r: &CloseReason) -> &'static str {
    match r {
        CloseReason::User => "USER",
        CloseReason::BadPassword => codes::PASSWORD_WRONG,
        CloseReason::PeerKeyChanged => codes::PEER_KEY_CHANGED,
        CloseReason::Refused(_) => "REFUSED",
        CloseReason::Cancelled => "CANCELLED",
        CloseReason::HostBye(_) => "HOST_BYE",
        CloseReason::ConsumerGone => "CONSUMER_GONE",
    }
}

// ---------------------------------------------------------------- 后台任务

/// 主控端事件转发：拦截 `ActionResult` 交给等待者，会话关闭时补一条带原因码的 `SessionClosed`。
async fn forward_loop(inner: Arc<Inner>, mut rx: mpsc::Receiver<CoreEvent>) {
    while let Some(ev) = rx.recv().await {
        let mut extra = None;
        match &ev {
            CoreEvent::ActionResult {
                session, result, ..
            } => {
                let key = (session.clone(), result.req_id);
                let mut a = lock(&inner.actions);
                if let Some(tx) = a.waiters.remove(&key) {
                    let _ = tx.send(result.clone());
                } else {
                    a.early.push_back((key, result.clone()));
                    while a.early.len() > 64 {
                        a.early.pop_front();
                    }
                }
            }
            CoreEvent::SessionState {
                session,
                state: crate::events::SessionState::Closed(text),
            } => {
                let (code, reason) = inner
                    .rt_opt()
                    .and_then(|rt| rt.ctrl.get(session).ok())
                    .and_then(|c| c.close_reason())
                    .map(|r| (close_code(&r), r.text()))
                    .unwrap_or(("CLOSED", text.clone()));
                extra = Some(CoreEvent::SessionClosed {
                    session: session.clone(),
                    code: code.to_string(),
                    reason,
                });
            }
            _ => {}
        }
        if inner.events.send(ev).await.is_err() {
            break;
        }
        if let Some(e) = extra {
            if inner.events.send(e).await.is_err() {
                break;
            }
        }
    }
}

async fn register_retry_loop(inner: Arc<Inner>) {
    let mut delay = Duration::from_secs(2);
    let mut stop = inner.shutdown.subscribe();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = inner.retry.notified() => {}
            _ = stop.changed() => return,
        }
        match inner.bring_up().await {
            Ok(()) => return,
            Err(BringUpError::Retry(msg)) => {
                tracing::warn!("重试注册/上线失败：{msg}");
                lock(&inner.reg).last_error = Some(msg);
                inner.emit_local_info().await;
                delay = (delay * 2).min(Duration::from_secs(30));
            }
            Err(BringUpError::Fatal(e)) => {
                tracing::error!("启动失败：{e}");
                lock(&inner.reg).last_error = Some(e.message);
                inner.emit_local_info().await;
                return;
            }
        }
    }
}

async fn signal_loop(inner: Arc<Inner>, rt: Arc<Runtime>, mut rx: mpsc::Receiver<SignalEvent>) {
    while let Some(ev) = rx.recv().await {
        match ev {
            SignalEvent::State { online, .. } => {
                inner.emit(CoreEvent::SignalState { online }).await;
            }
            SignalEvent::Incoming(inc) => {
                // 准入判断和待确认登记必须在这里同步完成：紧随其后的 IncomingCancelled 要能找到它
                let mut adm = rt.guard.admit();
                if adm == Admission::NeedConfirm && inner.recently_approved(&inc.from.device_code) {
                    adm = Admission::Allow;
                }
                let pending = (adm == Admission::NeedConfirm).then(|| inner.register_pending(&inc));
                let (inner, rt) = (inner.clone(), rt.clone());
                tokio::spawn(handle_incoming(inner, rt, inc, adm, pending));
            }
            SignalEvent::IncomingCancelled { session_id } => {
                // 主控方取消了等待：通知 handle_incoming 撤掉弹窗（已经放行、在等 connect.go 的由 accept 返回 Cancelled）
                if let Some(tx) = lock(&inner.confirms).remove(&session_id) {
                    let _ = tx.send(Decision::Cancelled);
                }
            }
            SignalEvent::Kick { reason } => {
                let text = if reason == "replaced" {
                    "此设备已在别处登录，本机已下线".to_string()
                } else {
                    format!("被服务器踢下线（{reason}）")
                };
                inner
                    .emit(CoreEvent::Notice {
                        level: "warn".into(),
                        code: "KICK".into(),
                        text,
                    })
                    .await;
            }
            SignalEvent::Notice { level, text } => {
                inner
                    .emit(CoreEvent::Notice {
                        level,
                        code: "SERVER_NOTICE".into(),
                        text,
                    })
                    .await;
            }
            SignalEvent::AuthError { code } => {
                if code == "UNKNOWN_DEVICE" {
                    // 服务器不认识本设备（数据被重置、设备被删除）：清掉旧登记，用同一把密钥重新注册
                    let (inner, rt) = (inner.clone(), rt.clone());
                    tokio::spawn(async move { inner.re_register(rt).await });
                } else if code == "VERSION" {
                    let sc = lock(&inner.server_cfg).clone().unwrap_or_default();
                    inner
                        .emit(CoreEvent::UpgradeRequired {
                            min_version: sc.min_app_version.unwrap_or_default(),
                            current_version: inner.app_version.clone(),
                            latest_version: sc.latest_app_version,
                        })
                        .await;
                } else {
                    let text = match code.as_str() {
                        "BANNED" => "本设备已被封禁".to_string(),
                        other => format!("信令认证失败（{other}）"),
                    };
                    inner
                        .emit(CoreEvent::Notice {
                            level: "error".into(),
                            code,
                            text,
                        })
                        .await;
                }
            }
        }
    }
}

async fn guard_loop(inner: Arc<Inner>, rt: Arc<Runtime>) {
    let mut rx = rt.guard.subscribe();
    let mut stop = rt.stop.subscribe();
    loop {
        let ev = tokio::select! {
            ev = rx.recv() => ev,
            _ = stop.changed() => return,
        };
        match ev {
            Ok(GuardEvent::TempPasswordChanged | GuardEvent::FixedPasswordChanged) => {
                inner.emit_local_info().await;
            }
            Ok(GuardEvent::SettingsChanged) => {
                let _ = rt.signal.presence_update(rt.guard.settings().enabled).await;
                inner.emit_local_info().await;
            }
            Ok(GuardEvent::HostLocked { secs }) => {
                inner.emit_local_info().await;
                inner
                    .emit(CoreEvent::Notice {
                        level: "warn".into(),
                        code: "HOST_LOCKED".into(),
                        text: format!("密码连续输错，已临时锁定 {} 分钟", secs.div_ceil(60)),
                    })
                    .await;
                // 锁定到期后刷新界面状态
                let inner2 = inner.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(secs + 1)).await;
                    inner2.emit_local_info().await;
                });
            }
            Ok(GuardEvent::AuthFailed) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                inner.emit_local_info().await;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn latency_loop(inner: Arc<Inner>, rt: Arc<Runtime>) {
    let mut tick = tokio::time::interval(LATENCY_INTERVAL);
    let mut stop = rt.stop.subscribe();
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = stop.changed() => return,
        }
        for sid in rt.ctrl.sessions() {
            if let Some(ms) = rt.ctrl.get(&sid).ok().and_then(|c| c.rtt_ms()) {
                inner.emit(CoreEvent::Latency { session: sid, ms }).await;
            }
        }
    }
}

async fn config_refresh_loop(inner: Arc<Inner>, rt: Arc<Runtime>) {
    let mut stop = rt.stop.subscribe();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(CONFIG_REFRESH) => {}
            _ = stop.changed() => return,
        }
        let api = match ApiClient::new(&inner.api_url, &inner.net) {
            Ok(a) => a,
            Err(_) => continue,
        };
        if let Ok(Ok(sc)) = tokio::time::timeout(Duration::from_secs(10), api.get_config()).await {
            if let Ok(v) = serde_json::to_value(&sc) {
                let _ = inner
                    .store
                    .config
                    .update(|c| c.server.cached_config = Some(v));
            }
            apply_server_config_to_host(&rt.host, &sc, &inner.config_keys);
            inner.check_server_notices(&sc).await;
            *lock(&inner.server_cfg) = Some(sc);
        }
    }
}

/// 处理一个来访连接（被控端），见模块文档。
async fn handle_incoming(
    inner: Arc<Inner>,
    rt: Arc<Runtime>,
    inc: IncomingConnect,
    adm: Admission,
    pending: Option<oneshot::Receiver<Decision>>,
) {
    let sid = inc.session_id.clone();
    let from = inc.from.device_code.clone();
    let platform = inc.from.platform.clone();
    let tag = mask_code(&from);

    let mut announced = false;
    match adm {
        Admission::Reject { reason } => {
            tracing::info!(session = %sid, from = %tag, "拒绝来访连接：{reason}");
            let _ = rt.signal.reject(&sid, reason).await;
            return;
        }
        Admission::Allow => {}
        Admission::NeedConfirm => {
            // 一直挂着，直到用户处理、主控方取消，或被控端设置变化（见 `Core::set_settings`）
            inner
                .emit(CoreEvent::IncomingSession {
                    session: sid.clone(),
                    from_code: from.clone(),
                    platform: platform.clone(),
                    started_at_ms: now_ms(),
                    pending_confirm: true,
                })
                .await;
            announced = true;
            let decision = match pending {
                Some(rx) => rx.await.unwrap_or(Decision::Cancelled),
                None => Decision::Cancelled,
            };
            lock(&inner.confirms).remove(&sid);
            if decision != Decision::Accept {
                tracing::info!(session = %sid, from = %tag, "来访连接未被确认：{decision:?}");
                if decision == Decision::Reject {
                    let _ = rt.signal.reject(&sid, "user").await;
                } else {
                    inner
                        .emit(CoreEvent::Notice {
                            level: "info".into(),
                            code: "INCOMING_CANCELLED".into(),
                            text: "对方已取消连接请求".into(),
                        })
                        .await;
                }
                lock(&inner.incoming).remove(&sid);
                inner
                    .emit(CoreEvent::IncomingClosed {
                        session: sid.clone(),
                    })
                    .await;
                return;
            }
            inner.mark_approved(&from);
        }
    }

    // 握手中的会话也占用并发上限（`Guard::admit` 只看得到已建立的会话）。名额在握手结束（成功、失败、取消）时归还
    let Some(slot) = rt.guard.begin_handshake() else {
        tracing::info!(session = %sid, from = %tag, "拒绝来访连接：并发会话数已满（含握手中）");
        let _ = rt.signal.reject(&sid, "busy").await;
        lock(&inner.incoming).remove(&sid);
        if announced {
            inner
                .emit(CoreEvent::IncomingClosed {
                    session: sid.clone(),
                })
                .await;
        }
        return;
    };

    // accept 会等待服务端下发 connect.go（中继地址和票据，同意之后才签发）
    let go = match rt.signal.accept(&sid).await {
        Ok(go) => go,
        Err(e) => {
            lock(&inner.incoming).remove(&sid);
            if matches!(e, crate::signal::SignalError::Cancelled) {
                inner
                    .emit(CoreEvent::Notice {
                        level: "info".into(),
                        code: "INCOMING_CANCELLED".into(),
                        text: "对方已取消连接请求".into(),
                    })
                    .await;
            }
            if announced {
                inner
                    .emit(CoreEvent::IncomingClosed {
                        session: sid.clone(),
                    })
                    .await;
            }
            return;
        }
    };

    let passwords: Arc<dyn HostPasswords> = rt.guard.clone();
    let result = establish_host(HostParams {
        relay_url: go.relay_url.clone(),
        ticket: go.ticket.clone(),
        session_id: sid.clone(),
        identity: rt.identity.clone(),
        host_code: rt.device_code.clone(),
        // 主控设备码：信令下发，握手里用同一条消息里的公钥验签认证，
        // 被控端据此识别“同一台主控”（终端隔离）
        controller_code: from.clone(),
        controller_public_key: inc.from.public_key.clone(),
        controller_platform: platform.clone(),
        passwords,
        net: inner.net.clone(),
    })
    .await;

    match result {
        Ok((link, _handle)) => {
            rt.guard.report_auth_success();
            drop(slot);
            let _ = rt.signal.session_report(&sid, "auth_ok", None).await;
            let kick = Arc::new(Notify::new());
            let started = now_ms();
            lock(&inner.incoming).insert(
                sid.clone(),
                Incoming {
                    from_code: from.clone(),
                    platform: platform.clone(),
                    started_at_ms: started,
                    pending_confirm: false,
                    kick: kick.clone(),
                },
            );
            inner
                .emit(CoreEvent::IncomingSession {
                    session: sid.clone(),
                    from_code: from.clone(),
                    platform,
                    started_at_ms: started,
                    pending_confirm: false,
                })
                .await;
            inner.emit_local_info().await;
            tracing::info!(session = %sid, from = %tag, "来访会话已建立");
            let end = HostSession::run_with_kick(link, rt.host.clone(), kick).await;
            tracing::info!(session = %sid, from = %tag, "来访会话结束：{end:?}");
            rt.guard.report_session_end();
            inner.mark_approved(&from);
            let _ = rt
                .signal
                .session_report(
                    &sid,
                    "closed",
                    Some(serde_json::json!({ "reason": format!("{end:?}") })),
                )
                .await;
            lock(&inner.incoming).remove(&sid);
            inner
                .emit(CoreEvent::IncomingClosed {
                    session: sid.clone(),
                })
                .await;
            inner.emit_local_info().await;
        }
        Err(e) => {
            tracing::info!(session = %sid, from = %tag, "来访握手失败：{e}");
            if matches!(e, EstablishError::BadPassword) {
                let locked = rt.guard.report_auth_failure();
                let _ = rt
                    .signal
                    .session_report(
                        &sid,
                        "auth_failed",
                        Some(serde_json::json!({ "reason": "bad_password" })),
                    )
                    .await;
                if let Some(d) = locked {
                    let _ = rt
                        .signal
                        .session_report(
                            &sid,
                            "host_locked",
                            Some(serde_json::json!({ "secs": d.as_secs() })),
                        )
                        .await;
                }
            }
            lock(&inner.incoming).remove(&sid);
            if announced {
                inner
                    .emit(CoreEvent::IncomingClosed {
                        session: sid.clone(),
                    })
                    .await;
            }
            inner.emit_local_info().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_code_helpers() {
        assert_eq!(format_device_code("123456789"), "123 456 789");
        assert_eq!(normalize_device_code("123 456-789").unwrap(), "123456789");
        assert!(normalize_device_code("12345").is_err());
        assert!(normalize_device_code("12345678a").is_err());
    }

    #[test]
    fn action_error_parsing() {
        let e = action_outcome(pb::TermActionResult {
            ok: false,
            error: "BAD_REQUEST: 参数 model 不合法".into(),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.code, "BAD_REQUEST");
        assert!(e.message.contains("model"));
        let e = action_outcome(pb::TermActionResult {
            ok: false,
            error: "BUSY".into(),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.code, "BUSY");
        let ok = action_outcome(pb::TermActionResult {
            ok: true,
            passthrough: true,
            return_keys: vec!["esc".into()],
            ..Default::default()
        })
        .unwrap();
        assert!(ok.passthrough);
    }

    #[tokio::test]
    async fn local_store_fixed_password_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let store = LocalStore::open(
            Some(d.path()),
            Some(Arc::new(crate::secrets::MemoryStore::default())),
        )
        .unwrap();
        // 没有设备码时不能设
        assert!(store
            .set_fixed_password_offline(Some("Hunter2-xyz!"))
            .await
            .is_err());
        store
            .config
            .update(|c| c.device.device_code = Some("482913675".into()))
            .unwrap();
        // 弱密码
        let e = store
            .set_fixed_password_offline(Some("12345678"))
            .await
            .unwrap_err();
        assert_eq!(e.code, "WEAK_PASSWORD");
        store
            .set_fixed_password_offline(Some("Hunter2-xyz!"))
            .await
            .unwrap();
        assert!(store.config.get().host.fixed_password_set);
        assert!(store.load_fixed_key().is_some());
        store.set_fixed_password_offline(None).await.unwrap();
        assert!(!store.config.get().host.fixed_password_set);
        assert!(store.load_fixed_key().is_none());
    }

    #[tokio::test]
    async fn start_without_server_does_not_crash_and_reports_reason() {
        let d = tempfile::tempdir().unwrap();
        let mut o = CoreOptions::new(CoreKind::Cli, "0.1.0");
        o.data_dir = Some(d.path().to_path_buf());
        // 一个不会有人监听的端口
        o.api_url = Some("http://127.0.0.1:9".into());
        o.proxy = Some(String::new());
        o.secrets = Some(Arc::new(crate::secrets::MemoryStore::default()));
        o.probe_claude = false;
        let (core, _rx) = Core::start(o).await.expect("服务端不可达时 start 不应失败");
        let info = core.local_info();
        assert!(!info.registered);
        assert!(info
            .last_error
            .as_deref()
            .unwrap_or("")
            .contains("无法连接服务器"));
        let e = core.connect("123456789", "abc23456").await.unwrap_err();
        assert_eq!(e.code, "NOT_REGISTERED");
        // 设置在未注册时也能读写
        let mut s = core.get_settings();
        s.host.require_confirm = true;
        let saved = core.set_settings(s).await.unwrap();
        assert!(saved.host.require_confirm);
        core.retry_register();
        core.shutdown().await;
    }
    // ---- 审查 H1：下发的规则必须有有效签名 ----

    fn sign_cfg(sk: &ed25519_dalek::SigningKey, sc: &mut ServerConfig) {
        use base64::Engine;
        use ed25519_dalek::Signer;
        let msg = crate::config_sig::signed_bytes(&sc.adapters, &sc.claude_catalog).expect("msg");
        sc.config_sig =
            Some(base64::engine::general_purpose::STANDARD.encode(sk.sign(&msg).to_bytes()));
    }

    fn claude_delay(host: &HostCtx) -> u64 {
        let env = host.exec_env();
        let rules = env.rules.read().expect("rules");
        rules
            .select(&crate::host::adapter::MatchCtx {
                profile: "CLAUDE",
                claude_version: None,
            })
            .submit_delay_ms
    }

    #[tokio::test]
    async fn server_rules_are_applied_only_when_signed() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut hc = crate::host::session::HostConfig::new(dir.path().to_path_buf());
        hc.claude_integration = false;
        hc.probe_claude = false;
        let host = HostCtx::new(hc).await;
        let sk = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]);
        let keys = [sk.verifying_key().to_bytes()];
        let builtin_delay = claude_delay(&host);
        assert_eq!(builtin_delay, 80);

        let rule = |delay: u64, fallback: &str| {
            serde_json::json!({
                "id": "claude-code", "match": {"profile": "CLAUDE"}, "paste": "bracketed",
                "newline_in_paste": "\n", "submit_delay_ms": delay, "submit_key": "\r",
                "fallback_newline": fallback
            })
        };
        let mut sc = ServerConfig {
            adapters: vec![rule(777, "\r")],
            ..Default::default()
        };

        // 没有签名：忽略
        apply_server_config_to_host(&host, &sc, &keys);
        assert_eq!(claude_delay(&host), builtin_delay, "无签名的规则不能生效");

        // 别人的签名：忽略
        sign_cfg(&ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]), &mut sc);
        apply_server_config_to_host(&host, &sc, &keys);
        assert_eq!(claude_delay(&host), builtin_delay, "错误密钥的签名不能生效");

        // 有效签名：生效
        sign_cfg(&sk, &mut sc);
        apply_server_config_to_host(&host, &sc, &keys);
        assert_eq!(claude_delay(&host), 777);

        // 签名有效之后内容被改：恢复内置规则，而不是继续用上一份
        let mut tampered = sc.clone();
        tampered.adapters = vec![rule(1, "\r")];
        apply_server_config_to_host(&host, &tampered, &keys);
        assert_eq!(claude_delay(&host), builtin_delay);

        // 再次生效后，下一次拿到的配置没有签名（例如服务端被换成了没密钥的）：也恢复内置
        apply_server_config_to_host(&host, &sc, &keys);
        assert_eq!(claude_delay(&host), 777);
        sc.config_sig = None;
        apply_server_config_to_host(&host, &sc, &keys);
        assert_eq!(claude_delay(&host), builtin_delay);

        // 签名有效但内容是报告 H1 的注入规则：语义校验拒绝，不生效
        let mut evil = ServerConfig {
            adapters: vec![rule(1234, "\r;id>x;\r")],
            ..Default::default()
        };
        sign_cfg(&sk, &mut evil);
        apply_server_config_to_host(&host, &evil, &keys);
        assert_eq!(
            claude_delay(&host),
            builtin_delay,
            "危险规则即使签名有效也不能生效"
        );

        // 签名有效的动作目录生效；无签名的被忽略
        let cat = serde_json::json!({
            "catalog_ver": "signed-1", "app": "claude",
            "actions": [{"id": "a.b", "title": "t", "kind": "submit", "steps": [{"submit": "/clear"}]}]
        });
        let mut with_cat = ServerConfig {
            adapters: vec![rule(80, "\r")],
            claude_catalog: vec![cat],
            ..Default::default()
        };
        apply_server_config_to_host(&host, &with_cat, &keys);
        assert_ne!(host.catalog().catalog_ver, "signed-1");
        sign_cfg(&sk, &mut with_cat);
        apply_server_config_to_host(&host, &with_cat, &keys);
        assert_eq!(host.catalog().catalog_ver, "signed-1");
        with_cat.claude_catalog[0]["actions"][0]["steps"][0]["submit"] = serde_json::json!("!calc");
        apply_server_config_to_host(&host, &with_cat, &keys);
        assert_ne!(
            host.catalog().catalog_ver,
            "signed-1",
            "被改动的目录必须被丢弃"
        );
    }
    #[test]
    fn connect_params_debug_hides_password() {
        let p = ConnectParams {
            device_code: "123456789".into(),
            password: "S3cret-Pass-Word".into(),
            accept_key_change: false,
        };
        let text = format!("{p:?}");
        assert!(!text.contains("S3cret"), "{text}");
        assert!(!text.contains("123456789"), "{text}");
        assert!(text.contains("<隐藏>"));
    }
}
