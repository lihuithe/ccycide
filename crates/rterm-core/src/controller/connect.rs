//! 主控端建立会话的一次尝试：信令 `connect.request` → 中继 → 握手 → `Hello/HelloAck`。
//!
//! 为了能不经过网络测试重连逻辑，"拿到一条加密 Link"这一步抽象成 [`Connector`]：
//! 生产环境用 [`SignalConnector`]，测试用返回 `loopback_pair` 的假实现。
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use rterm_proto::{pb, MIN_PROTO_VER, PROTO_VER};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use super::ControllerTiming;
use crate::identity::Identity;
use crate::link::{FrameTx, Link};
use crate::mux::MuxHandle;
use crate::netutil::NetOptions;
use crate::relay::{
    close_code_text, establish_controller_ex, ControllerParams, EstablishError, PasswordInput,
};
use crate::signal::{SignalClient, SignalError};

/// 本端声明的能力（《实现方案.md》4.6、18.10）。
pub const FEATURES: &[&str] = &[
    "file.upload",
    "term.submit",
    "app.actions",
    "app.state",
    "app.commands",
];

/// 一次连接尝试的外部控制：观察“已进入等待对方确认”，随时取消。
pub struct ConnectCtl {
    cancel: tokio::sync::watch::Sender<bool>,
    awaiting: tokio::sync::watch::Sender<bool>,
}

impl ConnectCtl {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancel: tokio::sync::watch::channel(false).0,
            awaiting: tokio::sync::watch::channel(false).0,
        })
    }

    /// 取消等待（幂等）。
    pub fn cancel(&self) {
        self.cancel.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    pub(crate) fn watch_awaiting(&self) -> tokio::sync::watch::Receiver<bool> {
        self.awaiting.subscribe()
    }

    fn set_awaiting(&self) {
        self.awaiting.send_replace(true);
    }
}

async fn wait_cancel(ctl: Option<&Arc<ConnectCtl>>) {
    match ctl {
        Some(c) => {
            let mut rx = c.cancel.subscribe();
            let _ = rx.wait_for(|v| *v).await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// 一次连接尝试需要的全部信息。密码只以派生值形式留在内存里，用完清零。
#[derive(Clone)]
pub struct ConnectSpec {
    pub host_code: String,
    pub pw_key: Zeroizing<[u8; 32]>,
    /// 0 临时密码 / 1 固定密码
    pub pw_kind: u32,
    /// 本地记住的被控端公钥；握手认证出的公钥不一致时报 `PeerKeyChanged`
    pub known_host_key: Option<Vec<u8>>,
    pub accept_key_change: bool,
    /// 首次连接时的取消 / 进度控制；重连尝试里为 None
    pub ctl: Option<Arc<ConnectCtl>>,
}

impl ConnectSpec {
    pub fn password(&self) -> PasswordInput {
        PasswordInput::Derived {
            key: *self.pw_key,
            kind: self.pw_kind,
        }
    }
}

impl std::fmt::Debug for ConnectSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectSpec")
            .field("host_code", &self.host_code)
            .field("pw_kind", &self.pw_kind)
            .finish_non_exhaustive()
    }
}

/// 连接成功后的产物。
pub struct Connected {
    pub link: Link,
    /// 中继会话句柄（用来取关闭原因）；测试里可以没有
    pub close: Option<MuxHandle>,
    /// 经握手认证的被控端公钥
    pub peer_public_key: Vec<u8>,
}

/// 建立会话失败的原因。
#[derive(Debug, Clone, thiserror::Error)]
pub enum ConnectError {
    #[error("{}", .0.user_text())]
    Signal(SignalError),
    #[error("{0}")]
    Establish(EstablishError),
    /// `Hello` 之后没等到 `HelloAck`
    #[error("被控端没有响应握手后的问候")]
    HelloTimeout,
    /// 被控端以 `Error` 或 `Bye` 拒绝（例如协议版本不兼容）
    #[error("被控端拒绝了会话: {0}")]
    HelloRejected(String),
    /// 握手完成后链路马上断了
    #[error("连接在建立过程中断开")]
    LinkLost,
}

impl ConnectError {
    /// 自动重连是否值得继续（《开发指南.md》T24）：
    /// 密码错误、被拒绝、被锁定、版本不兼容、封禁、公钥变化等不重试；对方暂时离线（UNAVAILABLE）和网络类错误继续重试。
    pub fn is_retryable(&self) -> bool {
        match self {
            ConnectError::Signal(e) => match e {
                SignalError::Connect(code) => {
                    matches!(code.as_str(), "UNAVAILABLE" | "RATE_LIMITED" | "NO_RELAY")
                }
                SignalError::Offline
                | SignalError::Timeout
                | SignalError::Closed
                | SignalError::Server(_)
                | SignalError::BadResponse => true,
                SignalError::Stopped | SignalError::Cancelled => false,
            },
            ConnectError::Establish(e) => e.is_retryable(),
            ConnectError::HelloTimeout | ConnectError::LinkLost => true,
            ConnectError::HelloRejected(_) => false,
        }
    }

    /// 是密码错误。
    pub fn is_bad_password(&self) -> bool {
        matches!(self, ConnectError::Establish(EstablishError::BadPassword))
    }

    /// 给界面看的文字。
    pub fn user_text(&self) -> String {
        match self {
            ConnectError::Signal(e) => e.user_text(),
            ConnectError::Establish(EstablishError::BadPassword) => "密码错误".into(),
            ConnectError::Establish(EstablishError::PeerKeyChanged { .. }) => {
                "对方设备的公钥发生了变化，请确认后再连接".into()
            }
            other => other.to_string(),
        }
    }
}

/// 取得一条已加密的会话链路。
pub trait Connector: Send + Sync + 'static {
    fn connect<'a>(
        &'a self,
        spec: &'a ConnectSpec,
    ) -> BoxFuture<'a, Result<Connected, ConnectError>>;
}

