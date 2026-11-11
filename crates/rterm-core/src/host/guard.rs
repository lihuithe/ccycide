//! 接入控制：临时密码、固定密码、失败锁定、接入设置（《实现方案.md》5.5.6、8.2，《开发指南.md》T30、T31）。
//!
//! 门面（Core）需要做的事：
//! - 创建一个 `Arc<Guard>`，同时把它交给网络层作为 `HostPasswords`；
//! - 收到 `connect.incoming` 时调用 [`Guard::admit`]：`Reject` 就回 `connect.reject`，`NeedConfirm` 就弹窗等用户确认；
//! - 握手失败（密码错误）调用 [`Guard::report_auth_failure`]；握手成功调用 [`Guard::report_auth_success`]；
//!   会话结束调用 [`Guard::report_session_end`]（"每次会话结束后刷新"策略靠它）；
//! - 订阅 [`Guard::subscribe`]：`AuthFailed` / `HostLocked` 事件要向信令发 `session.report`，
//!   `TempPasswordChanged` 要刷新界面；
//! - 固定密码：`set_fixed_password` 返回 `pw_key`，由门面存进系统钥匙串；启动时用 `load_fixed_pw_key` 恢复；
//! - 设置变更调用 `update_settings`；"允许被远程连接"变化时门面要重新向信令上报 `accept`。
//!
//! 所有会跑 Argon2id 的函数（`new`、`refresh_temp_password`、`set_fixed_password`）是同步阻塞的
//! （约几十到一百多毫秒），在异步环境里请放进 `spawn_blocking`。
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::crypto::CryptoError;
use crate::host::weak_passwords;
use crate::link::HostPasswords;

/// 临时密码字符集：去掉了易混淆的 `0 O 1 l I`（及 `i`、`o`）。
pub const TEMP_CHARSET: &str = "abcdefghjkmnpqrstuvwxyz23456789";
pub const TEMP_PASSWORD_LEN: usize = 8;
/// 固定密码最少位数（审查 M4：8 位太短，在线猜测 + 常见密码表约两个月即可命中）。
pub const MIN_FIXED_LEN: usize = 10;
/// 固定密码至少包含的字符类别数（小写、大写、数字、其他符号/非 ASCII 字符）。
pub const MIN_FIXED_CLASSES: usize = 3;

/// 失败窗口与初始锁定时长。
pub const FAIL_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const FAIL_LIMIT: usize = 5;
pub const BASE_LOCK: Duration = Duration::from_secs(10 * 60);
pub const MAX_LOCK: Duration = Duration::from_secs(24 * 3600);
/// 锁定级别的衰减时间：从最近一次锁定结束（或最近一次失败）算起，连续这么久没有失败，级别才归零。
/// 必须远大于 `MAX_LOCK`：封顶的 24 小时锁定一结束就归零，等于把在线猜测速率固定在约 16 次/天（审查 M4）。
pub const RESET_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

/// 口令派生函数：`(密码, 设备码) -> pw_key`。默认是 `crypto::derive_pw_key`，测试里可以注入。
/// 派生失败返回错误，调用方必须当作失败处理，绝不能退化成全零之类的固定密钥（审查 L2）。
pub type Kdf = Arc<dyn Fn(&str, &str) -> Result<[u8; 32], CryptoError> + Send + Sync>;
type NowFn = Arc<dyn Fn() -> Instant + Send + Sync>;

/// 临时密码刷新策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TempPolicy {
    /// 每次启动刷新（默认）
    #[default]
    OnStart,
    /// 每次会话结束后刷新
    AfterSession,
    /// 仅手动刷新
    Manual,
}

/// 接入设置（`/config` 里 `host` 段的子集，字段名与《实现方案.md》17.2 一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AccessSettings {
    /// 允许被远程连接。关闭后信令上报 `accept: false`，`admit` 拒绝一切。
    pub enabled: bool,
    /// 每次连接需要在被控端点击同意
    pub require_confirm: bool,
    pub temp_password_policy: TempPolicy,
    /// 有人连入时系统通知、托盘变色（由界面层使用）
    pub notify_on_connect: bool,
    /// 同时连接数上限
    pub max_sessions: usize,
    /// 终端隔离：开启时每台主控设备只能看到、附着、关闭自己创建的终端（默认开）。
    /// 关闭后所有主控设备互相可见。运行中可改，对新请求立即生效，已附着的不强制踢。
    /// 门面要把它同步给 `HostCtx`（`HostCtx::bind_guard` 或 `set_isolate_terminals`）。
    pub isolate_terminals: bool,
}

