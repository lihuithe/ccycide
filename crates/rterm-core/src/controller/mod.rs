//! 主控端（《实现方案.md》5.6，《开发指南.md》T14、T23、T24、T26）。
//!
//! # 用法
//! ```ignore
//! // 生产：用信令客户端 + 本机身份造连接器，管理多台被控端
//! let connector = Arc::new(SignalConnector::new(signal, identity, net));
//! let mgr = ControllerManager::new(connector, events_tx, app_version, ControllerTiming::default());
//! let sid = mgr.connect("123456789", "abc23456").await?;          // 等价于 Core::connect
//! let term = mgr.open_term(&sid, TermOpenOptions::shell(TermSize::new(120, 30))).await?;
//! mgr.term_input(&sid, &term, b"ls\r".to_vec()).await?;
//! mgr.term_ack(&sid, &term, consumed);                             // 同步，界面渲染后调用
//! ```
//! 界面通过 `events_tx` 对端收到 [`CoreEvent`](crate::events::CoreEvent)（`SessionState`、`HostInfo`、
//! `ActionCatalog`、`TermOutput` ……）。事件通道是有界的：事件接收方必须持续取走事件，
//! 并且**不要在处理事件的同一个任务里 `await` 其它会话命令**（可以 `term_ack`，它是同步的）。
//!
//! # 模块
//! - `connect`：一次连接尝试（信令 → 中继 → 握手 → Hello），可替换的 [`Connector`]；
//! - `session`：每台被控端一个会话任务，处理命令、帧、自动重连；
//! - `term`：终端表与按偏移去重（纯逻辑）；
//! - `upload`：上传任务。
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rterm_proto::pb;
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

use crate::events::{CoreEvent, FileId, SessionId, SessionState, TermId};
use crate::relay::{EstablishError, PasswordInput};

pub mod connect;
pub mod session;
pub mod term;
pub mod upload;

pub use connect::{
    ConnectCtl, ConnectError, ConnectSpec, Connected, Connector, SignalConnector, FEATURES,
};
pub use session::HostSnapshot;
pub use term::{TermOpenOptions, TermProfile, TermSize};
pub use upload::UploadSource;

use session::{cmd_channel, Actor, Cmd, Shared};
use term::AckBoard;

/// 时间参数。生产环境用默认值；测试里缩短。
#[derive(Debug, Clone)]
pub struct ControllerTiming {
    /// 重连退避：`base * 2^n`，不超过 `backoff_max`（默认 1、2、4、8、15、15…秒）
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// 打开终端 / 附着 / 列表等需要被控端答复的请求的超时（《开发指南.md》T14：15 秒）
    pub request_timeout: Duration,
    /// `Hello` 之后等 `HelloAck` 的时限
    pub hello_timeout: Duration,
    /// 重连后恢复终端（TermList + TermAttach）的时限，超时按当前进度进入 Ready
    pub resync_timeout: Duration,
    /// 应用层心跳间隔，以及多久没收到任何帧就判定断线
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
    /// 向链路队列写一帧的最长等待，超时判定链路已死
    pub send_timeout: Duration,
    /// 上传时等待被控端 Accept / Ack / Done 的最长时间
    pub upload_stall: Duration,
    /// 上传进度事件的最小间隔
    pub progress_interval: Duration,
}

impl Default for ControllerTiming {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(15),
            request_timeout: Duration::from_secs(15),
            hello_timeout: Duration::from_secs(10),
            resync_timeout: Duration::from_secs(15),
            ping_interval: Duration::from_secs(15),
            idle_timeout: Duration::from_secs(45),
            send_timeout: Duration::from_secs(15),
            upload_stall: Duration::from_secs(60),
            progress_interval: Duration::from_millis(100),
        }
    }
}

/// 会话关闭的原因。`SessionState::Closed` 里携带的是 [`CloseReason::text`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    /// 用户主动断开
    User,
    /// 密码错误：不再重试，界面应要求重新输入密码
    BadPassword,
    /// 被控端公钥与记住的不一致
    PeerKeyChanged,
    /// 被拒绝 / 被锁定 / 被封禁 / 版本不兼容等不可重试的失败（文字说明）
    Refused(String),
    /// 被控端发了 `Bye`
    HostBye(String),
    /// 用户在对方确认之前取消了连接
    Cancelled,
    /// 事件接收方已丢弃（界面退出）
    ConsumerGone,
}