/// 生产用的连接器：信令 `connect.request` + 中继握手。
pub struct SignalConnector {
    pub signal: SignalClient,
    pub identity: Arc<Identity>,
    pub net: NetOptions,
    /// 信令暂时离线时，最多等它上线这么久再发请求
    pub wait_online: Duration,
}

impl SignalConnector {
    pub fn new(signal: SignalClient, identity: Arc<Identity>, net: NetOptions) -> Self {
        Self {
            signal,
            identity,
            net,
            wait_online: Duration::from_secs(5),
        }
    }
}

impl Connector for SignalConnector {
    fn connect<'a>(
        &'a self,
        spec: &'a ConnectSpec,
    ) -> BoxFuture<'a, Result<Connected, ConnectError>> {
        Box::pin(async move {
            if !self.signal.is_online() {
                self.signal.wait_online(self.wait_online).await;
            }
            let controller_code = self
                .signal
                .device_code()
                .ok_or(ConnectError::Signal(SignalError::Offline))?;
            let mut handle = self
                .signal
                .connect_request_ex(&spec.host_code)
                .await
                .map_err(ConnectError::Signal)?;
            // 请求发出后可能要等很久（对方用户确认），期间可取消；进入等待确认阶段时通知上层
            let canceller = handle.canceller();
            let ctl = spec.ctl.as_ref();
            let mut cancel_sent = false;
            tokio::select! {
                p = handle.wait_pending() => {
                    if let (Some(_), Some(c)) = (p, ctl) {
                        c.set_awaiting();
                    }
                }
                _ = wait_cancel(ctl) => {
                    canceller.cancel();
                    cancel_sent = true;
                }
            }
            let result = handle.result();
            tokio::pin!(result);
            let ok = loop {
                tokio::select! {
                    r = &mut result => break r.map_err(ConnectError::Signal)?,
                    _ = wait_cancel(ctl), if !cancel_sent => {
                        canceller.cancel();
                        cancel_sent = true;
                    }
                }
            };
            let (link, handle) = establish_controller_ex(ControllerParams {
                relay_url: ok.relay_url,
                ticket: ok.ticket,
                session_id: ok.session_id,
                identity: self.identity.clone(),
                controller_code,
                host_code: spec.host_code.clone(),
                host_public_key: ok.peer.public_key,
                host_platform: ok.peer.platform,
                password: spec.password(),
                known_host_key: spec.known_host_key.clone(),
                accept_key_change: spec.accept_key_change,
                net: self.net.clone(),
            })
            .await
            .map_err(ConnectError::Establish)?;
            Ok(Connected {
                link,
                close: Some(handle.mux),
                peer_public_key: handle.peer_public_key.to_vec(),
            })
        })
    }
}