impl Default for AccessSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            require_confirm: false,
            temp_password_policy: TempPolicy::OnStart,
            notify_on_connect: true,
            max_sessions: 100,
            isolate_terminals: true,
        }
    }
}

/// `admit` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// 直接进入握手
    Allow,
    /// 需要用户在被控端点击同意（10 秒内不操作视为拒绝，由界面层处理）
    NeedConfirm,
    /// 拒绝，`reason` 用于 `connect.reject`：`disabled` / `locked` / `busy`
    Reject { reason: &'static str },
}

/// 守卫发出的事件，门面据此向信令上报。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardEvent {
    /// 对应 `session.report{event:"auth_failed"}`
    AuthFailed,
    /// 对应 `session.report{event:"host_locked"}`，带锁定时长（秒）
    HostLocked {
        secs: u64,
    },
    TempPasswordChanged,
    FixedPasswordChanged,
    SettingsChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordError {
    TooShort,
    /// 恰好 8 位且全部由临时密码字符集组成：与临时密码无法区分
    LooksLikeTemp,
    Weak(&'static str),
    /// 字符类别不足（小写、大写、数字、其他，至少 3 类）
    TooFewClasses,
    /// 口令派生（Argon2）失败，密码没有被保存
    Kdf(String),
}

impl std::fmt::Display for PasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PasswordError::TooShort => write!(f, "固定密码至少 {MIN_FIXED_LEN} 位"),
            PasswordError::LooksLikeTemp => {
                write!(f, "固定密码不能是恰好 8 位且只含小写字母和数字 2-9 的组合")
            }
            PasswordError::Weak(why) => write!(f, "密码太弱：{why}"),
            PasswordError::TooFewClasses => write!(
                f,
                "固定密码需要包含大写字母、小写字母、数字、符号中的至少 {MIN_FIXED_CLASSES} 类"
            ),
            PasswordError::Kdf(e) => write!(f, "密码处理失败，未保存：{e}"),
        }
    }
}

impl std::error::Error for PasswordError {}

/// 一个字符串是否"恰好 8 位且每一位都在临时密码字符集里"。主控端靠它区分两种密码。
pub fn looks_like_temp_password(s: &str) -> bool {
    s.chars().count() == TEMP_PASSWORD_LEN && s.chars().all(|c| TEMP_CHARSET.contains(c))
}

/// 字符类别数：小写、大写、数字、其他（符号、空格、非 ASCII）。
pub fn char_classes(pw: &str) -> usize {
    let mut c = [false; 4];
    for ch in pw.chars() {
        if ch.is_ascii_lowercase() {
            c[0] = true;
        } else if ch.is_ascii_uppercase() {
            c[1] = true;
        } else if ch.is_ascii_digit() {
            c[2] = true;
        } else {
            c[3] = true;
        }
    }
    c.iter().filter(|x| **x).count()
}

/// 固定密码检查：不能被误认为临时密码（恰好 8 位且全在临时密码字符集里）；至少 10 位；
/// 至少 3 类字符；弱口令检测（常见密码表、键盘序列、连续/重复字符、季节/词 + 年份、含设备码）。
pub fn validate_fixed_password(pw: &str, device_code: &str) -> Result<(), PasswordError> {
    if looks_like_temp_password(pw) {
        return Err(PasswordError::LooksLikeTemp);
    }
    if pw.chars().count() < MIN_FIXED_LEN {
        return Err(PasswordError::TooShort);
    }
    if pw.chars().all(|c| c.is_ascii_digit()) {
        return Err(PasswordError::Weak("不能是纯数字"));
    }
    if pw == device_code {
        return Err(PasswordError::Weak("不能与设备码相同"));
    }
    if let Some(why) = weak_passwords::weakness(pw, device_code) {
        return Err(PasswordError::Weak(why));
    }
    if char_classes(pw) < MIN_FIXED_CLASSES {
        return Err(PasswordError::TooFewClasses);
    }
    Ok(())
}

/// 生成随机临时密码（密码学安全的随机数）。
pub fn generate_temp_password() -> String {
    let chars: Vec<char> = TEMP_CHARSET.chars().collect();
    (0..TEMP_PASSWORD_LEN)
        .map(|_| chars[rand::random_range(0..chars.len())])
        .collect()
}