impl CloseReason {
    pub fn text(&self) -> String {
        match self {
            CloseReason::User => "用户断开".into(),
            CloseReason::BadPassword => "密码错误".into(),
            CloseReason::PeerKeyChanged => "对方设备的公钥发生了变化".into(),
            CloseReason::Refused(s) => s.clone(),
            CloseReason::HostBye(r) if r.is_empty() => "对方已断开".into(),
            CloseReason::HostBye(r) => format!("对方已断开（{r}）"),
            CloseReason::Cancelled => "已取消".into(),
            CloseReason::ConsumerGone => "界面已退出".into(),
        }
    }

    pub(crate) fn from_error(e: &ConnectError) -> Self {
        match e {
            ConnectError::Establish(EstablishError::BadPassword) => CloseReason::BadPassword,
            ConnectError::Establish(EstablishError::PeerKeyChanged { .. }) => {
                CloseReason::PeerKeyChanged
            }
            ConnectError::Signal(crate::signal::SignalError::Cancelled) => CloseReason::Cancelled,
            other => CloseReason::Refused(other.user_text()),
        }
    }
}

/// 会话命令的失败原因。
#[derive(Debug, Clone, thiserror::Error)]
pub enum CtlError {
    /// 重连中或尚未连上：输入不会被悄悄排队，界面应提示"尚未连接"
    #[error("尚未连接（重连中）")]
    NotConnected,
    #[error("会话已关闭")]
    Closed,
    #[error("连接中断")]
    ConnectionLost,
    #[error("请求超时")]
    Timeout,
    #[error("会话不存在: {0}")]
    NoSuchSession(String),
    #[error("终端不存在: {0}")]
    NoSuchTerm(String),
    #[error("终端尚未附着: {0}")]
    TermNotAttached(String),
    #[error("被控端返回错误 {code}: {message}")]
    Remote { code: String, message: String },
    #[error("附件 {0} 尚未上传完成")]
    AttachmentNotReady(FileId),
    #[error("被控端不支持或已关闭文件接收")]
    FileUnsupported,
    #[error("文件过大（{size} 字节，被控端上限 {max} 字节）")]
    FileTooLarge { size: u64, max: u64 },
    #[error("同时上传的文件过多")]
    TooManyUploads,
    #[error("{0}")]
    Io(String),
}

/// `Controller::connect` 的参数。
pub struct ConnectOptions {
    /// 被控端设备码
    pub host_code: String,
    /// 密码原文（`Plain`，内部做 Argon2id 派生）或已派生的值（`Derived`）
    pub password: PasswordInput,
    /// 本地记住的被控端公钥；认证出的公钥与之不同时返回 `PeerKeyChanged`
    pub known_host_key: Option<Vec<u8>>,
    /// 用户已确认接受公钥变化
    pub accept_key_change: bool,
    pub app_version: String,
    pub timing: ControllerTiming,
}

impl ConnectOptions {
    pub fn new(host_code: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            host_code: host_code.into(),
            password: PasswordInput::Plain(password.into()),
            known_host_key: None,
            accept_key_change: false,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            timing: ControllerTiming::default(),
        }
    }
}

/// 一台被控端的会话句柄（可克隆，克隆体指向同一个会话任务）。
///
/// 所有方法都是对会话任务的有界通道请求。最后一个句柄被丢弃时会话以 `ConsumerGone` 结束。
#[derive(Clone)]
pub struct Controller {
    id: SessionId,
    cmd: mpsc::Sender<Cmd>,
    acks: Arc<AckBoard>,
    shared: Arc<Shared>,
    timing: Arc<ControllerTiming>,
    abort: tokio::task::AbortHandle,
}

impl std::fmt::Debug for Controller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Controller({})", self.id)
    }
}

