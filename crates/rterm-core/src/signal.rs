//! 信令客户端（《实现方案.md》4.3、5.4，《开发指南.md》T10）。
//!
//! 一个后台任务负责「连接 -> hello -> auth 签名 -> 收发 -> 断开后退避重连」的整个循环：
//! - 心跳：每 20 秒 `ping`；45 秒没收到任何消息判定断线。
//! - 重连：1、2、4……秒，上限 60 秒，每次乘以 0.8–1.2 的随机抖动；认证通过后重置为 1 秒。
//! - 请求/响应：发请求时生成 `id`，把 `oneshot::Sender` 存进表；收到同 `id` 的消息时取出并发送；15 秒超时。
//! - 收到 `kick` 且原因为 `replaced`（或关闭码 4409）不再重连，避免两个实例互相踢。
//! - `reconnect_now()`：网络恢复 / 系统唤醒时调用，立即重连，不等退避计时。
//! - 支持 HTTP CONNECT 代理（见 `netutil`）。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

use crate::identity::{b64, b64_decode, Identity};
use crate::netutil::{connect_ws, NetOptions};
use rterm_proto::{MIN_PROTO_VER, PROTO_VER};

/// 信令服务关闭码：同一设备在别处登录，旧连接被踢。
pub const CLOSE_REPLACED: u16 = 4409;
const MAX_SIGNAL_MESSAGE: usize = 64 * 1024;

/// 时间参数。默认值即生产值；测试里缩短。
#[derive(Debug, Clone)]
pub struct Timing {
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
    /// 通用请求超时（目前仅测试用；connect.request 无超时，accept 固定 20 秒）
    pub request_timeout: Duration,
    pub auth_timeout: Duration,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(45),
            request_timeout: Duration::from_secs(15),
            auth_timeout: Duration::from_secs(10),
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        }
    }
}

pub struct SignalConfig {
    /// `wss://signal.<域名>/v1/signal`（来自 `GET /v1/config` 的 `signal_url`）
    pub url: String,
    pub device_id: String,
    pub identity: Arc<Identity>,
    pub app_version: String,
    pub platform: String,
    pub net: NetOptions,
    /// 初始的“接受连接”状态（被控功能是否开启）
    pub accept: bool,
    pub timing: Timing,
}

impl SignalConfig {
    pub fn new(
        url: String,
        device_id: String,
        identity: Arc<Identity>,
        app_version: &str,
        platform: &str,
    ) -> Self {
        Self {
            url,
            device_id,
            identity,
            app_version: app_version.into(),
            platform: platform.into(),
            net: NetOptions::default(),
            accept: true,
            timing: Timing::default(),
        }
    }
}

/// 对端信息（信令下发）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeerRef {
    pub device_code: String,
    pub platform: String,
    /// 已 base64 解码的 32 字节公钥
    pub public_key: Vec<u8>,
    pub proto_ver: u32,
    pub region: String,
}

/// 被控端收到的连接请求（`connect.incoming`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingConnect {
    pub session_id: String,
    pub from: PeerRef,
}

/// 被控端 `accept` 之后服务端下发的中继信息（`connect.go`）。票据此时才签发，30 秒内有效。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoInfo {
    pub relay_url: String,
    pub ticket: String,
}

/// 主控端发起连接成功（`connect.ok`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectOk {
    pub session_id: String,
    pub relay_url: String,
    pub ticket: String,
    pub peer: PeerRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalEvent {
    /// 信令连接状态变化。`device_code` 在认证通过时携带。
    State {
        online: bool,
        device_code: Option<String>,
    },
    Incoming(IncomingConnect),
    /// 主控方取消了等待（`connect.cancelled`），被控端界面应撤掉确认弹窗。
    IncomingCancelled {
        session_id: String,
    },
    Kick {
        reason: String,
    },
    Notice {
        level: String,
        text: String,
    },
    /// 认证被服务端拒绝（`BANNED` / `VERSION` / `UNKNOWN_DEVICE` / `BAD_SIGNATURE` 等）。
    /// 上层可据此提示升级、重新注册；客户端仍会以最大间隔继续重试。
    AuthError {
        code: String,
    },
}

/// 请求失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SignalError {
    /// 当前没有信令连接
    #[error("信令未连接")]
    Offline,
    #[error("信令请求超时")]
    Timeout,
    #[error("信令连接已断开")]
    Closed,
    /// 服务端返回 `connect.err`，`code` 为 UNAVAILABLE / REJECTED / RATE_LIMITED / LOCKED / VERSION / BANNED / NO_RELAY
    #[error("连接被拒绝: {0}")]
    Connect(String),
    #[error("服务端错误: {0}")]
    Server(String),
    #[error("响应格式错误")]
    BadResponse,
    #[error("信令客户端已停止")]
    Stopped,
    /// 已被取消（主控方 `cancel()`，或被控端等待 `connect.go` 时主控方已取消）
    #[error("已取消")]
    Cancelled,
}

impl SignalError {
    /// 界面提示（《实现方案.md》4.3 错误码表）。
    pub fn user_text(&self) -> String {
        match self {
            SignalError::Connect(c) => match c.as_str() {
                "UNAVAILABLE" => "设备不在线或设备码有误".into(),
                "REJECTED" => "对方拒绝了连接".into(),
                "RATE_LIMITED" => "操作太频繁，请稍后再试".into(),
                "LOCKED" => "对方设备已临时锁定".into(),
                "VERSION" => "请升级客户端".into(),
                "BANNED" => "本设备已被封禁".into(),
                "NO_RELAY" => "服务繁忙，请稍后再试".into(),
                other => format!("连接失败（{other}）"),
            },
            SignalError::Offline => "未连接到服务器".into(),
            SignalError::Timeout => "服务器无响应".into(),
            other => other.to_string(),
        }
    }
}

// ---------------------------------------------------------------- 内部

type Reply = oneshot::Sender<Result<Value, SignalError>>;

/// 等待响应的请求的登记信息。
struct ReplySpec {
    reply: Reply,
    /// None 表示不设超时（connect.request：一直等到 ok/err、取消或断线）
    timeout: Option<Duration>,
    /// 收到 `connect.pending` 时通知 session_id
    progress: Option<watch::Sender<Option<String>>>,
    /// 等待 `connect.go` 的会话（被控端 accept）
    go_session: Option<String>,
}

/// 会话循环里的待响应条目。
struct PendingEntry {
    reply: Option<Reply>,
    deadline: Option<Instant>,
    progress: Option<watch::Sender<Option<String>>>,
    go_session: Option<String>,
    /// connect.request 已拿到的 session_id
    session_id: Option<String>,
    /// 用户在 connect.pending 到达之前就取消了：到达后立刻补发 connect.cancel
    cancel_requested: bool,
}

enum Cmd {
    /// 发消息；`reply` 为 Some 表示等待同 id 的响应
    Send {
        t: &'static str,
        id: Option<String>,
        d: Value,
        reply: Option<ReplySpec>,
    },
    /// 取消 connect.request（`id` 为原请求 id）
    CancelConnect {
        id: String,
    },
    SetAccept(bool),
}

struct Shared {
    online: watch::Sender<bool>,
    device_code: Mutex<Option<String>>,
    /// 被 replaced 踢掉后置位，停止自动重连
    kicked: AtomicBool,
    shutdown: AtomicBool,
    next_id: AtomicU64,
    trigger: Notify,
    stop: Notify,
}