struct State {
    settings: AccessSettings,
    temp_password: String,
    /// 派生失败时为 None：此时临时密码不可用（握手按密码错误处理），下次刷新再试
    temp_key: Option<[u8; 32]>,
    fixed_key: Option<[u8; 32]>,
    failures: VecDeque<Instant>,
    last_failure: Option<Instant>,
    lock_level: u32,
    locked_until: Option<Instant>,
    active_sessions: usize,
    /// 已准入、握手尚未完成的会话数（也占用 `max_sessions`）
    handshaking: usize,
}

/// 锁定状态快照，供界面显示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardStatus {
    pub temp_password: String,
    pub has_fixed_password: bool,
    pub locked_remaining: Option<Duration>,
    pub settings: AccessSettings,
    pub active_sessions: usize,
}

pub struct Guard {
    device_code: String,
    kdf: Kdf,
    now: NowFn,
    state: Mutex<State>,
    events: broadcast::Sender<GuardEvent>,
}

impl Guard {
    /// 使用 `crypto::derive_pw_key` 作为口令派生函数。
    pub fn new(device_code: &str, settings: AccessSettings) -> Arc<Self> {
        Self::with_kdf(
            device_code,
            settings,
            Arc::new(crate::crypto::derive_pw_key),
        )
    }

    /// 注入口令派生函数（测试用，避免依赖网络层的 Argon2）。
    pub fn with_kdf(device_code: &str, settings: AccessSettings, kdf: Kdf) -> Arc<Self> {
        Self::build(device_code, settings, kdf, Arc::new(Instant::now))
    }

    /// 注入派生函数和时钟（测试锁定到期用）。
    pub fn with_kdf_and_clock(
        device_code: &str,
        settings: AccessSettings,
        kdf: Kdf,
        now: Arc<dyn Fn() -> Instant + Send + Sync>,
    ) -> Arc<Self> {
        Self::build(device_code, settings, kdf, now)
    }