impl Controller {
    /// 连接被控端并完成 `Hello/HelloAck`。成功时会话已处于 `Ready`，会话任务在后台运行。
    ///
    /// 事件序列：`SessionState(Connecting)` → 成功：`HostInfo`、`SessionState(Ready)`，随后 `ActionCatalog`；
    /// 失败：`SessionState(Closed(原因))`，并返回错误（首次连接不自动重试，由界面决定）。
    /// 连上之后的断线才会自动重连。
    pub async fn connect(
        connector: Arc<dyn Connector>,
        opts: ConnectOptions,
        events: mpsc::Sender<CoreEvent>,
    ) -> Result<Controller, ConnectError> {
        let id: SessionId = ulid::Ulid::generate().to_string();
        Self::connect_ctl(id, ConnectCtl::new(), connector, opts, events).await
    }

    /// 同 `connect`，会话 id 和控制句柄由调用方预先生成：连接可能停在“等待对方确认”很久，
    /// 调用方凭 id 随时可以 `ctl.cancel()`。进入等待确认阶段时会发 `SessionState(AwaitingApproval)`。
    pub async fn connect_ctl(
        id: SessionId,
        ctl: Arc<ConnectCtl>,
        connector: Arc<dyn Connector>,
        opts: ConnectOptions,
        events: mpsc::Sender<CoreEvent>,
    ) -> Result<Controller, ConnectError> {
        let (state_tx, _) = watch::channel(SessionState::Connecting);
        let shared = Arc::new(Shared {
            state: state_tx,
            host: Mutex::new(None),
            close_reason: Mutex::new(None),
            peer_key: Mutex::new(Vec::new()),
            rtt_ms: std::sync::atomic::AtomicU64::new(u64::MAX),
            term_meta: Mutex::new(HashMap::new()),
        });
        let _ = events
            .send(CoreEvent::SessionState {
                session: id.clone(),
                state: SessionState::Connecting,
            })
            .await;

        let fail = |e: ConnectError, reason: CloseReason| {
            let events = events.clone();
            let id = id.clone();
            let shared = shared.clone();
            async move {
                if let Ok(mut g) = shared.close_reason.lock() {
                    *g = Some(reason.clone());
                }
                shared
                    .state
                    .send_replace(SessionState::Closed(reason.text()));
                let _ = events
                    .send(CoreEvent::SessionState {
                        session: id,
                        state: SessionState::Closed(reason.text()),
                    })
                    .await;
                e
            }
        };

        // 密码只派生一次，之后（含重连）只用派生值
        let host_code = opts.host_code.clone();
        let (pw_key, pw_kind) = match opts.password.derive(&host_code).await {
            Ok(PasswordInput::Derived { key, kind }) => (key, kind),
            Err(e) => {
                let e = ConnectError::Establish(e);
                let reason = CloseReason::Refused(e.user_text());
                return Err(fail(e, reason).await);
            }
            Ok(PasswordInput::Plain(_)) => {
                let e = ConnectError::Establish(EstablishError::Protocol("密码处理失败".into()));
                let reason = CloseReason::Refused(e.user_text());
                return Err(fail(e, reason).await);
            }
        };
        let spec = ConnectSpec {
            host_code,
            pw_key: Zeroizing::new(pw_key),
            pw_kind,
            known_host_key: opts.known_host_key,
            accept_key_change: opts.accept_key_change,
            ctl: Some(ctl.clone()),
        };

        // 进入“等待对方确认”阶段时更新状态并发事件
        let mut awaiting = ctl.watch_awaiting();
        let fwd = {
            let (events, id, shared) = (events.clone(), id.clone(), shared.clone());
            tokio::spawn(async move {
                if awaiting.wait_for(|v| *v).await.is_ok() {
                    shared.state.send_replace(SessionState::AwaitingApproval);
                    let _ = events
                        .send(CoreEvent::SessionState {
                            session: id,
                            state: SessionState::AwaitingApproval,
                        })
                        .await;
                }
            })
        };
        let established =
            connect::establish(connector.as_ref(), &spec, &opts.timing, &opts.app_version).await;
        if *ctl.watch_awaiting().borrow() {
            let _ = fwd.await; // 保证 AwaitingApproval 事件先于后续事件
        } else {
            fwd.abort();
        }
        let (mut conn, ack) = match established {
            Ok(x) => x,
            Err(e) => {
                let reason = CloseReason::from_error(&e);
                return Err(fail(e, reason).await);
            }
        };
        let mut spec = spec;
        spec.ctl = None; // 之后的重连尝试不再受它控制

        let (cmd_tx, cmd_rx) = cmd_channel();
        let acks = Arc::new(AckBoard::default());
        let mut actor = Actor::new(
            id.clone(),
            connector,
            spec,
            opts.timing.clone(),
            opts.app_version,
            events,
            cmd_rx,
            acks.clone(),
            shared.clone(),
        );
        actor.begin_connection(&mut conn, ack, false).await;
        let task = tokio::spawn(actor.run(conn));
        Ok(Controller {
            id,
            cmd: cmd_tx,
            acks,
            shared,
            timing: Arc::new(opts.timing),
            abort: task.abort_handle(),
        })
    }