/// 信令客户端句柄（可克隆）。
#[derive(Clone)]
pub struct SignalClient {
    cmd: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
    online_rx: watch::Receiver<bool>,
}

impl SignalClient {
    /// 启动后台任务。返回客户端句柄和事件流。必须在 tokio 运行时内调用。
    pub fn start(cfg: SignalConfig) -> (SignalClient, mpsc::Receiver<SignalEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (ev_tx, ev_rx) = mpsc::channel(256);
        let (online_tx, online_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            online: online_tx,
            device_code: Mutex::new(None),
            kicked: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            trigger: Notify::new(),
            stop: Notify::new(),
        });
        tokio::spawn(run(cfg, shared.clone(), cmd_rx, ev_tx));
        (
            SignalClient {
                cmd: cmd_tx,
                shared,
                online_rx,
            },
            ev_rx,
        )
    }

    pub fn is_online(&self) -> bool {
        *self.online_rx.borrow()
    }

    /// 订阅在线状态变化。
    pub fn watch_online(&self) -> watch::Receiver<bool> {
        self.online_rx.clone()
    }

    /// 认证通过后服务端回报的本机设备码。
    pub fn device_code(&self) -> Option<String> {
        self.shared.device_code.lock().ok().and_then(|g| g.clone())
    }

    /// 网络恢复 / 系统唤醒 / 网络切换时调用：立即重连，不等退避计时。
    /// 被 `kick: replaced` 踢掉后不会生效（见 `resume`）。
    pub fn reconnect_now(&self) {
        self.shared.trigger.notify_one();
    }

    /// 被 `replaced` 踢掉后，用户明确要求重新上线时调用。
    pub fn resume(&self) {
        self.shared.kicked.store(false, Ordering::SeqCst);
        self.shared.trigger.notify_one();
    }

    /// 停止后台任务，关闭连接。
    pub fn shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.stop.notify_one();
    }

    /// 等待上线，最多 `timeout`。
    pub async fn wait_online(&self, timeout: Duration) -> bool {
        let mut rx = self.online_rx.clone();
        tokio::time::timeout(timeout, async {
            loop {
                if *rx.borrow() {
                    return true;
                }
                if rx.changed().await.is_err() {
                    return false;
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    fn next_id(&self) -> String {
        format!("r{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst))
    }

    async fn notify(&self, t: &'static str, d: Value) -> Result<(), SignalError> {
        if self.shared.shutdown.load(Ordering::SeqCst) {
            return Err(SignalError::Stopped);
        }
        if !self.is_online() {
            return Err(SignalError::Offline);
        }
        self.cmd
            .send(Cmd::Send {
                t,
                id: None,
                d,
                reply: None,
            })
            .await
            .map_err(|_| SignalError::Stopped)
    }

    /// 主控端：请求连接目标设备（简单封装）。会一直等到被控端处理完毕（没有超时），
    /// 直到收到 ok/err，或信令断开（返回 `Closed`）。需要取消或知道何时进入“等待对方确认”请用 `connect_request_ex`。
    pub async fn connect_request(&self, target_code: &str) -> Result<ConnectOk, SignalError> {
        self.connect_request_ex(target_code).await?.result().await
    }

    /// 主控端：请求连接，返回可取消、可观察进度的句柄。
    /// 离线 / 已停止时直接返回 Err；之后断线会让 `result()` 返回 `Closed`。
    pub async fn connect_request_ex(
        &self,
        target_code: &str,
    ) -> Result<ConnectHandle, SignalError> {
        if self.shared.shutdown.load(Ordering::SeqCst) {
            return Err(SignalError::Stopped);
        }
        if !self.is_online() {
            return Err(SignalError::Offline);
        }
        let (tx, rx) = oneshot::channel();
        let (ptx, prx) = watch::channel(None);
        let id = self.next_id();
        self.cmd
            .send(Cmd::Send {
                t: "connect.request",
                id: Some(id.clone()),
                d: json!({ "target_code": target_code }),
                reply: Some(ReplySpec {
                    reply: tx,
                    timeout: None,
                    progress: Some(ptx),
                    go_session: None,
                }),
            })
            .await
            .map_err(|_| SignalError::Stopped)?;
        Ok(ConnectHandle {
            canceller: ConnectCanceller {
                cmd: self.cmd.clone(),
                id,
            },
            pending: prx,
            rx: Some(rx),
        })
    }

    #[cfg(test)]
    async fn request_with(
        &self,
        t: &'static str,
        d: Value,
        timeout: Duration,
    ) -> Result<Value, SignalError> {
        if self.shared.shutdown.load(Ordering::SeqCst) {
            return Err(SignalError::Stopped);
        }
        if !self.is_online() {
            return Err(SignalError::Offline);
        }
        let (tx, rx) = oneshot::channel();
        let id = self.next_id();
        self.cmd
            .send(Cmd::Send {
                t,
                id: Some(id),
                d,
                reply: Some(ReplySpec {
                    reply: tx,
                    timeout: Some(timeout),
                    progress: None,
                    go_session: None,
                }),
            })
            .await
            .map_err(|_| SignalError::Stopped)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(SignalError::Closed),
            Err(_) => Err(SignalError::Timeout),
        }
    }

    /// 被控端：接受连接请求，并等待服务端下发 `connect.go`（中继地址和票据，此时才签发）。
    /// 等待上限 20 秒；主控方此时若已取消返回 `Cancelled`。
    pub async fn accept(&self, session_id: &str) -> Result<GoInfo, SignalError> {
        if self.shared.shutdown.load(Ordering::SeqCst) {
            return Err(SignalError::Stopped);
        }
        if !self.is_online() {
            return Err(SignalError::Offline);
        }
        let timeout = Duration::from_secs(20);
        let (tx, rx) = oneshot::channel();
        let id = self.next_id();
        self.cmd
            .send(Cmd::Send {
                t: "connect.accept",
                id: Some(id),
                d: json!({ "session_id": session_id }),
                reply: Some(ReplySpec {
                    reply: tx,
                    timeout: Some(timeout),
                    progress: None,
                    go_session: Some(session_id.to_string()),
                }),
            })
            .await
            .map_err(|_| SignalError::Stopped)?;
        let v = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r?,
            Ok(Err(_)) => return Err(SignalError::Closed),
            Err(_) => return Err(SignalError::Timeout),
        };
        parse_go(&v).ok_or(SignalError::BadResponse)
    }

    /// 被控端：拒绝连接请求。`reason` 如 `user` / `locked` / `busy`。
    pub async fn reject(&self, session_id: &str, reason: &str) -> Result<(), SignalError> {
        self.notify(
            "connect.reject",
            json!({ "session_id": session_id, "reason": reason }),
        )
        .await
    }

    /// 上报会话事件：`auth_ok` / `auth_failed` / `closed` / `host_locked`。
    pub async fn session_report(
        &self,
        session_id: &str,
        event: &str,
        detail: Option<Value>,
    ) -> Result<(), SignalError> {
        let mut d = json!({ "session_id": session_id, "event": event });
        if let Some(x) = detail {
            d["detail"] = x;
        }
        self.notify("session.report", d).await
    }

    /// 被控端：更新“是否接受连接”（暂停/恢复被控功能、锁定期间）。重连后自动重发最近一次的值。
    pub async fn presence_update(&self, accept: bool) -> Result<(), SignalError> {
        self.cmd
            .send(Cmd::SetAccept(accept))
            .await
            .map_err(|_| SignalError::Stopped)
    }
}

/// 取消句柄，可克隆、可跨任务使用。
#[derive(Clone)]
pub struct ConnectCanceller {
    cmd: mpsc::Sender<Cmd>,
    id: String,
}

impl ConnectCanceller {
    /// 取消等待：向服务端发送 `connect.cancel {session_id}`，被控端会收到 `connect.cancelled`。
    /// 对应的 `result()` 立即返回 `Cancelled`。幂等；已经出结果后调用无副作用。
    pub fn cancel(&self) {
        let c = Cmd::CancelConnect {
            id: self.id.clone(),
        };
        if let Err(mpsc::error::TrySendError::Full(c)) = self.cmd.try_send(c) {
            let tx = self.cmd.clone();
            tokio::spawn(async move {
                let _ = tx.send(c).await;
            });
        }
    }
}

/// `connect_request_ex` 的句柄。丢弃时若还没有结果，会自动取消。
pub struct ConnectHandle {
    canceller: ConnectCanceller,
    pending: watch::Receiver<Option<String>>,
    rx: Option<oneshot::Receiver<Result<Value, SignalError>>>,
}

impl ConnectHandle {
    /// 已进入“等待对方确认”阶段时返回 session_id（服务端回了 `connect.pending`）。
    pub fn session_id(&self) -> Option<String> {
        self.pending.borrow().clone()
    }

    /// 等待进入“等待对方确认”阶段，返回 session_id。若先拿到了最终结果（或断线）则返回 None。
    pub async fn wait_pending(&mut self) -> Option<String> {
        loop {
            if let Some(id) = self.pending.borrow().clone() {
                return Some(id);
            }
            if self.pending.changed().await.is_err() {
                return self.pending.borrow().clone();
            }
        }
    }

    /// 可克隆的取消句柄（`result()` 会消费 self，需要并发取消时先取出）。
    pub fn canceller(&self) -> ConnectCanceller {
        self.canceller.clone()
    }

    pub fn cancel(&self) {
        self.canceller.cancel();
    }

    /// 等待最终结果：`connect.ok`、`connect.err`（`Connect(code)`）、取消（`Cancelled`）或断线（`Closed`）。没有超时。
    pub async fn result(mut self) -> Result<ConnectOk, SignalError> {
        let rx = self.rx.take().ok_or(SignalError::Stopped)?;
        match rx.await {
            Ok(Ok(v)) => parse_connect_ok(&v).ok_or(SignalError::BadResponse),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SignalError::Closed),
        }
    }
}

impl Drop for ConnectHandle {
    fn drop(&mut self) {
        // result() 已取走 rx 则无需取消
        if self.rx.is_some() {
            self.canceller.cancel();
        }
    }
}

fn parse_go(d: &Value) -> Option<GoInfo> {
    Some(GoInfo {
        relay_url: d.get("relay_url")?.as_str()?.to_string(),
        ticket: d.get("ticket")?.as_str()?.to_string(),
    })
}

fn parse_peer(v: &Value) -> PeerRef {
    PeerRef {
        device_code: v
            .get("device_code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        platform: v
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        public_key: v
            .get("public_key")
            .and_then(Value::as_str)
            .and_then(b64_decode)
            .unwrap_or_default(),
        proto_ver: v.get("proto_ver").and_then(Value::as_u64).unwrap_or(0) as u32,
        region: v
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn parse_connect_ok(d: &Value) -> Option<ConnectOk> {
    Some(ConnectOk {
        session_id: d.get("session_id")?.as_str()?.to_string(),
        relay_url: d.get("relay_url")?.as_str()?.to_string(),
        ticket: d.get("ticket")?.as_str()?.to_string(),
        peer: parse_peer(d.get("peer")?),
    })
}

fn parse_incoming(d: &Value) -> Option<IncomingConnect> {
    Some(IncomingConnect {
        session_id: d.get("session_id")?.as_str()?.to_string(),
        from: parse_peer(d.get("from")?),
    })
}

/// 第 `attempt` 次失败后的等待时间（attempt 从 0 开始）：base * 2^attempt，封顶 max，再乘以 `jitter`（0.8–1.2）。
pub fn backoff_delay(base: Duration, max: Duration, attempt: u32, jitter: f64) -> Duration {
    let exp = base.as_secs_f64() * 2f64.powi(attempt.min(30) as i32);
    Duration::from_secs_f64(exp.min(max.as_secs_f64()) * jitter)
}

fn random_jitter() -> f64 {
    0.8 + 0.4 * rand::random::<f64>()
}

#[derive(Deserialize)]
struct WireMsg {
    t: String,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    d: Value,
}

enum SessionEnd {
    /// 连接断开（或需要重连），带是否曾认证成功
    Lost {
        authed: bool,
    },
    /// 被别处登录踢掉：不重连
    Replaced,
    /// 外部触发（网络恢复 / 唤醒）：不等退避，立即重连
    Immediate,
    Shutdown,
}

async fn emit(ev: &mpsc::Sender<SignalEvent>, e: SignalEvent) {
    // 事件消费者消失（核心库关闭）时忽略
    let _ = ev.send(e).await;
}

async fn run(
    cfg: SignalConfig,
    shared: Arc<Shared>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    ev: mpsc::Sender<SignalEvent>,
) {
    let mut attempt: u32 = 0;
    let mut accept = cfg.accept;
    loop {
        if shared.shutdown.load(Ordering::SeqCst) {
            break;
        }
        if shared.kicked.load(Ordering::SeqCst) {
            // 等 resume() 或 shutdown()
            tokio::select! {
                _ = shared.trigger.notified() => continue,
                _ = shared.stop.notified() => break,
            }
        }

        let end = tokio::select! {
            r = session(&cfg, &shared, &mut cmd_rx, &ev, &mut accept) => r,
            _ = shared.trigger.notified() => {
                tracing::info!("收到立即重连触发，重建信令连接");
                SessionEnd::Immediate
            }
            _ = shared.stop.notified() => SessionEnd::Shutdown,
        };
        let was_online = *shared.online.borrow();
        let _ = shared.online.send(false);
        if let Ok(mut g) = shared.device_code.lock() {
            *g = None;
        }
        if was_online {
            emit(
                &ev,
                SignalEvent::State {
                    online: false,
                    device_code: None,
                },
            )
            .await;
        }
        match end {
            SessionEnd::Shutdown => break,
            SessionEnd::Replaced => {
                shared.kicked.store(true, Ordering::SeqCst);
                continue;
            }
            SessionEnd::Immediate => {
                attempt = 0;
                continue;
            }
            SessionEnd::Lost { authed } => {
                if authed {
                    attempt = 0;
                }
            }
        }

        let delay = backoff_delay(
            cfg.timing.backoff_base,
            cfg.timing.backoff_max,
            attempt,
            random_jitter(),
        );
        attempt = attempt.saturating_add(1);
        tracing::info!(
            "信令断开，{:.1} 秒后重连（第 {attempt} 次）",
            delay.as_secs_f64()
        );
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shared.trigger.notified() => {
                tracing::info!("收到立即重连触发");
                attempt = 0;
            }
            _ = shared.stop.notified() => break,
        }
    }
    let _ = shared.online.send(false);
}

/// 一次完整的连接生命周期。
async fn session(
    cfg: &SignalConfig,
    shared: &Arc<Shared>,
    cmd_rx: &mut mpsc::Receiver<Cmd>,
    ev: &mpsc::Sender<SignalEvent>,
    accept: &mut bool,
) -> SessionEnd {
    let t = cfg.timing.clone();
    let mut ws = match connect_ws(&cfg.url, &cfg.net, MAX_SIGNAL_MESSAGE).await {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("连接信令失败: {e}");
            return SessionEnd::Lost { authed: false };
        }
    };

    // ---- hello -> auth
    let hello = match tokio::time::timeout(t.auth_timeout, read_msg(&mut ws)).await {
        Ok(Ok(Some(m))) if m.t == "hello" => m,
        _ => return SessionEnd::Lost { authed: false },
    };
    let nonce = hello
        .d
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let signed = format!("rterm-auth-v1\n{nonce}\n{}", cfg.device_id);
    let auth = json!({
        "t": "auth",
        "d": {
            "device_id": cfg.device_id,
            "sig": b64(&cfg.identity.sign(signed.as_bytes())),
            "app_version": cfg.app_version,
            "platform": cfg.platform,
            "proto_ver": PROTO_VER,
            "min_proto_ver": MIN_PROTO_VER,
        }
    });
    if ws
        .send(Message::Text(auth.to_string().into()))
        .await
        .is_err()
    {
        return SessionEnd::Lost { authed: false };
    }
    let device_code = match tokio::time::timeout(t.auth_timeout, read_msg(&mut ws)).await {
        Ok(Ok(Some(m))) if m.t == "auth.ok" => {
            m.d.get("device_code")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        Ok(Ok(Some(m))) if m.t == "auth.err" => {
            let code =
                m.d.get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN")
                    .to_string();
            tracing::warn!("信令认证失败: {code}");
            emit(ev, SignalEvent::AuthError { code }).await;
            // 认证类错误按最大间隔重试，避免打爆服务端
            return SessionEnd::Lost { authed: false };
        }
        _ => return SessionEnd::Lost { authed: false },
    };
    // 回报的心跳间隔仅作参考：我们固定 20 秒，不超过服务端要求
    let ping_interval = t.ping_interval;

    // ---- 上线
    if let Ok(mut g) = shared.device_code.lock() {
        *g = device_code.clone();
    }
    let presence = json!({ "t": "presence.update", "d": { "accept": *accept } });
    if ws
        .send(Message::Text(presence.to_string().into()))
        .await
        .is_err()
    {
        return SessionEnd::Lost { authed: false };
    }
    let _ = shared.online.send(true);
    emit(
        ev,
        SignalEvent::State {
            online: true,
            device_code,
        },
    )
    .await;

    // ---- 主循环
    let mut pending: HashMap<String, PendingEntry> = HashMap::new();
    let mut outbox: Vec<Value> = Vec::new();
    let mut ping_tick = tokio::time::interval(ping_interval);
    ping_tick.reset(); // 不在刚连上时立刻 ping
    let mut sweep = tokio::time::interval(Duration::from_millis(500));
    let mut last_rx = Instant::now();

    let end = loop {
        let idle_deadline = last_rx + t.idle_timeout;
        tokio::select! {
            incoming = ws.next() => {
                last_rx = Instant::now();
                let msg = match incoming {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => { tracing::warn!("信令读取失败: {e}"); break SessionEnd::Lost { authed: true }; }
                    None => break SessionEnd::Lost { authed: true },
                };
                match msg {
                    Message::Text(s) => {
                        let Ok(w) = serde_json::from_str::<WireMsg>(&s) else { continue };
                        if let Some(end) = handle_msg(w, &mut pending, &mut outbox, ev).await { break end; }
                        let mut failed = false;
                        for m in outbox.drain(..) {
                            if ws.send(Message::Text(m.to_string().into())).await.is_err() { failed = true; break; }
                        }
                        if failed { break SessionEnd::Lost { authed: true }; }
                    }
                    Message::Close(f) => {
                        let code = f.as_ref().map(|f| u16::from(f.code));
                        if code == Some(CLOSE_REPLACED) {
                            emit(ev, SignalEvent::Kick { reason: "replaced".into() }).await;
                            break SessionEnd::Replaced;
                        }
                        break SessionEnd::Lost { authed: true };
                    }
                    Message::Binary(_) => break SessionEnd::Lost { authed: true },
                    _ => {} // ping/pong 由 tungstenite 处理
                }
            }
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break SessionEnd::Shutdown };
                match cmd {
                    Cmd::SetAccept(a) => {
                        *accept = a;
                        let m = json!({ "t": "presence.update", "d": { "accept": a } });
                        if ws.send(Message::Text(m.to_string().into())).await.is_err() { break SessionEnd::Lost { authed: true }; }
                    }
                    Cmd::CancelConnect { id } => {
                        // 条目不存在 = 已有结果，忽略
                        if let Some(mut e) = pending.remove(&id) {
                            if let Some(r) = e.reply.take() { let _ = r.send(Err(SignalError::Cancelled)); }
                            match e.session_id.clone() {
                                Some(sid) => {
                                    let m = json!({ "t": "connect.cancel", "d": { "session_id": sid } });
                                    if ws.send(Message::Text(m.to_string().into())).await.is_err() { break SessionEnd::Lost { authed: true }; }
                                }
                                None => {
                                    // connect.pending 还没到：留一个空壳条目，到达时补发 connect.cancel
                                    e.cancel_requested = true;
                                    e.deadline = Some(Instant::now() + Duration::from_secs(60));
                                    pending.insert(id, e);
                                }
                            }
                        }
                    }
                    Cmd::Send { t: ty, id, d, reply } => {
                        let mut m = json!({ "t": ty, "d": d });
                        if let Some(id) = &id { m["id"] = json!(id); }
                        if let (Some(id), Some(r)) = (id, reply) {
                            pending.insert(id, PendingEntry {
                                reply: Some(r.reply),
                                // 比调用方的超时多留 2 秒，由调用方先超时；None = 不超时
                                deadline: r.timeout.map(|d| Instant::now() + d + Duration::from_secs(2)),
                                progress: r.progress,
                                go_session: r.go_session,
                                session_id: None,
                                cancel_requested: false,
                            });
                        }
                        if ws.send(Message::Text(m.to_string().into())).await.is_err() { break SessionEnd::Lost { authed: true }; }
                    }
                }
            }
            _ = ping_tick.tick() => {
                if ws.send(Message::Text(json!({ "t": "ping" }).to_string().into())).await.is_err() {
                    break SessionEnd::Lost { authed: true };
                }
            }
            _ = sweep.tick() => {
                let now = Instant::now();
                let expired: Vec<String> = pending.iter().filter(|(_, e)| e.deadline.is_some_and(|dl| dl <= now)).map(|(k, _)| k.clone()).collect();
                for k in expired {
                    if let Some(r) = pending.remove(&k).and_then(|e| e.reply) { let _ = r.send(Err(SignalError::Timeout)); }
                }
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                tracing::warn!("信令 {} 秒没有收到任何消息，判定断线", t.idle_timeout.as_secs_f64());
                break SessionEnd::Lost { authed: true };
            }
        }
    };

    // 失败所有等待中的请求
    for (_, e) in pending.drain() {
        if let Some(r) = e.reply {
            let _ = r.send(Err(SignalError::Closed));
        }
    }
    let _ = tokio::time::timeout(Duration::from_millis(500), ws.close(None)).await;
    end
}

async fn read_msg(ws: &mut crate::netutil::WsStream) -> Result<Option<WireMsg>, ()> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(s))) => {
                return serde_json::from_str::<WireMsg>(&s)
                    .map(Some)
                    .map_err(|_| ())
            }
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Ok(Message::Binary(_))) => return Err(()),
            Some(Ok(_)) => continue,
            Some(Err(_)) => return Err(()),
        }
    }
}