    fn build(device_code: &str, settings: AccessSettings, kdf: Kdf, now: NowFn) -> Arc<Self> {
        let temp = generate_temp_password();
        let temp_key = match kdf(&temp, device_code) {
            Ok(k) => Some(k),
            Err(e) => {
                tracing::error!("临时密码派生失败，临时密码暂不可用：{e}");
                None
            }
        };
        let (events, _) = broadcast::channel(64);
        Arc::new(Self {
            device_code: device_code.to_string(),
            kdf,
            now,
            state: Mutex::new(State {
                settings,
                temp_password: temp,
                temp_key,
                fixed_key: None,
                failures: VecDeque::new(),
                last_failure: None,
                lock_level: 0,
                locked_until: None,
                active_sessions: 0,
                handshaking: 0,
            }),
            events,
        })
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, ev: GuardEvent) {
        let _ = self.events.send(ev);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<GuardEvent> {
        self.events.subscribe()
    }

    // ---------- 密码 ----------

    /// 当前临时密码（明文，仅用于界面显示，不要写日志）。
    pub fn temp_password(&self) -> String {
        self.st().temp_password.clone()
    }

    /// 刷新临时密码并重算 `pw_key`。
    /// 派生失败时保留原来的临时密码和密钥（不会换成一个用不了的密码，更不会用全零密钥），并返回原密码。
    pub fn refresh_temp_password(&self) -> String {
        let pw = generate_temp_password();
        let key = match (self.kdf)(&pw, &self.device_code) {
            Ok(k) => k,
            Err(e) => {
                tracing::error!("刷新临时密码失败，保留原密码：{e}");
                return self.temp_password();
            }
        };
        {
            let mut s = self.st();
            s.temp_password = pw.clone();
            s.temp_key = Some(key);
        }
        self.emit(GuardEvent::TempPasswordChanged);
        pw
    }

    /// 设置固定密码。返回 `pw_key`，门面把它存进系统钥匙串（guard 本身不保存明文）。
    pub fn set_fixed_password(&self, password: &str) -> Result<[u8; 32], PasswordError> {
        validate_fixed_password(password, &self.device_code)?;
        let key = (self.kdf)(password, &self.device_code)
            .map_err(|e| PasswordError::Kdf(e.to_string()))?;
        self.st().fixed_key = Some(key);
        self.emit(GuardEvent::FixedPasswordChanged);
        Ok(key)
    }

    /// 启动时用钥匙串里读出的 `pw_key` 恢复固定密码。
    pub fn load_fixed_pw_key(&self, key: [u8; 32]) {
        self.st().fixed_key = Some(key);
    }

    pub fn clear_fixed_password(&self) {
        self.st().fixed_key = None;
        self.emit(GuardEvent::FixedPasswordChanged);
    }

    pub fn has_fixed_password(&self) -> bool {
        self.st().fixed_key.is_some()
    }

    // ---------- 设置 ----------

    pub fn settings(&self) -> AccessSettings {
        self.st().settings.clone()
    }

    pub fn update_settings(&self, settings: AccessSettings) {
        self.st().settings = settings;
        self.emit(GuardEvent::SettingsChanged);
    }

    /// 信令上报用的 `accept`：允许被连接，且当前没有被锁定。
    pub fn accepting(&self) -> bool {
        let now = (self.now)();
        let s = self.st();
        s.settings.enabled && !Self::is_locked(&s, now)
    }

    fn is_locked(s: &State, now: Instant) -> bool {
        s.locked_until.is_some_and(|t| now < t)
    }

    // ---------- 接入判断 ----------

    /// 处理一个传入连接请求（`connect.incoming`）。
    pub fn admit(&self) -> Admission {
        let now = (self.now)();
        let s = self.st();
        if !s.settings.enabled {
            return Admission::Reject { reason: "disabled" };
        }
        if Self::is_locked(&s, now) {
            return Admission::Reject { reason: "locked" };
        }
        if s.active_sessions + s.handshaking >= s.settings.max_sessions {
            return Admission::Reject { reason: "busy" };
        }
        if s.settings.require_confirm {
            Admission::NeedConfirm
        } else {
            Admission::Allow
        }
    }

    /// 预留一个"握手中"的名额（握手中的会话也要计入并发上限）。
    /// 满了返回 `None`。名额随返回值释放：握手完成（成功后先调 `report_auth_success` 再丢弃）、失败、取消都会归还。
    pub fn begin_handshake(self: &Arc<Self>) -> Option<HandshakeSlot> {
        let mut s = self.st();
        if s.active_sessions + s.handshaking >= s.settings.max_sessions {
            return None;
        }
        s.handshaking += 1;
        Some(HandshakeSlot {
            guard: self.clone(),
        })
    }

    // ---------- 失败计数与锁定 ----------

    /// 握手阶段密码错误（包括"没有设置固定密码却收到 password_kind = 1"）。
    /// 返回触发的锁定时长（若本次触发了锁定）。
    pub fn report_auth_failure(&self) -> Option<Duration> {
        let now = (self.now)();
        let mut locked_for = None;
        let mut refresh = false;
        {
            let mut s = self.st();
            // 级别衰减：从"最近一次失败"和"最近一次锁定结束"中较晚的那个算起，连续 RESET_AFTER 没有失败才归零。
            // 不能在封顶的 24 小时锁定一结束就归零（审查 M4）。
            let quiet_since = match (s.last_failure, s.locked_until) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            if quiet_since.is_some_and(|t| now.saturating_duration_since(t) >= RESET_AFTER) {
                s.lock_level = 0;
            }
            s.last_failure = Some(now);
            s.failures.push_back(now);
            while s
                .failures
                .front()
                .is_some_and(|t| now.duration_since(*t) > FAIL_WINDOW)
            {
                s.failures.pop_front();
            }
            if s.failures.len() >= FAIL_LIMIT {
                let secs = BASE_LOCK
                    .as_secs()
                    .saturating_mul(1u64 << s.lock_level.min(16));
                let dur = Duration::from_secs(secs).min(MAX_LOCK);
                s.lock_level = s.lock_level.saturating_add(1);
                s.locked_until = Some(now + dur);
                s.failures.clear();
                locked_for = Some(dur);
                refresh = true;
            }
        }
        self.emit(GuardEvent::AuthFailed);
        if let Some(d) = locked_for {
            self.emit(GuardEvent::HostLocked { secs: d.as_secs() });
        }
        if refresh {
            // 触发锁定时自动刷新临时密码
            self.refresh_temp_password();
        }
        locked_for
    }

    /// 握手成功，会话开始。
    pub fn report_auth_success(&self) {
        let mut s = self.st();
        s.active_sessions += 1;
        // 成功的连接清掉失败窗口（锁定级别仍按 24 小时规则衰减）
        s.failures.clear();
    }

    /// 会话结束。策略为"每次会话结束后刷新"时刷新临时密码。
    pub fn report_session_end(&self) {
        let refresh = {
            let mut s = self.st();
            s.active_sessions = s.active_sessions.saturating_sub(1);
            s.settings.temp_password_policy == TempPolicy::AfterSession
        };
        if refresh {
            self.refresh_temp_password();
        }
    }

    pub fn status(&self) -> GuardStatus {
        let now = (self.now)();
        let s = self.st();
        GuardStatus {
            temp_password: s.temp_password.clone(),
            has_fixed_password: s.fixed_key.is_some(),
            locked_remaining: s
                .locked_until
                .and_then(|t| t.checked_duration_since(now))
                .filter(|d| !d.is_zero()),
            settings: s.settings.clone(),
            active_sessions: s.active_sessions,
        }
    }
}

/// "握手中"名额，丢弃时归还。
pub struct HandshakeSlot {
    guard: Arc<Guard>,
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        let mut s = self.guard.st();
        s.handshaking = s.handshaking.saturating_sub(1);
    }
}