    pub fn session_id(&self) -> &SessionId {
        &self.id
    }

    pub fn state(&self) -> SessionState {
        self.shared.state.borrow().clone()
    }

    /// 订阅状态变化。
    pub fn watch_state(&self) -> watch::Receiver<SessionState> {
        self.shared.state.subscribe()
    }

    /// 会话关闭后的结构化原因（界面据此决定是否弹出重新输入密码）。
    pub fn close_reason(&self) -> Option<CloseReason> {
        self.shared.close_reason.lock().ok().and_then(|g| g.clone())
    }

    /// 被控端能力和主机信息（最近一次 `HelloAck`）。
    pub fn host(&self) -> Option<HostSnapshot> {
        self.shared.host.lock().ok().and_then(|g| g.clone())
    }

    /// 被控端经握手认证的公钥。首次连接某台设备后，界面据此记住它（TOFU）。
    pub fn peer_public_key(&self) -> Vec<u8> {
        self.shared
            .peer_key
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// 最近一次 Ping/Pong 测得的往返延迟（毫秒）；还没有测量时为 None。
    pub fn rtt_ms(&self) -> Option<u64> {
        match self
            .shared
            .rtt_ms
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            u64::MAX => None,
            v => Some(v),
        }
    }

    /// 终端打开时被控端给的 `(title, shell)`（只有本会话 `open_term` 打开的终端才有）。
    pub fn term_meta(&self, term: &str) -> Option<(String, String)> {
        self.shared
            .term_meta
            .lock()
            .ok()
            .and_then(|m| m.get(term).cloned())
    }