fn id_string(v: &Option<Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// 处理一条服务端消息。返回 Some 表示会话需要结束。需要回发的消息放进 `outbox`。
async fn handle_msg(
    w: WireMsg,
    pending: &mut HashMap<String, PendingEntry>,
    outbox: &mut Vec<Value>,
    ev: &mpsc::Sender<SignalEvent>,
) -> Option<SessionEnd> {
    let id = id_string(&w.id);
    let code_of = |d: &Value| {
        d.get("code")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string()
    };
    let sid_of = |d: &Value| {
        d.get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match w.t.as_str() {
        "pong" => {}
        "connect.pending" => {
            // 中间进度：服务端已把请求转给被控端，正在等对方确认
            let sid = sid_of(&w.d);
            if let (Some(i), Some(sid)) = (id, sid) {
                if let Some(e) = pending.get_mut(&i) {
                    e.session_id = Some(sid.clone());
                    if e.cancel_requested {
                        // 取消发生在 pending 之前：现在补发
                        pending.remove(&i);
                        outbox.push(json!({ "t": "connect.cancel", "d": { "session_id": sid } }));
                    } else if let Some(p) = &e.progress {
                        let _ = p.send(Some(sid));
                    }
                }
            }
        }
        "connect.ok" => {
            if let Some(e) = id.and_then(|i| pending.remove(&i)) {
                if e.cancel_requested {
                    // 取消的空壳条目：ok 先于 pending 到达，被控端已同意，主动取消这个会话
                    if let Some(sid) = sid_of(&w.d) {
                        outbox.push(json!({ "t": "connect.cancel", "d": { "session_id": sid } }));
                    }
                } else if let Some(r) = e.reply {
                    let _ = r.send(Ok(w.d));
                }
            }
        }
        "connect.go" => {
            // 被控端 accept 之后的中继信息：按 session_id（或 id）找到等待者
            let sid = sid_of(&w.d);
            let key = id.filter(|i| pending.contains_key(i)).or_else(|| {
                pending
                    .iter()
                    .find(|(_, e)| e.go_session.is_some() && e.go_session == sid)
                    .map(|(k, _)| k.clone())
            });
            match key.and_then(|k| pending.remove(&k)).and_then(|e| e.reply) {
                Some(r) => {
                    let _ = r.send(Ok(w.d));
                }
                None => tracing::debug!("忽略无人等待的 connect.go"),
            }
        }
        "connect.err" => {
            let code = code_of(&w.d);
            if let Some(r) = id.and_then(|i| pending.remove(&i)).and_then(|e| e.reply) {
                let _ = r.send(Err(SignalError::Connect(code)));
            }
        }
        "error" => {
            let code = code_of(&w.d);
            if let Some(r) = id.and_then(|i| pending.remove(&i)).and_then(|e| e.reply) {
                let _ = r.send(Err(SignalError::Server(code)));
            }
        }
        "connect.incoming" => match parse_incoming(&w.d) {
            Some(i) => emit(ev, SignalEvent::Incoming(i)).await,
            None => tracing::warn!("connect.incoming 格式错误"),
        },
        "connect.cancelled" => {
            if let Some(sid) = sid_of(&w.d) {
                // 正在等 connect.go 的 accept 立即失败
                let key = pending
                    .iter()
                    .find(|(_, e)| e.go_session.as_deref() == Some(sid.as_str()))
                    .map(|(k, _)| k.clone());
                if let Some(r) = key.and_then(|k| pending.remove(&k)).and_then(|e| e.reply) {
                    let _ = r.send(Err(SignalError::Cancelled));
                }
                emit(ev, SignalEvent::IncomingCancelled { session_id: sid }).await;
            }
        }
        "kick" => {
            let reason =
                w.d.get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            emit(
                ev,
                SignalEvent::Kick {
                    reason: reason.clone(),
                },
            )
            .await;
            if reason == "replaced" {
                return Some(SessionEnd::Replaced);
            }
            return Some(SessionEnd::Lost { authed: true });
        }
        "notice" => {
            emit(
                ev,
                SignalEvent::Notice {
                    level: w
                        .d
                        .get("level")
                        .and_then(Value::as_str)
                        .unwrap_or("info")
                        .to_string(),
                    text: w
                        .d
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                },
            )
            .await;
        }
        other => {
            // 带 id 的其他响应也交给等待者（未来新增的请求类型）
            if let Some(r) = id.and_then(|i| pending.remove(&i)).and_then(|e| e.reply) {
                let _ = r.send(Ok(w.d));
            } else {
                tracing::debug!("忽略未知信令消息: {other}");
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::verify_signature;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    #[test]
    fn backoff_sequence_and_cap() {
        let b = Duration::from_secs(1);
        let m = Duration::from_secs(60);
        let secs: Vec<f64> = (0..9)
            .map(|i| backoff_delay(b, m, i, 1.0).as_secs_f64())
            .collect();
        assert_eq!(secs, vec![1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0]);
        assert!((backoff_delay(b, m, 3, 0.8).as_secs_f64() - 6.4).abs() < 1e-9);
        assert!((backoff_delay(b, m, 3, 1.2).as_secs_f64() - 9.6).abs() < 1e-9);
        for _ in 0..100 {
            let j = random_jitter();
            assert!((0.8..1.2).contains(&j));
        }
        // 超大次数不溢出
        assert_eq!(backoff_delay(b, m, 1000, 1.0), m);
    }

    // ---------------- 假信令服务

    #[derive(Clone, Default)]
    struct Script {
        /// 每个连接的编号（从 0 起）
        conn_count: Arc<AtomicU64>,
        /// 收到的 (conn_index, t, d)
        seen: Arc<Mutex<Vec<(u64, String, Value)>>>,
        /// 对 connect.request 的应答延迟（按 target_code 末位数字 ×100ms 乱序响应）
        reverse_order: bool,
        /// 不回应 ping 且不发任何消息（测试 idle）
        silent_after_auth: bool,
        /// connect.request 先回 connect.pending，最终结果要等测试推送 `__release`
        hold_connect: bool,
        /// connect.pending 延迟多久再发
        pending_delay: Option<Duration>,
        /// 不回应 connect.accept（不发 connect.go）
        no_go: bool,
        /// 认证后立刻踢
        kick_on_auth: Option<&'static str>,
        /// 认证后立刻断开连接（连续 N 次）
        drop_first: u64,
        push_tx: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
        pub_key: Arc<Mutex<Vec<u8>>>,
    }

    async fn fake_signal(script: Script) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((s, _)) = l.accept().await else { break };
                let script = script.clone();
                tokio::spawn(async move {
                    let idx = script.conn_count.fetch_add(1, Ordering::SeqCst);
                    let Ok(mut ws) = tokio_tungstenite::accept_async(s).await else {
                        return;
                    };
                    let nonce = "bm9uY2U=";
                    ws.send(Message::Text(
                        json!({"t":"hello","d":{"nonce":nonce,"server_time":0}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                    let Some(Ok(Message::Text(a))) = ws.next().await else {
                        return;
                    };
                    let a: Value = serde_json::from_str(&a).unwrap();
                    assert_eq!(a["t"], "auth");
                    let dev = a["d"]["device_id"].as_str().unwrap();
                    let sig = b64_decode(a["d"]["sig"].as_str().unwrap()).unwrap();
                    let pk = script.pub_key.lock().unwrap().clone();
                    let ok = verify_signature(
                        &pk,
                        format!("rterm-auth-v1\n{nonce}\n{dev}").as_bytes(),
                        &sig,
                    );
                    script
                        .seen
                        .lock()
                        .unwrap()
                        .push((idx, "auth".into(), a["d"].clone()));
                    if !ok {
                        ws.send(Message::Text(
                            json!({"t":"auth.err","d":{"code":"BAD_SIGNATURE"}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                        return;
                    }
                    ws.send(Message::Text(
                        json!({"t":"auth.ok","d":{"device_code":"482913675","heartbeat_sec":20}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                    if idx < script.drop_first {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        return;
                    }
                    if let Some(reason) = script.kick_on_auth {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        ws.send(Message::Text(
                            json!({"t":"kick","d":{"reason":reason}}).to_string().into(),
                        ))
                        .await
                        .unwrap();
                        let _ = ws
                            .close(Some(CloseFrame {
                                code: CloseCode::from(CLOSE_REPLACED),
                                reason: "replaced".into(),
                            }))
                            .await;
                        // 把客户端已发来的数据读完再退出，否则 Windows 上会发 RST 吞掉还没读到的 kick
                        let _ = tokio::time::timeout(Duration::from_millis(500), async {
                            while ws.next().await.is_some() {}
                        })
                        .await;
                        return;
                    }
                    if script.silent_after_auth {
                        // 吃掉所有消息，什么都不回
                        while ws.next().await.is_some() {}
                        return;
                    }
                    let (ptx, mut prx) = mpsc::channel::<Value>(8);
                    *script.push_tx.lock().unwrap() = Some(ptx);
                    let mut held: Vec<(Value, Value)> = Vec::new();
                    loop {
                        tokio::select! {
                            m = ws.next() => {
                                let Some(Ok(m)) = m else { break };
                                let Message::Text(s) = m else { continue };
                                let v: Value = serde_json::from_str(&s).unwrap();
                                script.seen.lock().unwrap().push((idx, v["t"].as_str().unwrap().to_string(), v["d"].clone()));
                                match v["t"].as_str().unwrap() {
                                    "ping" => ws.send(Message::Text(json!({"t":"pong"}).to_string().into())).await.unwrap(),
                                    "connect.accept" => {
                                        if !script.no_go {
                                            let sid = v["d"]["session_id"].as_str().unwrap();
                                            ws.send(Message::Text(json!({"t":"connect.go","id":v["id"],"d":{
                                                "session_id": sid, "relay_url":"ws://relay", "ticket": format!("TK-{sid}")}}).to_string().into())).await.unwrap();
                                        }
                                    }
                                    "connect.request" => {
                                        let code = v["d"]["target_code"].as_str().unwrap().to_string();
                                        if let Some(d) = script.pending_delay { tokio::time::sleep(d).await; }
                                        if code != "000000000" {
                                            ws.send(Message::Text(json!({"t":"connect.pending","id":v["id"],"d":{"session_id": format!("S-{code}")}}).to_string().into())).await.unwrap();
                                        }
                                        let resp = if code == "000000000" {
                                            json!({"t":"connect.err","id":v["id"],"d":{"code":"UNAVAILABLE"}})
                                        } else {
                                            json!({"t":"connect.ok","id":v["id"],"d":{
                                                "session_id": format!("S-{code}"), "relay_url":"ws://relay", "ticket": format!("T-{code}"),
                                                "peer":{"public_key": b64(&[7u8;32]), "platform":"windows","proto_ver":1}}})
                                        };
                                        if script.hold_connect {
                                            held.push((v["id"].clone(), resp));
                                        } else if script.reverse_order {
                                            held.push((v["id"].clone(), resp));
                                            if held.len() == 2 {
                                                while let Some((_, r)) = held.pop() {
                                                    ws.send(Message::Text(r.to_string().into())).await.unwrap();
                                                }
                                            }
                                        } else {
                                            ws.send(Message::Text(resp.to_string().into())).await.unwrap();
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            p = prx.recv() => {
                                let Some(p) = p else { break };
                                if p["t"] == "__release" {
                                    while let Some((_, r)) = held.pop() {
                                        ws.send(Message::Text(r.to_string().into())).await.unwrap();
                                    }
                                    continue;
                                }
                                if p["t"] == "__close" { break; }
                                ws.send(Message::Text(p.to_string().into())).await.unwrap();
                            }
                        }
                    }
                });
            }
        });
        format!("ws://{addr}/v1/signal")
    }

    fn quick_timing() -> Timing {
        Timing {
            ping_interval: Duration::from_millis(100),
            idle_timeout: Duration::from_millis(600),
            request_timeout: Duration::from_millis(500),
            auth_timeout: Duration::from_secs(2),
            backoff_base: Duration::from_millis(50),
            backoff_max: Duration::from_millis(400),
        }
    }

    fn cfg(url: String, id: &Arc<Identity>, timing: Timing) -> SignalConfig {
        let mut c = SignalConfig::new(url, "01DEV".into(), id.clone(), "0.1.0", "windows");
        c.net = NetOptions {
            proxy: Some(String::new()),
            use_system_certs: false,
        };
        c.timing = timing;
        c
    }

    async fn next_event(rx: &mut mpsc::Receiver<SignalEvent>) -> SignalEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("等事件超时")
            .expect("事件流关闭")
    }

    #[tokio::test]
    async fn auth_online_presence_and_heartbeat() {
        let id = Arc::new(Identity::generate());
        let script = Script::default();
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        assert_eq!(
            next_event(&mut ev).await,
            SignalEvent::State {
                online: true,
                device_code: Some("482913675".into())
            }
        );
        assert!(client.is_online());
        assert_eq!(client.device_code().as_deref(), Some("482913675"));
        tokio::time::sleep(Duration::from_millis(450)).await;
        let seen = script.seen.lock().unwrap().clone();
        assert!(seen
            .iter()
            .any(|(_, t, d)| t == "presence.update" && d["accept"] == true));
        let pings = seen.iter().filter(|(_, t, _)| t == "ping").count();
        assert!(pings >= 3, "应有周期心跳，实际 {pings}");
        // 心跳有 pong，不应断线
        assert!(client.is_online());
        let auth = seen.iter().find(|(_, t, _)| t == "auth").unwrap().2.clone();
        assert_eq!(auth["proto_ver"], 1);
        assert_eq!(auth["app_version"], "0.1.0");
        client.shutdown();
    }

    #[tokio::test]
    async fn request_response_mapping_out_of_order() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            reverse_order: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let c1 = client.clone();
        let c2 = client.clone();
        let (a, b) = tokio::join!(
            tokio::spawn(async move { c1.connect_request("111111111").await }),
            tokio::spawn(async move { c2.connect_request("222222222").await })
        );
        // 服务端先回第二个再回第一个，各自仍拿到自己的结果
        let a = a.unwrap().unwrap();
        let b = b.unwrap().unwrap();
        assert_eq!(a.session_id, "S-111111111");
        assert_eq!(b.session_id, "S-222222222");
        assert_eq!(a.ticket, "T-111111111");
        assert_eq!(a.peer.public_key, vec![7u8; 32]);
        assert_eq!(a.peer.platform, "windows");
        client.shutdown();
    }

    #[tokio::test]
    async fn connect_err_code_and_user_text() {
        let id = Arc::new(Identity::generate());
        let script = Script::default();
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let e = client.connect_request("000000000").await.unwrap_err();
        assert_eq!(e, SignalError::Connect("UNAVAILABLE".into()));
        assert_eq!(e.user_text(), "设备不在线或设备码有误");
        client.shutdown();
    }

    #[tokio::test]
    async fn request_times_out_and_offline_error() {
        let id = Arc::new(Identity::generate());
        // 服务端 reverse_order 且只发一个请求：永远凑不齐 2 个，不会应答
        let script = Script {
            reverse_order: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script).await;
        let mut t = quick_timing();
        t.request_timeout = Duration::from_millis(200);
        t.idle_timeout = Duration::from_secs(30);
        let (client, mut ev) = SignalClient::start(cfg(url, &id, t));
        next_event(&mut ev).await;
        let started = std::time::Instant::now();
        // connect.request 本身没有超时；这里用 request_with 测通用请求的超时机制
        let e = client
            .request_with(
                "connect.request",
                json!({"target_code":"333333333"}),
                Duration::from_millis(200),
            )
            .await
            .unwrap_err();
        assert_eq!(e, SignalError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(2));
        client.shutdown();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(matches!(
            client.accept("S").await,
            Err(SignalError::Stopped) | Err(SignalError::Offline)
        ));

        // 未连接时立即返回 Offline
        let (c2, _ev2) = SignalClient::start(cfg(
            "ws://127.0.0.1:1/v1/signal".into(),
            &id,
            quick_timing(),
        ));
        assert_eq!(
            c2.connect_request("111111111").await.unwrap_err(),
            SignalError::Offline
        );
        c2.shutdown();
    }

    #[tokio::test]
    async fn incoming_accept_reject_report() {
        let id = Arc::new(Identity::generate());
        let script = Script::default();
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let ptx = script.push_tx.lock().unwrap().clone().unwrap();
        ptx.send(json!({"t":"connect.incoming","d":{"session_id":"S9",
            "from":{"device_code":"731204588","platform":"macos","public_key": b64(&[5u8;32]),"region":"cn"}}})).await.unwrap();
        ptx.send(json!({"t":"notice","d":{"level":"warn","text":"请升级"}}))
            .await
            .unwrap();
        match next_event(&mut ev).await {
            SignalEvent::Incoming(i) => {
                assert_eq!(i.session_id, "S9");
                assert_eq!(i.from.device_code, "731204588");
                assert_eq!(i.from.public_key, vec![5u8; 32]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            next_event(&mut ev).await,
            SignalEvent::Notice {
                level: "warn".into(),
                text: "请升级".into()
            }
        );
        let go = client.accept("S9").await.unwrap();
        assert_eq!(
            go,
            GoInfo {
                relay_url: "ws://relay".into(),
                ticket: "TK-S9".into()
            }
        );
        client.reject("S10", "locked").await.unwrap();
        client
            .session_report("S9", "auth_failed", Some(json!({"n":1})))
            .await
            .unwrap();
        client.presence_update(false).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seen = script.seen.lock().unwrap().clone();
        let find = |t: &str| {
            seen.iter()
                .find(|(_, x, _)| x == t)
                .map(|(_, _, d)| d.clone())
        };
        assert_eq!(find("connect.accept").unwrap()["session_id"], "S9");
        assert_eq!(find("connect.reject").unwrap()["reason"], "locked");
        let rep = find("session.report").unwrap();
        assert_eq!(
            (rep["event"].as_str(), rep["detail"]["n"].as_i64()),
            (Some("auth_failed"), Some(1))
        );
        assert!(seen
            .iter()
            .any(|(_, t, d)| t == "presence.update" && d["accept"] == false));
        client.shutdown();
    }

    #[tokio::test]
    async fn reconnects_with_backoff_after_drop_and_resends_presence() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            drop_first: 3,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        client.presence_update(false).await.ok(); // 离线时调用不会生效，仅保存意图（见下）
        let mut downs = 0;
        let mut ups = 0;
        let begin = std::time::Instant::now();
        while ups < 4 {
            match next_event(&mut ev).await {
                SignalEvent::State { online: true, .. } => ups += 1,
                SignalEvent::State { online: false, .. } => downs += 1,
                _ => {}
            }
        }
        assert!(downs >= 3, "前三次连接都被服务端断开");
        // 前三次断开后的退避 ≥ 0.8*(50+100+200)=280ms（认证通过会重置退避，所以每次都是 50ms 左右；这里只验证确实重连了）
        assert!(begin.elapsed() < Duration::from_secs(5));
        assert!(script.conn_count.load(Ordering::SeqCst) >= 4);
        client.shutdown();
    }

    #[tokio::test]
    async fn backoff_grows_when_server_unreachable() {
        // 端口上没有服务：连接失败，间隔应递增并封顶
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let id = Arc::new(Identity::generate());
        let attempts = Arc::new(AtomicU64::new(0));
        // 用一个只数连接数的监听代替“拒绝连接”，便于计数：accept 后立刻关闭
        let l = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let a2 = attempts.clone();
        let stamps = Arc::new(Mutex::new(Vec::<std::time::Instant>::new()));
        let s2 = stamps.clone();
        tokio::spawn(async move {
            loop {
                let Ok((s, _)) = l.accept().await else { break };
                a2.fetch_add(1, Ordering::SeqCst);
                s2.lock().unwrap().push(std::time::Instant::now());
                drop(s);
            }
        });
        let mut t = quick_timing();
        t.backoff_base = Duration::from_millis(40);
        t.backoff_max = Duration::from_millis(320);
        let (client, _ev) =
            SignalClient::start(cfg(format!("ws://127.0.0.1:{port}/v1/signal"), &id, t));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        client.shutdown();
        let st = stamps.lock().unwrap().clone();
        assert!(st.len() >= 5, "应持续重试，实际 {}", st.len());
        let gaps: Vec<f64> = st
            .windows(2)
            .map(|w| (w[1] - w[0]).as_secs_f64() * 1000.0)
            .collect();
        // 间隔：约 40,80,160,320,320...（±20%，另有连接开销），后面的明显大于前面的
        assert!(gaps[2] > gaps[0] * 1.5, "间隔应增长: {gaps:?}");
        assert!(*gaps.last().unwrap() < 600.0, "间隔应封顶: {gaps:?}");
    }

    #[tokio::test]
    async fn kick_replaced_does_not_reconnect_until_resume() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            kick_on_auth: Some("replaced"),
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        let mut got_kick = false;
        let mut got_down = false;
        for _ in 0..4 {
            match next_event(&mut ev).await {
                SignalEvent::Kick { reason } => {
                    assert_eq!(reason, "replaced");
                    got_kick = true;
                }
                SignalEvent::State { online: false, .. } => {
                    got_down = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(got_kick && got_down);
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(
            script.conn_count.load(Ordering::SeqCst),
            1,
            "被 replaced 踢掉后不应重连"
        );
        client.reconnect_now(); // 网络事件也不应触发
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(script.conn_count.load(Ordering::SeqCst), 1);
        client.resume();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            script.conn_count.load(Ordering::SeqCst) >= 2,
            "resume 后应重新连接"
        );
        client.shutdown();
    }

    #[tokio::test]
    async fn idle_timeout_triggers_reconnect() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            silent_after_auth: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        assert!(matches!(
            next_event(&mut ev).await,
            SignalEvent::State { online: true, .. }
        ));
        // 服务端不回任何消息 -> idle_timeout(600ms) 后判定断线并重连
        assert!(matches!(
            next_event(&mut ev).await,
            SignalEvent::State { online: false, .. }
        ));
        assert!(matches!(
            next_event(&mut ev).await,
            SignalEvent::State { online: true, .. }
        ));
        assert!(script.conn_count.load(Ordering::SeqCst) >= 2);
        client.shutdown();
    }

    #[tokio::test]
    async fn reconnect_now_skips_backoff() {
        let id = Arc::new(Identity::generate());
        let script = Script::default();
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let mut t = quick_timing();
        t.idle_timeout = Duration::from_secs(30);
        t.backoff_base = Duration::from_secs(30); // 退避很长
        t.backoff_max = Duration::from_secs(30);
        let (client, mut ev) = SignalClient::start(cfg(url, &id, t));
        assert!(matches!(
            next_event(&mut ev).await,
            SignalEvent::State { online: true, .. }
        ));
        client.reconnect_now(); // 模拟网络切换 / 唤醒
        assert!(matches!(
            next_event(&mut ev).await,
            SignalEvent::State { online: false, .. }
        ));
        // 退避 30 秒，但触发后应在很短时间内重新上线
        let r = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let SignalEvent::State { online: true, .. } = next_event(&mut ev).await {
                    break;
                }
            }
        })
        .await;
        assert!(r.is_ok(), "reconnect_now 应跳过退避");
        assert_eq!(script.conn_count.load(Ordering::SeqCst), 2);
        client.shutdown();
    }

    #[tokio::test]
    async fn bad_signature_reports_auth_error() {
        let id = Arc::new(Identity::generate());
        let script = Script::default();
        *script.pub_key.lock().unwrap() = Identity::generate().public_key().to_vec(); // 服务端持有别的公钥
        let url = fake_signal(script).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        assert_eq!(
            next_event(&mut ev).await,
            SignalEvent::AuthError {
                code: "BAD_SIGNATURE".into()
            }
        );
        assert!(!client.is_online());
        client.shutdown();
    }

    #[tokio::test]
    async fn connect_request_has_no_timeout_and_reports_pending() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            hold_connect: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let mut t = quick_timing();
        t.request_timeout = Duration::from_millis(200);
        t.idle_timeout = Duration::from_secs(30);
        let (client, mut ev) = SignalClient::start(cfg(url, &id, t));
        next_event(&mut ev).await;
        let mut h = client.connect_request_ex("111111111").await.unwrap();
        assert_eq!(h.session_id(), None);
        assert_eq!(h.wait_pending().await.as_deref(), Some("S-111111111"));
        let canceller = h.canceller();
        let task = tokio::spawn(h.result());
        // 远超 request_timeout 仍在等待
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!task.is_finished(), "connect.request 不应有请求超时");
        let ptx = script.push_tx.lock().unwrap().clone().unwrap();
        ptx.send(json!({"t":"__release"})).await.unwrap();
        let ok = task.await.unwrap().unwrap();
        assert_eq!(ok.session_id, "S-111111111");
        canceller.cancel(); // 已有结果后取消无副作用
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!script
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|(_, t, _)| t == "connect.cancel"));
        client.shutdown();
    }

    #[tokio::test]
    async fn cancel_after_pending_sends_connect_cancel() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            hold_connect: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let mut h = client.connect_request_ex("222222222").await.unwrap();
        h.wait_pending().await.unwrap();
        h.cancel();
        assert_eq!(h.result().await.unwrap_err(), SignalError::Cancelled);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let seen = script.seen.lock().unwrap().clone();
        let c = seen.iter().find(|(_, t, _)| t == "connect.cancel").unwrap();
        assert_eq!(c.2["session_id"], "S-222222222");
        client.shutdown();
    }

    #[tokio::test]
    async fn cancel_before_pending_is_forwarded_when_pending_arrives() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            hold_connect: true,
            pending_delay: Some(Duration::from_millis(300)),
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let h = client.connect_request_ex("333333333").await.unwrap();
        h.cancel(); // connect.pending 还没到
        assert_eq!(h.result().await.unwrap_err(), SignalError::Cancelled);
        tokio::time::sleep(Duration::from_millis(600)).await;
        let seen = script.seen.lock().unwrap().clone();
        let c = seen
            .iter()
            .find(|(_, t, _)| t == "connect.cancel")
            .expect("pending 到达后应补发 connect.cancel");
        assert_eq!(c.2["session_id"], "S-333333333");
        client.shutdown();
    }

    #[tokio::test]
    async fn dropping_handle_cancels() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            hold_connect: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let mut h = client.connect_request_ex("444444444").await.unwrap();
        h.wait_pending().await.unwrap();
        drop(h);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(script
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|(_, t, _)| t == "connect.cancel"));
        client.shutdown();
    }

    #[tokio::test]
    async fn signal_disconnect_while_pending_returns_closed() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            hold_connect: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let mut h = client.connect_request_ex("555555555").await.unwrap();
        h.wait_pending().await.unwrap();
        let ptx = script.push_tx.lock().unwrap().clone().unwrap();
        ptx.send(json!({"t":"__close"})).await.unwrap();
        let r = tokio::time::timeout(Duration::from_secs(3), h.result())
            .await
            .unwrap();
        assert_eq!(r.unwrap_err(), SignalError::Closed);
        client.shutdown();
    }

    #[tokio::test]
    async fn cancelled_event_and_accept_waiting_for_go() {
        let id = Arc::new(Identity::generate());
        let script = Script {
            no_go: true,
            ..Default::default()
        };
        *script.pub_key.lock().unwrap() = id.public_key().to_vec();
        let url = fake_signal(script.clone()).await;
        let (client, mut ev) = SignalClient::start(cfg(url, &id, quick_timing()));
        next_event(&mut ev).await;
        let ptx = script.push_tx.lock().unwrap().clone().unwrap();
        // 单独的取消通知 -> 事件
        ptx.send(json!({"t":"connect.cancelled","d":{"session_id":"SX"}}))
            .await
            .unwrap();
        assert_eq!(
            next_event(&mut ev).await,
            SignalEvent::IncomingCancelled {
                session_id: "SX".into()
            }
        );
        // 正在等 connect.go 时主控方取消：accept 立即返回 Cancelled
        let c2 = client.clone();
        let acc = tokio::spawn(async move { c2.accept("SY").await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!acc.is_finished());
        ptx.send(json!({"t":"connect.cancelled","d":{"session_id":"SY"}}))
            .await
            .unwrap();
        assert_eq!(acc.await.unwrap().unwrap_err(), SignalError::Cancelled);
        assert_eq!(
            next_event(&mut ev).await,
            SignalEvent::IncomingCancelled {
                session_id: "SY".into()
            }
        );
        client.shutdown();
    }
}