/// 当前这条连接的运行态。会话任务持有，断开时整个丢弃。
pub(crate) struct Conn {
    pub tx: FrameTx,
    pub rx: mpsc::Receiver<pb::Frame>,
    pub close: Option<MuxHandle>,
    pub peer_key: Vec<u8>,
    pub last_rx: tokio::time::Instant,
    pub last_ping: tokio::time::Instant,
    /// 发送失败或超时后置位，主循环据此判定连接已死
    pub dead: bool,
    /// 重连后正在恢复终端
    pub resync: Option<Resync>,
}

/// 重连后恢复终端的进度：`TermList` → 对每个终端 `TermAttach`。全部有结果后才进入 `Ready`。
pub(crate) struct Resync {
    pub outstanding: std::collections::HashSet<u64>,
    pub list_pending: bool,
    pub deadline: tokio::time::Instant,
}

pub(crate) fn frame(channel: u32, body: pb::frame::Body) -> pb::Frame {
    pb::Frame {
        channel,
        body: Some(body),
    }
}

/// 一次完整的建立：连接器取链路 → 发 `Hello` → 等 `HelloAck`。
pub(crate) async fn establish(
    connector: &dyn Connector,
    spec: &ConnectSpec,
    timing: &ControllerTiming,
    app_version: &str,
) -> Result<(Conn, pb::HelloAck), ConnectError> {
    let Connected {
        link,
        close,
        peer_public_key,
    } = connector.connect(spec).await?;
    let Link { tx, mut rx, .. } = link;

    let hello = pb::Hello {
        proto_ver: PROTO_VER,
        min_proto_ver: MIN_PROTO_VER,
        app_version: app_version.to_string(),
        features: FEATURES.iter().map(|s| s.to_string()).collect(),
    };
    tx.send(frame(0, pb::frame::Body::Hello(hello)))
        .await
        .map_err(|_| ConnectError::LinkLost)?;

    let wait = async {
        loop {
            let Some(f) = rx.recv().await else {
                return Err(ConnectError::LinkLost);
            };
            match f.body {
                Some(pb::frame::Body::HelloAck(a)) => return Ok(a),
                Some(pb::frame::Body::Error(e)) => {
                    return Err(ConnectError::HelloRejected(format!(
                        "{}: {}",
                        e.code, e.message
                    )))
                }
                Some(pb::frame::Body::Bye(b)) => {
                    return Err(ConnectError::HelloRejected(format!(
                        "对方断开: {}",
                        b.reason
                    )))
                }
                // HelloAck 之前的其它帧（例如 Pong）忽略
                _ => continue,
            }
        }
    };
    let ack = match tokio::time::timeout(timing.hello_timeout, wait).await {
        Ok(r) => r?,
        Err(_) => return Err(ConnectError::HelloTimeout),
    };
    if ack.proto_ver < MIN_PROTO_VER {
        return Err(ConnectError::HelloRejected("协议版本不兼容".into()));
    }
    let now = tokio::time::Instant::now();
    Ok((
        Conn {
            tx,
            rx,
            close,
            peer_key: peer_public_key,
            last_rx: now,
            last_ping: now,
            dead: false,
            resync: None,
        },
        ack,
    ))
}

/// 中继关闭原因的文字（取不到时给通用说明）。
pub(crate) async fn lost_reason(close: Option<&MuxHandle>) -> String {
    let Some(h) = close else {
        return "连接已断开".into();
    };
    let mut h = h.clone();
    match tokio::time::timeout(Duration::from_millis(300), h.wait_closed()).await {
        Ok(info) => match info.code {
            Some(c) => close_code_text(c).to_string(),
            None if !info.reason.is_empty() => info.reason,
            None => "连接已断开".into(),
        },
        Err(_) => "连接已断开".into(),
    }
}