    async fn call<T>(
        &self,
        wait: Duration,
        mk: impl FnOnce(oneshot::Sender<Result<T, CtlError>>) -> Cmd,
    ) -> Result<T, CtlError> {
        let (tx, rx) = oneshot::channel();
        self.cmd.send(mk(tx)).await.map_err(|_| CtlError::Closed)?;
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(CtlError::Closed),
            Err(_) => Err(CtlError::Timeout),
        }
    }

    /// 只在本端排队的命令的等待上限（会话任务忙于发送时最多等一次发送超时）。
    fn local_wait(&self) -> Duration {
        self.timing.request_timeout + self.timing.send_timeout
    }

    /// 打开终端，返回被控端分配的终端 id。超时 15 秒。
    pub async fn open_term(&self, opts: TermOpenOptions) -> Result<TermId, CtlError> {
        self.call(self.timing.request_timeout, |reply| Cmd::OpenTerm {
            opts,
            reply,
        })
        .await
    }

    /// 被控端上现有的全部终端（包括别的会话打开的、已脱离的）。
    pub async fn list_terms(&self) -> Result<Vec<pb::TermInfo>, CtlError> {
        self.call(self.timing.request_timeout, |reply| Cmd::ListTerms {
            reply,
        })
        .await
    }

    /// 附着到已有终端，被控端从本端已收到的偏移之后回放。第一次附着某终端时偏移为 0（回放环形缓冲的全部内容）。
    pub async fn attach_term(&self, term: &str, size: TermSize) -> Result<(), CtlError> {
        self.attach_term_from(term, size, None).await
    }

    /// 同 `attach_term`，另外指定界面已渲染到的流偏移 `from_seq`：被控端从该处回放。
    /// 偏移小于控制器已交付的偏移时会回退并重新交付 `[from_seq, …)` 的输出（界面重建过的情形）。
    pub async fn attach_term_from(
        &self,
        term: &str,
        size: TermSize,
        from_seq: Option<u64>,
    ) -> Result<(), CtlError> {
        self.call(self.timing.request_timeout, |reply| Cmd::AttachTerm {
            term: term.to_string(),
            size,
            from_seq,
            reply,
        })
        .await
    }

    /// 直通按键。重连中返回 [`CtlError::NotConnected`]。
    pub async fn term_input(&self, term: &str, data: Vec<u8>) -> Result<(), CtlError> {
        self.call(self.local_wait(), |reply| Cmd::Input {
            term: term.to_string(),
            data,
            reply,
        })
        .await
    }

    /// 提交一条消息（回车发送）。`attachments` 必须是本连接内已上传完成的文件。返回消息序号。
    pub async fn term_submit(
        &self,
        term: &str,
        text: String,
        attachments: Vec<FileId>,
    ) -> Result<u64, CtlError> {
        self.term_submit_ex(term, text, attachments, true).await
    }

    /// 同 `term_submit`，可指定是否在末尾补回车。
    pub async fn term_submit_ex(
        &self,
        term: &str,
        text: String,
        attachments: Vec<FileId>,
        press_enter: bool,
    ) -> Result<u64, CtlError> {
        self.call(self.local_wait(), |reply| Cmd::Submit {
            term: term.to_string(),
            text,
            attachments,
            press_enter,
            reply,
        })
        .await
    }

    /// 调整终端尺寸。重连中只记录，重新附着时带上。
    pub async fn term_resize(&self, term: &str, size: TermSize) -> Result<(), CtlError> {
        self.call(self.local_wait(), |reply| Cmd::Resize {
            term: term.to_string(),
            size,
            reply,
        })
        .await
    }

    /// 界面已渲染到的输出偏移（= 事件里 `seq + data.len()` 的最大值）。同步、不会阻塞，可在处理事件时调用。
    /// 流控节流（每 256KB 或每 100ms）由调用方负责；这里取最大值、不超过已收到的偏移，并在附着状态下转发给被控端。
    pub fn term_ack(&self, term: &str, consumed: u64) {
        self.acks.put(term, consumed);
    }

    /// 关闭并杀掉终端。重连中调用时，重连成功后补发。
    pub async fn close_term(&self, term: &str) -> Result<(), CtlError> {
        self.call(self.local_wait(), |reply| Cmd::CloseTerm {
            term: term.to_string(),
            reply,
        })
        .await
    }

    /// 执行动作目录里的动作。返回 `req_id`，结果以 `CoreEvent::ActionResult` 送回（`result.req_id` 对应）。
    pub async fn term_action(
        &self,
        term: &str,
        action_id: &str,
        args: HashMap<String, String>,
    ) -> Result<u64, CtlError> {
        self.call(self.local_wait(), |reply| Cmd::Action {
            term: term.to_string(),
            action_id: action_id.to_string(),
            args,
            reply,
        })
        .await
    }

    /// 请求自定义命令清单，结果以 `CoreEvent::CommandList` 送回。
    pub async fn command_list_req(&self, term: &str) -> Result<(), CtlError> {
        self.call(self.local_wait(), |reply| Cmd::CommandList {
            term: term.to_string(),
            reply,
        })
        .await
    }

    /// 开始上传，返回 `FileId`；进度、完成、失败以 `UploadProgress/UploadDone/UploadFailed` 事件送回。
    /// 路径来源在后台流式读取。重连会让进行中的上传失败（不续传）。
    pub async fn upload(&self, src: UploadSource) -> Result<FileId, CtlError> {
        match self.state() {
            SessionState::Closed(_) => return Err(CtlError::Closed),
            SessionState::Reconnecting
            | SessionState::Connecting
            | SessionState::AwaitingApproval => return Err(CtlError::NotConnected),
            SessionState::Ready => {}
        }
        let prepared = src.prepare().await.map_err(CtlError::Io)?;
        if let Some(h) = self.host() {
            let max = h.info.max_file_size;
            if max > 0 && prepared.size > max {
                return Err(CtlError::FileTooLarge {
                    size: prepared.size,
                    max,
                });
            }
        }
        self.call(self.local_wait(), |reply| Cmd::Upload { prepared, reply })
            .await
    }

    /// 取消上传（发 `FileCancel`，被控端删除 `.part`）。事件以 `UploadFailed("已取消")` 送回。
    pub fn cancel_upload(&self, file: FileId) {
        let _ = self.cmd.try_send(Cmd::CancelUpload { file });
    }

    /// 网络恢复 / 系统唤醒时调用：重连退避中则立即重试。
    pub fn reconnect_now(&self) {
        let _ = self.cmd.try_send(Cmd::ReconnectNow);
    }

    /// 主动断开。返回时会话已 `Closed`（最多等 3 秒，之后强制终止会话任务）。
    pub async fn disconnect(&self) {
        let (tx, rx) = oneshot::channel();
        if self.cmd.send(Cmd::Disconnect { reply: tx }).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(3), rx).await;
        }
        let mut w = self.shared.state.subscribe();
        let closed = tokio::time::timeout(
            Duration::from_secs(3),
            w.wait_for(|s| matches!(s, SessionState::Closed(_))),
        )
        .await
        .is_ok();
        if !closed {
            self.abort.abort();
            if let Ok(mut g) = self.shared.close_reason.lock() {
                *g = Some(CloseReason::User);
            }
            self.shared
                .state
                .send_replace(SessionState::Closed(CloseReason::User.text()));
        }
    }
}