/// 网络层握手时调用：`kind` 0 = 临时密码，1 = 固定密码。
/// 被锁定、被关闭、没有该类密码时返回 `None`（网络层应按密码错误处理，并通知 guard 记一次失败）。
impl HostPasswords for Guard {
    fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
        let now = (self.now)();
        let s = self.st();
        if !s.settings.enabled || Self::is_locked(&s, now) {
            return None;
        }
        match kind {
            0 => s.temp_key,
            1 => s.fixed_key,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn fake_key(pw: &str, code: &str) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(pw.as_bytes());
        h.update(b"|");
        h.update(code.as_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(h.finalize().as_slice());
        out
    }

    fn fake_kdf() -> Kdf {
        Arc::new(|pw, code| Ok(fake_key(pw, code)))
    }

    struct Clock(Mutex<Instant>);
    impl Clock {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::new(Instant::now())))
        }
        fn advance(&self, d: Duration) {
            if let Ok(mut t) = self.0.lock() {
                *t += d;
            }
        }
        fn now_fn(self: &Arc<Self>) -> Arc<dyn Fn() -> Instant + Send + Sync> {
            let me = self.clone();
            Arc::new(move || me.0.lock().map(|t| *t).unwrap_or_else(|e| *e.into_inner()))
        }
    }

    fn guard_with_clock() -> (Arc<Guard>, Arc<Clock>) {
        let clock = Clock::new();
        let g = Guard::with_kdf_and_clock(
            "123456789",
            AccessSettings::default(),
            fake_kdf(),
            clock.now_fn(),
        );
        (g, clock)
    }

    #[test]
    fn temp_password_format_and_distribution() {
        let mut counts = std::collections::HashMap::new();
        for _ in 0..10_000 {
            let p = generate_temp_password();
            assert_eq!(p.chars().count(), TEMP_PASSWORD_LEN);
            for c in p.chars() {
                assert!(TEMP_CHARSET.contains(c), "字符 {c} 不在字符集内");
                *counts.entry(c).or_insert(0u32) += 1;
            }
            assert!(looks_like_temp_password(&p));
        }
        // 8 万个字符、31 种：每种期望约 2580，允许 ±25%
        assert_eq!(counts.len(), TEMP_CHARSET.chars().count());
        let expect = 80_000.0 / counts.len() as f64;
        for (c, n) in counts {
            assert!(
                (n as f64 - expect).abs() < expect * 0.25,
                "字符 {c} 出现 {n} 次，明显偏离 {expect}"
            );
        }
        for bad in ['0', 'O', '1', 'l', 'I', 'o', 'i'] {
            assert!(!TEMP_CHARSET.contains(bad));
        }
    }

    #[test]
    fn fixed_password_rules() {
        // 恰好 8 位且全在临时密码字符集里：拒绝（主控端靠它区分两种密码）
        assert_eq!(
            validate_fixed_password("abcdefgh", "1"),
            Err(PasswordError::LooksLikeTemp)
        );
        assert_eq!(
            validate_fixed_password("k3m7n9p2", "1"),
            Err(PasswordError::LooksLikeTemp)
        );
        // 少于 10 位一律拒绝（即使有 4 类字符）
        assert_eq!(
            validate_fixed_password("short1", "1"),
            Err(PasswordError::TooShort)
        );
        assert_eq!(
            validate_fixed_password("Xk9#mPq2v", "1"),
            Err(PasswordError::TooShort)
        );
        // 10 位且含 4 类：可以
        assert!(validate_fixed_password("Xk9#mPq2vL", "1").is_ok());
        // 10 位但只有 1～2 类：拒绝
        assert_eq!(
            validate_fixed_password("kkmmnnppqr", "1"),
            Err(PasswordError::TooFewClasses)
        );
        assert_eq!(
            validate_fixed_password("kkmmnnpp29", "1"),
            Err(PasswordError::TooFewClasses)
        );
        assert_eq!(
            validate_fixed_password("KKMMNNPP29", "1"),
            Err(PasswordError::TooFewClasses)
        );
        // 3 类：可以（大写 + 小写 + 数字）
        assert!(validate_fixed_password("Kkmmnnpq29", "1").is_ok());
        // 空格、非 ASCII 字符算一类
        assert!(validate_fixed_password("blue Fox jumps", "1").is_ok());
        assert!(validate_fixed_password("清晨的雨Abc7xYz", "1").is_ok());
    }

    #[test]
    fn fixed_password_weakness() {
        // 审查报告 M4 里列出的、旧规则能通过的样例，全部必须被拒绝
        for pw in [
            "Passw0rd!",
            "Aa123456",
            "zaq12wsx",
            "baseball",
            "Summer2024",
            "qwer1234",
            "12345678a",
            "iloveyou2",
        ] {
            assert!(
                validate_fixed_password(pw, "123456789").is_err(),
                "{pw} 应被拒绝"
            );
        }
        // 长度和字符类别都够，但是常见密码 + 数字/符号的变体
        for pw in [
            "Summer2024",
            "Password123!",
            "Qwerty12345!",
            "Iloveyou2024!",
            "Winter@2025",
            "P@ssw0rd!!!!",
        ] {
            assert!(
                matches!(
                    validate_fixed_password(pw, "123456789"),
                    Err(PasswordError::Weak(_))
                ),
                "{pw} 应判为弱口令"
            );
        }
        assert!(matches!(
            validate_fixed_password("12345678901", "1"),
            Err(PasswordError::Weak(_))
        ));
        assert!(matches!(
            validate_fixed_password("aaaaaaaaaaa", "1"),
            Err(PasswordError::Weak(_))
        ));
        // 与设备码相同或包含设备码
        assert!(matches!(
            validate_fixed_password("Ab#482913675", "482913675"),
            Err(PasswordError::Weak(_))
        ));
        assert!(validate_fixed_password("MyP@ssw0rd-2026", "123456789").is_err());
        assert!(validate_fixed_password("tr0ub4dor&3xyz", "123456789").is_ok());
        assert!(validate_fixed_password("Correct horse battery", "123456789").is_ok());
    }

    #[test]
    fn classification_matches_generator() {
        // 主控端的判断规则：恰好 8 位且全部属于字符集 -> 临时密码；否则固定密码
        assert!(looks_like_temp_password("k3m7n9p2"));
        assert!(!looks_like_temp_password("k3m7n9p"));
        assert!(!looks_like_temp_password("k3m7n9p2x"));
        assert!(!looks_like_temp_password("K3m7n9p2"));
    }

    #[test]
    fn pw_key_by_kind() {
        let g = Guard::with_kdf("123456789", AccessSettings::default(), fake_kdf());
        let temp_pw = g.temp_password();
        let expect = fake_key(&temp_pw, "123456789");
        assert_eq!(g.pw_key(0), Some(expect));
        assert_eq!(
            g.pw_key(1),
            None,
            "没设置固定密码却用 kind=1：应当按密码错误处理"
        );
        assert_eq!(g.pw_key(7), None);
        let k = g.set_fixed_password("A long enough pass 7").expect("ok");
        assert_eq!(g.pw_key(1), Some(k));
        assert_eq!(g.pw_key(0), Some(expect), "固定密码与临时密码同时有效");
        g.clear_fixed_password();
        assert_eq!(g.pw_key(1), None);
    }

    #[test]
    fn refresh_changes_key() {
        let g = Guard::with_kdf("123456789", AccessSettings::default(), fake_kdf());
        let k1 = g.pw_key(0);
        let p1 = g.temp_password();
        let p2 = g.refresh_temp_password();
        assert_ne!(p1, p2);
        assert_ne!(g.pw_key(0), k1);
        assert_eq!(g.pw_key(0), Some(fake_key(&p2, "123456789")));
    }

    #[test]
    fn five_failures_lock_and_refresh() {
        let (g, clock) = guard_with_clock();
        let pw0 = g.temp_password();
        let mut rx = g.subscribe();
        for i in 0..4 {
            assert_eq!(g.report_auth_failure(), None, "第 {} 次不应锁定", i + 1);
            clock.advance(Duration::from_secs(30));
        }
        assert_eq!(g.admit(), Admission::Allow);
        assert_eq!(g.report_auth_failure(), Some(Duration::from_secs(600)));
        assert_eq!(g.admit(), Admission::Reject { reason: "locked" });
        assert!(g.pw_key(0).is_none());
        assert!(!g.accepting());
        assert_ne!(g.temp_password(), pw0, "锁定时应自动刷新临时密码");
        // 事件
        let mut saw_locked = false;
        let mut fails = 0;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                GuardEvent::AuthFailed => fails += 1,
                GuardEvent::HostLocked { secs } => {
                    assert_eq!(secs, 600);
                    saw_locked = true;
                }
                _ => {}
            }
        }
        assert_eq!(fails, 5);
        assert!(saw_locked);
        // 锁定到期后恢复，且用新密码可连
        clock.advance(Duration::from_secs(601));
        assert_eq!(g.admit(), Admission::Allow);
        assert!(g.pw_key(0).is_some());
    }

    #[test]
    fn failures_outside_window_do_not_count() {
        let (g, clock) = guard_with_clock();
        for _ in 0..4 {
            g.report_auth_failure();
            clock.advance(Duration::from_secs(3 * 60));
        }
        // 前面的失败已经超过 10 分钟窗口的一部分
        assert_eq!(g.report_auth_failure(), None);
    }

    #[test]
    fn lock_doubles_and_caps_at_24h_and_never_resets_to_zero() {
        let (g, clock) = guard_with_clock();
        let mut expect = 600u64;
        // 600 -> 1200 -> ... -> 76800 -> 153600 封顶为 86400
        for round in 0..9 {
            let mut locked = None;
            for _ in 0..5 {
                locked = g.report_auth_failure();
            }
            let d = locked.unwrap_or_default();
            assert_eq!(d.as_secs(), expect.min(24 * 3600), "第 {round} 轮");
            // 等锁定刚好结束
            clock.advance(d + Duration::from_secs(1));
            expect = expect.saturating_mul(2);
        }
        assert_eq!(expect, 600 * 512);
        // 审查 M4：封顶锁定结束后，级别不能归零。之后每一轮仍是 24 小时，而不是回到 10 分钟
        for round in 0..5 {
            let mut d = None;
            for _ in 0..5 {
                d = g.report_auth_failure();
            }
            assert_eq!(d, Some(MAX_LOCK), "封顶之后第 {round} 轮仍应锁 24 小时");
            clock.advance(MAX_LOCK + Duration::from_secs(1));
        }
        assert_eq!(MAX_LOCK.as_secs(), 24 * 3600);
        assert!(RESET_AFTER >= Duration::from_secs(7 * 24 * 3600));
    }

    #[test]
    fn lock_level_decays_only_after_7_quiet_days() {
        let (g, clock) = guard_with_clock();
        for _ in 0..5 {
            g.report_auth_failure();
        }
        clock.advance(Duration::from_secs(601));
        let mut d = None;
        for _ in 0..5 {
            d = g.report_auth_failure();
        }
        assert_eq!(d, Some(Duration::from_secs(1200)));
        // 锁定结束后 2 天、6 天都没有失败：级别还在
        clock.advance(Duration::from_secs(1201 + 2 * 24 * 3600));
        let mut d = None;
        for _ in 0..5 {
            d = g.report_auth_failure();
        }
        assert_eq!(d, Some(Duration::from_secs(2400)), "2 天内级别不衰减");
        // 最近一次锁定结束之后 7 天没有失败：从头开始
        clock.advance(Duration::from_secs(2401 + 7 * 24 * 3600));
        let mut d = None;
        for _ in 0..5 {
            d = g.report_auth_failure();
        }
        assert_eq!(d, Some(Duration::from_secs(600)), "7 天无失败后应从头开始");
    }

    #[test]
    fn admission_rules() {
        let (g, _c) = guard_with_clock();
        assert_eq!(g.admit(), Admission::Allow);
        g.update_settings(AccessSettings {
            require_confirm: true,
            ..AccessSettings::default()
        });
        assert_eq!(g.admit(), Admission::NeedConfirm);
        g.update_settings(AccessSettings {
            enabled: false,
            ..AccessSettings::default()
        });
        assert_eq!(g.admit(), Admission::Reject { reason: "disabled" });
        assert!(g.pw_key(0).is_none());
        g.update_settings(AccessSettings {
            max_sessions: 1,
            ..AccessSettings::default()
        });
        g.report_auth_success();
        assert_eq!(g.admit(), Admission::Reject { reason: "busy" });
        g.report_session_end();
        assert_eq!(g.admit(), Admission::Allow);
    }

    #[test]
    fn after_session_policy_refreshes() {
        let (g, _c) = guard_with_clock();
        g.update_settings(AccessSettings {
            temp_password_policy: TempPolicy::AfterSession,
            ..AccessSettings::default()
        });
        let p = g.temp_password();
        g.report_auth_success();
        assert_eq!(g.temp_password(), p);
        g.report_session_end();
        assert_ne!(g.temp_password(), p);
        // 其他策略不刷新
        g.update_settings(AccessSettings::default());
        let p = g.temp_password();
        g.report_auth_success();
        g.report_session_end();
        assert_eq!(g.temp_password(), p);
    }

    /// 审查 L2：KDF 失败时，设置固定密码返回错误且不保存；刷新临时密码保留原密码；绝不出现全零密钥。
    #[test]
    fn kdf_failure_never_installs_a_key() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let fail = Arc::new(AtomicBool::new(false));
        let f2 = fail.clone();
        let kdf: Kdf = Arc::new(move |pw, code| {
            if f2.load(Ordering::SeqCst) {
                Err(CryptoError::Kdf("模拟失败".into()))
            } else {
                Ok(fake_key(pw, code))
            }
        });
        let g = Guard::with_kdf("123456789", AccessSettings::default(), kdf);
        let temp = g.temp_password();
        let temp_key = g.pw_key(0);
        assert!(temp_key.is_some());
        fail.store(true, Ordering::SeqCst);
        // 设置固定密码：报错，且没有保存任何密钥
        let r = g.set_fixed_password("Xk9#mPq2vL");
        assert!(matches!(r, Err(PasswordError::Kdf(_))), "得到 {r:?}");
        assert!(!g.has_fixed_password());
        assert_eq!(g.pw_key(1), None);
        // 刷新临时密码：保留原密码和密钥
        assert_eq!(g.refresh_temp_password(), temp);
        assert_eq!(g.pw_key(0), temp_key);
        // 构造时就失败：临时密码不可用（pw_key 为 None），不是全零
        let g2 = Guard::with_kdf(
            "123456789",
            AccessSettings::default(),
            Arc::new(|_, _| Err(CryptoError::Kdf("x".into()))),
        );
        assert_eq!(g2.pw_key(0), None);
        assert_ne!(g2.pw_key(0), Some([0u8; 32]));
        // 恢复后下次刷新可用
        let g3 = Guard::with_kdf("123456789", AccessSettings::default(), fake_kdf());
        assert!(g3.pw_key(0).is_some());
    }

    /// 握手中的会话也占用并发上限。
    #[test]
    fn handshaking_sessions_count_toward_max() {
        let (g, _c) = guard_with_clock();
        g.update_settings(AccessSettings {
            max_sessions: 2,
            ..AccessSettings::default()
        });
        let a = g.begin_handshake().expect("第 1 个");
        let b = g.begin_handshake().expect("第 2 个");
        assert!(g.begin_handshake().is_none(), "握手中的已经占满上限");
        assert_eq!(g.admit(), Admission::Reject { reason: "busy" });
        // 一个握手失败（丢弃名额）：空出一个
        drop(a);
        assert_eq!(g.admit(), Admission::Allow);
        // 另一个握手成功：先记成功再丢弃名额，总数不重复计算
        g.report_auth_success();
        drop(b);
        let c = g.begin_handshake().expect("active 1 + 握手 0，还有名额");
        assert!(g.begin_handshake().is_none());
        drop(c);
        g.report_session_end();
        assert_eq!(g.admit(), Admission::Allow);
        assert!(g.begin_handshake().is_some());
    }

    #[test]
    fn settings_json_defaults() {
        // 旧配置里没有 isolate_terminals：默认开启（向后兼容）
        let old: AccessSettings =
            serde_json::from_str(r#"{"enabled":true,"max_sessions":2}"#).expect("json");
        assert!(old.isolate_terminals);
        let off: AccessSettings =
            serde_json::from_str(r#"{"isolate_terminals":false}"#).expect("json");
        assert!(!off.isolate_terminals);
        let s: AccessSettings = serde_json::from_str(
            r#"{"require_confirm":true,"temp_password_policy":"after_session"}"#,
        )
        .expect("json");
        assert!(s.enabled && s.require_confirm);
        assert_eq!(s.temp_password_policy, TempPolicy::AfterSession);
    }
}