/// 连接请求。
pub struct ConnectRequest {
    pub host_code: String,
    pub password: PasswordInput,
    pub known_host_key: Option<Vec<u8>>,
    pub accept_key_change: bool,
}

/// 多会话管理：同时连接多台被控端，按 `SessionId` 路由。所有会话共用同一个事件通道。
pub struct ControllerManager {
    connector: Arc<dyn Connector>,
    events: mpsc::Sender<CoreEvent>,
    app_version: String,
    timing: ControllerTiming,
    sessions: Mutex<HashMap<SessionId, Controller>>,
    /// 正在连接（含等待对方确认）的会话，可取消
    connecting: Mutex<HashMap<SessionId, Arc<ConnectCtl>>>,
}

impl ControllerManager {
    pub fn new(
        connector: Arc<dyn Connector>,
        events: mpsc::Sender<CoreEvent>,
        app_version: impl Into<String>,
        timing: ControllerTiming,
    ) -> Self {
        Self {
            connector,
            events,
            app_version: app_version.into(),
            timing,
            sessions: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashMap::new()),
        }
    }

    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<SessionId, Controller>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 用密码原文连接。
    pub async fn connect(
        &self,
        host_code: &str,
        password: &str,
    ) -> Result<SessionId, ConnectError> {
        self.connect_with(ConnectRequest {
            host_code: host_code.to_string(),
            password: PasswordInput::Plain(password.to_string()),
            known_host_key: None,
            accept_key_change: false,
        })
        .await
    }

    pub async fn connect_with(&self, req: ConnectRequest) -> Result<SessionId, ConnectError> {
        self.prune_closed();
        let id: SessionId = ulid::Ulid::generate().to_string();
        let ctl = ConnectCtl::new();
        self.connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), ctl.clone());
        let r = Controller::connect_ctl(
            id.clone(),
            ctl,
            self.connector.clone(),
            ConnectOptions {
                host_code: req.host_code,
                password: req.password,
                known_host_key: req.known_host_key,
                accept_key_change: req.accept_key_change,
                app_version: self.app_version.clone(),
                timing: self.timing.clone(),
            },
            self.events.clone(),
        )
        .await;
        self.connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        let c = r?;
        self.map().insert(id.clone(), c);
        Ok(id)
    }

    /// 取消一个还没连上的连接（包括正在等对方确认的）。返回是否找到。
    /// 对应的 `connect_with` 会返回“已取消”错误。
    pub fn cancel_connect(&self, session: &str) -> bool {
        match self
            .connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
        {
            Some(c) => {
                c.cancel();
                true
            }
            None => false,
        }
    }

    /// 取会话句柄。
    pub fn get(&self, session: &str) -> Result<Controller, CtlError> {
        self.map()
            .get(session)
            .cloned()
            .ok_or_else(|| CtlError::NoSuchSession(session.to_string()))
    }

    /// 现有会话（含重连中的；已关闭的会先被清理）。
    pub fn sessions(&self) -> Vec<SessionId> {
        self.prune_closed();
        self.map().keys().cloned().collect()
    }

    /// 清理已经 Closed 的会话。
    pub fn prune_closed(&self) {
        self.map()
            .retain(|_, c| !matches!(c.state(), SessionState::Closed(_)));
    }

    /// 断开并移除会话。
    pub async fn disconnect(&self, session: &str) {
        let c = self.map().remove(session);
        if let Some(c) = c {
            c.disconnect().await;
        }
    }

    /// 网络恢复 / 唤醒：所有处于重连退避中的会话立即重试。
    pub fn reconnect_all_now(&self) {
        for c in self.map().values() {
            c.reconnect_now();
        }
    }

    // —— 以下按 SessionId 路由到对应会话 ——

    pub async fn open_term(
        &self,
        session: &str,
        opts: TermOpenOptions,
    ) -> Result<TermId, CtlError> {
        self.get(session)?.open_term(opts).await
    }

    pub async fn list_terms(&self, session: &str) -> Result<Vec<pb::TermInfo>, CtlError> {
        self.get(session)?.list_terms().await
    }

    pub async fn attach_term(
        &self,
        session: &str,
        term: &str,
        size: TermSize,
    ) -> Result<(), CtlError> {
        self.get(session)?.attach_term(term, size).await
    }

    pub async fn attach_term_from(
        &self,
        session: &str,
        term: &str,
        size: TermSize,
        from_seq: Option<u64>,
    ) -> Result<(), CtlError> {
        self.get(session)?
            .attach_term_from(term, size, from_seq)
            .await
    }

    pub async fn term_input(
        &self,
        session: &str,
        term: &str,
        data: Vec<u8>,
    ) -> Result<(), CtlError> {
        self.get(session)?.term_input(term, data).await
    }

    pub async fn term_submit(
        &self,
        session: &str,
        term: &str,
        text: String,
        attachments: Vec<FileId>,
    ) -> Result<u64, CtlError> {
        self.get(session)?
            .term_submit(term, text, attachments)
            .await
    }

    pub async fn term_resize(
        &self,
        session: &str,
        term: &str,
        size: TermSize,
    ) -> Result<(), CtlError> {
        self.get(session)?.term_resize(term, size).await
    }

    /// 同步；会话不存在时忽略。
    pub fn term_ack(&self, session: &str, term: &str, consumed: u64) {
        if let Ok(c) = self.get(session) {
            c.term_ack(term, consumed);
        }
    }

    pub async fn close_term(&self, session: &str, term: &str) -> Result<(), CtlError> {
        self.get(session)?.close_term(term).await
    }

    pub async fn term_action(
        &self,
        session: &str,
        term: &str,
        action_id: &str,
        args: HashMap<String, String>,
    ) -> Result<u64, CtlError> {
        self.get(session)?.term_action(term, action_id, args).await
    }

    pub async fn command_list_req(&self, session: &str, term: &str) -> Result<(), CtlError> {
        self.get(session)?.command_list_req(term).await
    }

    pub async fn upload(&self, session: &str, src: UploadSource) -> Result<FileId, CtlError> {
        self.get(session)?.upload(src).await
    }

    pub fn cancel_upload(&self, session: &str, file: FileId) {
        if let Ok(c) = self.get(session) {
            c.cancel_upload(file);
        }
    }
}
