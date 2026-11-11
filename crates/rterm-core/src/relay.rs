//! 中继连接 + 会话建立。
//!
//! - `RelaySocket`：中继 WSS 连接，一个元素 = 一条二进制记录；文本消息视为协议错误；
//!   不启用压缩；识别中继关闭码 4001–4007。
//! - `establish_controller` / `establish_host`：连中继 → SPAKE2 握手（照《开发指南.md》T28）→ 启动加密 mux，得到 `Link`。
//!   一次连接只允许一次握手尝试；失败的原因通过 `EstablishError` 明确区分。
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use prost::Message as _;
use rterm_proto::pb::{handshake::Body as HsBody, Handshake};
use rterm_proto::{PROTO_VER, REC_HANDSHAKE};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use zeroize::Zeroizing;

use crate::crypto::handshake::{
    ControllerCtx, ControllerStart, Established, HostCtx, HostStart, HsError,
};
use crate::crypto::{derive_pw_key_async, password_kind_of, Sealer};
use crate::identity::Identity;
use crate::link::{HostPasswords, Link, PeerInfo};
use crate::mux::{spawn_mux, MuxHandle, MAX_RECORD};
use crate::netutil::{connect_ws, ConnectError, NetOptions, WsStream};

// 中继关闭码（《实现方案.md》4.4）
pub const CLOSE_TICKET_INVALID: u16 = 4001;
pub const CLOSE_PAIR_TIMEOUT: u16 = 4002;
pub const CLOSE_PEER_GONE: u16 = 4003;
pub const CLOSE_RATE_LIMIT: u16 = 4004;
pub const CLOSE_QUOTA: u16 = 4005;
pub const CLOSE_MAINTENANCE: u16 = 4006;
pub const CLOSE_BAD_MESSAGE: u16 = 4007;

/// 中继关闭码的中文说明。
pub fn close_code_text(code: u16) -> &'static str {
    match code {
        CLOSE_TICKET_INVALID => "票据无效或过期",
        CLOSE_PAIR_TIMEOUT => "配对超时（对端未连上）",
        CLOSE_PEER_GONE => "对端已断开",
        CLOSE_RATE_LIMIT => "超出速率限制",
        CLOSE_QUOTA => "超出流量配额",
        CLOSE_MAINTENANCE => "服务端维护，请重连",
        CLOSE_BAD_MESSAGE => "消息过大或类型错误",
        _ => "连接已关闭",
    }
}

/// 整个握手的时限。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 被控端等待主控端 PakeInit 的时限（中继配对超时 15 秒，留出余量）。
pub const HOST_WAIT_INIT_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------- 中继连接

#[derive(Debug, Clone, thiserror::Error)]
pub enum RelayError {
    #[error("连接中继失败: {0}")]
    Connect(String),
    #[error("中继关闭连接（{}）", code.map(|c| format!("{c} {}", close_code_text(c))).unwrap_or_else(|| "无关闭码".into()))]
    Closed { code: Option<u16>, reason: String },
    #[error("协议错误: {0}")]
    Protocol(String),
    #[error("网络错误: {0}")]
    Io(String),
}

impl RelayError {
    pub fn close_code(&self) -> Option<u16> {
        match self {
            RelayError::Closed { code, .. } => *code,
            _ => None,
        }
    }
}

fn map_ws_err(e: WsError) -> RelayError {
    match e {
        WsError::ConnectionClosed | WsError::AlreadyClosed => RelayError::Closed {
            code: None,
            reason: String::new(),
        },
        WsError::Capacity(c) => RelayError::Protocol(format!("消息过大: {c}")),
        WsError::Protocol(p) => RelayError::Protocol(p.to_string()),
        other => RelayError::Io(other.to_string()),
    }
}

/// 中继 WebSocket 连接。作为 `Stream<Item = Result<记录>>` 与 `Sink<记录>` 使用，
/// 可用 `StreamExt::split` 拆成读写两半交给 mux。
pub struct RelaySocket {
    ws: WsStream,
    done: bool,
}

impl RelaySocket {
    /// 连接 `{relay_url}/v1/relay?ticket={ticket}`。
    pub async fn connect(
        relay_url: &str,
        ticket: &str,
        net: &NetOptions,
    ) -> Result<Self, RelayError> {
        let url = relay_endpoint(relay_url, ticket)?;
        // 比上限略大，由中继负责按 128KB 限制；本端读到超长记录会在 mux 里拒绝
        let ws = connect_ws(&url, net, MAX_RECORD + 1024)
            .await
            .map_err(|e| match e {
                ConnectError::Timeout => RelayError::Connect("连接超时".into()),
                other => RelayError::Connect(other.to_string()),
            })?;
        Ok(Self { ws, done: false })
    }

    /// 主动关闭（带正常关闭码）。
    pub async fn close(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), SinkExt::close(&mut self)).await;
    }
}

/// 拼接中继地址。`relay_url` 已带 `/v1/relay` 时不重复添加。
pub fn relay_endpoint(relay_url: &str, ticket: &str) -> Result<String, RelayError> {
    let mut u = url::Url::parse(relay_url)
        .map_err(|e| RelayError::Connect(format!("中继地址无效 {relay_url}: {e}")))?;
    if !u.path().trim_end_matches('/').ends_with("/v1/relay") {
        let p = format!("{}/v1/relay", u.path().trim_end_matches('/'));
        u.set_path(&p);
    }
    u.query_pairs_mut().append_pair("ticket", ticket);
    Ok(u.to_string())
}

impl Stream for RelaySocket {
    type Item = Result<Vec<u8>, RelayError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if self.done {
                return Poll::Ready(None);
            }
            match self.ws.poll_next_unpin(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(RelayError::Closed {
                        code: None,
                        reason: "连接已断开".into(),
                    })));
                }
                Poll::Ready(Some(Err(e))) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(map_ws_err(e))));
                }
                Poll::Ready(Some(Ok(msg))) => match msg {
                    Message::Binary(b) => return Poll::Ready(Some(Ok(b.to_vec()))),
                    Message::Close(frame) => {
                        self.done = true;
                        let (code, reason) = match frame {
                            Some(f) => {
                                let c = u16::from(f.code);
                                // 1000 正常关闭等标准码不算中继自定义码，但仍原样上报
                                (Some(c), f.reason.to_string())
                            }
                            None => (None, String::new()),
                        };
                        return Poll::Ready(Some(Err(RelayError::Closed { code, reason })));
                    }
                    Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                    Message::Text(_) => {
                        self.done = true;
                        return Poll::Ready(Some(Err(RelayError::Protocol("收到文本消息".into()))));
                    }
                },
            }
        }
    }
}

impl Sink<Vec<u8>> for RelaySocket {
    type Error = RelayError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.ws.poll_ready_unpin(cx).map_err(map_ws_err)
    }

    fn start_send(mut self: Pin<&mut Self>, item: Vec<u8>) -> Result<(), Self::Error> {
        if item.len() > MAX_RECORD {
            return Err(RelayError::Protocol("记录超过 128KB".into()));
        }
        self.ws
            .start_send_unpin(Message::Binary(item.into()))
            .map_err(map_ws_err)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.ws.poll_flush_unpin(cx).map_err(map_ws_err)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.ws.poll_close_unpin(cx).map_err(map_ws_err)
    }
}

#[allow(dead_code)]
fn _assert_close_code_type(c: CloseCode) -> u16 {
    u16::from(c)
}

// ---------------------------------------------------------------- 建立会话

/// 建立会话失败的原因。上层据此决定是否重试、是否上报 `auth_failed`。
#[derive(Debug, Clone, thiserror::Error)]
pub enum EstablishError {
    /// 密码错误。
    /// - 被控端：主控端的确认 mac 不对（应记一次失败，并向信令上报 `auth_failed`）；
    /// - 主控端：被控端在握手最后一步关闭了连接。
    #[error("密码错误")]
    BadPassword,
    /// 被控端公钥与本地记住的不一致（可能被冒充，或对方重装了系统）。
    /// 握手本身已通过（密码正确且签名有效），`actual` 是这次认证出来的公钥。
    /// 用户确认后可设置 `accept_key_change` 重新连接。
    #[error("对方设备的公钥发生了变化")]
    PeerKeyChanged { known: Vec<u8>, actual: Vec<u8> },
    /// 握手里的公钥与信令下发的不一致（中继冒充，或信令数据被篡改）。
    #[error("对方公钥与信令下发的不一致，连接不安全")]
    SignalKeyMismatch,
    /// 签名校验失败（连接不安全）。
    #[error("对方签名校验失败，连接不安全")]
    BadSignature,
    /// 中继关闭了连接。`code` 为 4001–4007。
    #[error("中继关闭连接（{}）", code.map(|c| format!("{c} {}", close_code_text(c))).unwrap_or_else(|| "无关闭码".into()))]
    RelayClosed { code: Option<u16> },
    /// 连接中继失败（网络、TLS、代理、HTTP 拒绝）。
    #[error("连接中继失败: {0}")]
    Connect(String),
    /// 握手超时。
    #[error("握手超时")]
    Timeout,
    /// 协议版本不兼容。
    #[error("协议版本不兼容（对端 {peer}）")]
    Version { peer: u32 },
    /// 对端违反协议（消息不符合当前步骤、格式错误）。
    #[error("握手协议错误: {0}")]
    Protocol(String),
}

impl EstablishError {
    /// 重试是否可能成功（网络类错误可以，密码/版本/安全类错误不应自动重试）。
    pub fn is_retryable(&self) -> bool {
        match self {
            EstablishError::Connect(_) | EstablishError::Timeout => true,
            EstablishError::RelayClosed { code } => !matches!(
                code,
                Some(CLOSE_TICKET_INVALID) | Some(CLOSE_QUOTA) | Some(CLOSE_BAD_MESSAGE)
            ),
            EstablishError::BadPassword
            | EstablishError::PeerKeyChanged { .. }
            | EstablishError::SignalKeyMismatch
            | EstablishError::BadSignature
            | EstablishError::Version { .. }
            | EstablishError::Protocol(_) => false,
        }
    }
}

fn from_crypto(e: crate::crypto::CryptoError) -> EstablishError {
    EstablishError::Protocol(format!("密码处理失败：{e}"))
}

fn from_relay(e: RelayError) -> EstablishError {
    match e {
        RelayError::Closed { code, .. } => EstablishError::RelayClosed { code },
        RelayError::Connect(m) => EstablishError::Connect(m),
        RelayError::Protocol(m) => EstablishError::Protocol(m),
        RelayError::Io(m) => EstablishError::Connect(m),
    }
}

fn from_hs(e: HsError) -> EstablishError {
    match e {
        HsError::Protocol(m) => EstablishError::Protocol(m.to_string()),
        HsError::KeyMismatch => EstablishError::SignalKeyMismatch,
        HsError::BadPassword | HsError::BadConfirm => EstablishError::BadPassword,
        HsError::BadSignature => EstablishError::BadSignature,
        HsError::Version { peer } => EstablishError::Version { peer },
        HsError::Crypto => EstablishError::Protocol("密码学运算失败".into()),
    }
}

/// 会话句柄：握手完成后得到。
pub struct SessionHandle {
    /// 观察关闭原因（含中继关闭码）、主动中止。
    pub mux: MuxHandle,
    /// 对端经签名认证的公钥（主控端据此记住被控端；被控端可用于显示）
    pub peer_public_key: [u8; 32],
    /// 协商的协议版本
    pub proto_ver: u32,
    /// 使用的密码类别：0 临时密码，1 固定密码
    pub password_kind: u32,
}

/// 主控端输入的密码。
pub enum PasswordInput {
    /// 用户输入的原文。会在 `spawn_blocking` 里做 Argon2id（约 0.1–0.8 秒），用完清零。
    Plain(String),
    /// 已派生好的 pw_key（重连时复用缓存，避免重复计算）。`kind`：0 临时 / 1 固定。
    Derived { key: [u8; 32], kind: u32 },
}

impl PasswordInput {
    /// 派生并返回可缓存的形式。类别由格式判断（见 `password_kind_of`）。
    /// 派生失败返回错误（握手失败），不会用全零之类的密钥继续。
    pub async fn derive(self, host_code: &str) -> Result<PasswordInput, EstablishError> {
        match self {
            PasswordInput::Plain(pw) => {
                let kind = password_kind_of(&pw);
                let key = derive_pw_key_async(pw, host_code.to_string())
                    .await
                    .map_err(from_crypto)?;
                Ok(PasswordInput::Derived { key, kind })
            }
            d => Ok(d),
        }
    }
}

pub struct ControllerParams {
    /// 信令 `connect.ok` 的 `relay_url`、`ticket`、`session_id`
    pub relay_url: String,
    pub ticket: String,
    pub session_id: String,
    pub identity: Arc<Identity>,
    pub controller_code: String,
    pub host_code: String,
    /// 信令 `connect.ok.peer.public_key`（已解码的 32 字节）
    pub host_public_key: Vec<u8>,
    /// 信令 `connect.ok.peer.platform`
    pub host_platform: String,
    pub password: PasswordInput,
    /// 本地记住的该被控端公钥；握手通过后若不一致返回 `PeerKeyChanged`（除非 `accept_key_change`）
    pub known_host_key: Option<Vec<u8>>,
    pub accept_key_change: bool,
    pub net: NetOptions,
}

pub struct HostParams {
    /// 信令 `connect.incoming` 的 `relay_url`、`ticket`、`session_id`
    pub relay_url: String,
    pub ticket: String,
    pub session_id: String,
    pub identity: Arc<Identity>,
    pub host_code: String,
    /// 信令 `connect.incoming.from.device_code` / `.public_key`（已解码）/ `.platform`
    pub controller_code: String,
    pub controller_public_key: Vec<u8>,
    pub controller_platform: String,
    pub passwords: Arc<dyn HostPasswords>,
    pub net: NetOptions,
}

fn encode_hs(body: HsBody) -> Vec<u8> {
    let h = Handshake { body: Some(body) };
    let mut rec = Vec::with_capacity(1 + h.encoded_len());
    rec.push(REC_HANDSHAKE);
    h.encode(&mut rec).ok();
    rec
}

fn decode_hs(rec: &[u8]) -> Result<HsBody, EstablishError> {
    if rec.first() != Some(&REC_HANDSHAKE) {
        return Err(EstablishError::Protocol("握手阶段收到非握手记录".into()));
    }
    let h = Handshake::decode(&rec[1..])
        .map_err(|e| EstablishError::Protocol(format!("握手消息解码失败: {e}")))?;
    h.body
        .ok_or_else(|| EstablishError::Protocol("握手消息为空".into()))
}

async fn next_record(sock: &mut RelaySocket) -> Result<Vec<u8>, EstablishError> {
    match sock.next().await {
        Some(Ok(r)) => Ok(r),
        Some(Err(e)) => Err(from_relay(e)),
        None => Err(EstablishError::RelayClosed { code: None }),
    }
}

fn peer_info(code: &str, platform: &str, est: &Established) -> PeerInfo {
    PeerInfo {
        device_code: code.to_string(),
        platform: platform.to_string(),
        public_key: est.peer_public_key.to_vec(),
        proto_ver: est.proto_ver,
    }
}

fn start_mux(
    sock: RelaySocket,
    est: Established,
    peer: PeerInfo,
    controller_side: bool,
) -> (Link, SessionHandle) {
    // 栈上的副本用 Zeroizing 包装，离开作用域时清零（审查 L8）
    let (send_key, recv_key) = if controller_side {
        (Zeroizing::new(est.keys.c2h), Zeroizing::new(est.keys.h2c))
    } else {
        (Zeroizing::new(est.keys.h2c), Zeroizing::new(est.keys.c2h))
    };
    let (sink, stream) = sock.split();
    let (link, mux) = spawn_mux(
        sink,
        stream,
        Sealer::new(&send_key),
        Sealer::new(&recv_key),
        peer,
    );
    let handle = SessionHandle {
        mux,
        peer_public_key: est.peer_public_key,
        proto_ver: est.proto_ver,
        password_kind: est.password_kind,
    };
    (link, handle)
}

/// 主控端：连中继 -> 握手 -> 加密 mux。只返回 `Link`。
pub async fn establish_controller(params: ControllerParams) -> Result<Link, EstablishError> {
    establish_controller_ex(params).await.map(|(l, _)| l)
}

/// 主控端：同 `establish_controller`，另返回会话句柄（关闭原因、认证过的对端公钥等）。
pub async fn establish_controller_ex(
    params: ControllerParams,
) -> Result<(Link, SessionHandle), EstablishError> {
    // 公钥变化要在发出任何握手消息之前判断（审查 L1）：信令下发的被控端公钥与本地记住的不一致，
    // 且用户没有确认接受时，直接报告，不进入 PAKE（否则恶意信令可以拿自己的公钥换取在线猜密码的机会）
    if let Some(known) = &params.known_host_key {
        if known.as_slice() != params.host_public_key.as_slice() && !params.accept_key_change {
            return Err(EstablishError::PeerKeyChanged {
                known: known.clone(),
                actual: params.host_public_key.clone(),
            });
        }
    }

    // 先派生密码（耗时），再连中继：票据只有 30 秒有效
    let (pw_key, kind) = match params.password {
        PasswordInput::Derived { key, kind } => (Zeroizing::new(key), kind),
        PasswordInput::Plain(pw) => {
            let kind = password_kind_of(&pw);
            (
                Zeroizing::new(
                    derive_pw_key_async(pw, params.host_code.clone())
                        .await
                        .map_err(from_crypto)?,
                ),
                kind,
            )
        }
    };

    let mut sock = RelaySocket::connect(&params.relay_url, &params.ticket, &params.net)
        .await
        .map_err(from_relay)?;

    let ctx = ControllerCtx {
        proto_ver: PROTO_VER,
        session_id: params.session_id.clone(),
        controller_code: params.controller_code.clone(),
        host_code: params.host_code.clone(),
        identity: params.identity.clone(),
        pw_key,
        password_kind: kind,
        expected_host_pubkey: params.host_public_key.clone(),
    };

    let hs = async {
        // 步骤 1
        let (st1, init) = ControllerStart::begin(ctx);
        sock.send(encode_hs(HsBody::Init(init)))
            .await
            .map_err(from_relay)?;
        // 步骤 3
        let resp = match decode_hs(&next_record(&mut sock).await?)? {
            HsBody::Resp(r) => r,
            _ => return Err(EstablishError::Protocol("期望 PakeResp".into())),
        };
        let (st2, confirm) = st1.on_resp(&resp).map_err(from_hs)?;
        sock.send(encode_hs(HsBody::Confirm(confirm)))
            .await
            .map_err(from_relay)?;
        // 步骤 5：被控端在步骤 4 校验失败会直接关闭连接，不回任何内容
        let rec = match next_record(&mut sock).await {
            Ok(r) => r,
            Err(EstablishError::RelayClosed { code })
                if code.is_none() || code == Some(CLOSE_PEER_GONE) || code == Some(1000) =>
            {
                return Err(EstablishError::BadPassword);
            }
            Err(e) => return Err(e),
        };
        let confirm = match decode_hs(&rec)? {
            HsBody::Confirm(c) => c,
            _ => return Err(EstablishError::Protocol("期望 PakeConfirm".into())),
        };
        st2.on_confirm(&confirm).map_err(from_hs)
    };
    let est = match tokio::time::timeout(HANDSHAKE_TIMEOUT, hs).await {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(EstablishError::Timeout),
    };

    // 公钥变化检查：握手已认证了对端，这里的 actual 是可信的
    if let Some(known) = &params.known_host_key {
        if known.as_slice() != est.peer_public_key.as_slice() && !params.accept_key_change {
            return Err(EstablishError::PeerKeyChanged {
                known: known.clone(),
                actual: est.peer_public_key.to_vec(),
            });
        }
    }

    let peer = peer_info(&params.host_code, &params.host_platform, &est);
    Ok(start_mux(sock, est, peer, true))
}

/// 被控端：连中继 -> 握手 -> 加密 mux。密码错误时返回 `BadPassword`（上层记一次失败并上报 `auth_failed`）。
pub async fn establish_host(params: HostParams) -> Result<(Link, SessionHandle), EstablishError> {
    let mut sock = RelaySocket::connect(&params.relay_url, &params.ticket, &params.net)
        .await
        .map_err(from_relay)?;

    let ctx = HostCtx {
        session_id: params.session_id.clone(),
        controller_code: params.controller_code.clone(),
        host_code: params.host_code.clone(),
        identity: params.identity.clone(),
        passwords: params.passwords.clone(),
        expected_controller_pubkey: params.controller_public_key.clone(),
    };

    // 等主控端的 PakeInit（配对可能要等一会儿），之后的握手限时 10 秒
    let init = match tokio::time::timeout(HOST_WAIT_INIT_TIMEOUT, next_record(&mut sock)).await {
        Ok(r) => match decode_hs(&r?)? {
            HsBody::Init(i) => i,
            _ => return Err(EstablishError::Protocol("期望 PakeInit".into())),
        },
        Err(_) => return Err(EstablishError::Timeout),
    };

    let hs = async {
        // 步骤 2
        let (st, resp) = HostStart::on_init(&ctx, &init).map_err(from_hs)?;
        sock.send(encode_hs(HsBody::Resp(resp)))
            .await
            .map_err(from_relay)?;
        // 步骤 4
        let confirm = match decode_hs(&next_record(&mut sock).await?)? {
            HsBody::Confirm(c) => c,
            _ => return Err(EstablishError::Protocol("期望 PakeConfirm".into())),
        };
        let (est, reply) = st.on_confirm(&confirm).map_err(from_hs)?;
        sock.send(encode_hs(HsBody::Confirm(reply)))
            .await
            .map_err(from_relay)?;
        Ok(est)
    };
    let est = match tokio::time::timeout(HANDSHAKE_TIMEOUT, hs).await {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            // 失败 = 直接关闭连接，不回任何内容（密码错误时主控端据此得知）
            drop(sock);
            return Err(e);
        }
        Err(_) => return Err(EstablishError::Timeout),
    };
    let peer = peer_info(&params.controller_code, &params.controller_platform, &est);
    Ok(start_mux(sock, est, peer, false))
}

// ---------------------------------------------------------------- 测试用假中继

/// 进程内的假中继：按 ticket 配对两端并原样转发。用于集成测试和示例，不用于生产。
///
/// ticket 约定为 `"<session_id>:<c|h>"`（假中继不校验签名）。先到的一端的消息会被缓存，直到对端到达。
#[doc(hidden)]
pub mod testing {
    use std::collections::HashMap;
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, Mutex};
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::Message;

    type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// 假中继的行为开关
    #[derive(Default, Clone)]
    pub struct FakeRelayOptions {
        /// 把 ticket 以 `bad` 开头的连接立即以 4001 关闭
        pub reject_bad_tickets: bool,
    }

    /// 启动假中继，返回 `ws://127.0.0.1:port`。
    pub async fn spawn_fake_relay() -> String {
        spawn_fake_relay_with(FakeRelayOptions {
            reject_bad_tickets: true,
        })
        .await
    }

    #[allow(clippy::result_large_err)]
    pub async fn spawn_fake_relay_with(opts: FakeRelayOptions) -> String {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(_) => return String::new(),
        };
        let addr = listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_default();
        let waiting: Arc<Mutex<HashMap<String, (String, Ws)>>> = Arc::default();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    break;
                };
                let waiting = waiting.clone();
                let opts = opts.clone();
                tokio::spawn(async move {
                    let mut ticket = String::new();
                    let cb = |req: &Request, resp: Response| {
                        if let Some(q) = req.uri().query() {
                            for kv in q.split('&') {
                                if let Some(v) = kv.strip_prefix("ticket=") {
                                    ticket = v.replace("%3A", ":");
                                }
                            }
                        }
                        Ok(resp)
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, cb).await else {
                        return;
                    };
                    if opts.reject_bad_tickets
                        && (ticket.starts_with("bad") || !ticket.contains(':'))
                    {
                        let _ = ws
                            .close(Some(CloseFrame {
                                code: CloseCode::from(4001),
                                reason: "ticket".into(),
                            }))
                            .await;
                        return;
                    }
                    let (sid, role) = match ticket.rsplit_once(':') {
                        Some((s, r)) => (s.to_string(), r.to_string()),
                        None => (ticket.clone(), String::new()),
                    };
                    let mut mine = Some(ws);
                    let peer = {
                        let mut w = waiting.lock().await;
                        match w.remove(&sid) {
                            Some((r, other)) if r != role => Some(other),
                            Some(_) => {
                                if let Some(mut ws) = mine.take() {
                                    let _ = ws
                                        .close(Some(CloseFrame {
                                            code: CloseCode::from(4001),
                                            reason: "role".into(),
                                        }))
                                        .await;
                                }
                                return;
                            }
                            None => {
                                if let Some(ws) = mine.take() {
                                    w.insert(sid.clone(), (role, ws));
                                }
                                None
                            }
                        }
                    };
                    if let (Some(other), Some(ws)) = (peer, mine) {
                        pipe(ws, other).await;
                    }
                });
            }
        });
        format!("ws://{addr}")
    }

    /// 双向转发；任一端结束则以 4003 关闭另一端。
    async fn pipe(a: Ws, b: Ws) {
        let (mut a_tx, mut a_rx) = a.split();
        let (mut b_tx, mut b_rx) = b.split();
        let (done_tx, mut done_rx) = mpsc::channel::<u8>(2);
        let d1 = done_tx.clone();
        let t1 = tokio::spawn(async move {
            while let Some(Ok(m)) = a_rx.next().await {
                match m {
                    Message::Binary(_) => {
                        if b_tx.send(m).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            let _ = b_tx
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4003),
                    reason: "peer gone".into(),
                })))
                .await;
            let _ = d1.send(1).await;
        });
        let t2 = tokio::spawn(async move {
            while let Some(Ok(m)) = b_rx.next().await {
                match m {
                    Message::Binary(_) => {
                        if a_tx.send(m).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            let _ = a_tx
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4003),
                    reason: "peer gone".into(),
                })))
                .await;
            let _ = done_tx.send(2).await;
        });
        let _ = done_rx.recv().await;
        // 给另一方向一点时间把 Close 发出去
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        t1.abort();
        t2.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::crypto::derive_pw_key;
    use crate::link::Link;
    use rterm_proto::pb;

    struct Pw {
        temp: Option<[u8; 32]>,
        fixed: Option<[u8; 32]>,
    }
    impl HostPasswords for Pw {
        fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
            if kind == 0 {
                self.temp
            } else {
                self.fixed
            }
        }
    }

    const C_CODE: &str = "111111111";
    const H_CODE: &str = "222222222";

    struct Fixture {
        relay: String,
        c_id: Arc<Identity>,
        h_id: Arc<Identity>,
        sid: String,
    }

    async fn fixture() -> Fixture {
        Fixture {
            relay: spawn_fake_relay().await,
            c_id: Arc::new(Identity::generate()),
            h_id: Arc::new(Identity::generate()),
            sid: format!("S{}", rand::random::<u32>()),
        }
    }

    impl Fixture {
        fn controller(&self, pw: &str, known: Option<Vec<u8>>) -> ControllerParams {
            ControllerParams {
                relay_url: self.relay.clone(),
                ticket: format!("{}:c", self.sid),
                session_id: self.sid.clone(),
                identity: self.c_id.clone(),
                controller_code: C_CODE.into(),
                host_code: H_CODE.into(),
                host_public_key: self.h_id.public_key().to_vec(),
                host_platform: "windows".into(),
                password: PasswordInput::Plain(pw.into()),
                known_host_key: known,
                accept_key_change: false,
                net: NetOptions {
                    proxy: Some(String::new()),
                    use_system_certs: false,
                },
            }
        }
        fn host(&self, passwords: Pw) -> HostParams {
            HostParams {
                relay_url: self.relay.clone(),
                ticket: format!("{}:h", self.sid),
                session_id: self.sid.clone(),
                identity: self.h_id.clone(),
                host_code: H_CODE.into(),
                controller_code: C_CODE.into(),
                controller_public_key: self.c_id.public_key().to_vec(),
                controller_platform: "macos".into(),
                passwords: Arc::new(passwords),
                net: NetOptions {
                    proxy: Some(String::new()),
                    use_system_certs: false,
                },
            }
        }
    }

    fn ping(ts: u64) -> pb::Frame {
        pb::Frame {
            channel: 0,
            body: Some(pb::frame::Body::Ping(pb::Ping { ts })),
        }
    }

    async fn recv_one(link: &mut Link) -> pb::Frame {
        tokio::time::timeout(Duration::from_secs(5), link.rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    #[test]
    fn endpoint_building() {
        assert_eq!(
            relay_endpoint("wss://r.example.com", "a.b").unwrap(),
            "wss://r.example.com/v1/relay?ticket=a.b"
        );
        assert_eq!(
            relay_endpoint("wss://r.example.com/", "t").unwrap(),
            "wss://r.example.com/v1/relay?ticket=t"
        );
        assert_eq!(
            relay_endpoint("wss://r.example.com/v1/relay", "t").unwrap(),
            "wss://r.example.com/v1/relay?ticket=t"
        );
        assert_eq!(
            relay_endpoint("ws://h:1/n1", "t").unwrap(),
            "ws://h:1/n1/v1/relay?ticket=t"
        );
        assert!(relay_endpoint("not a url", "t").is_err());
    }

    #[tokio::test]
    async fn correct_password_full_session_both_directions() {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let c = tokio::spawn(establish_controller_ex(f.controller("abc23456", None)));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        let (mut c_link, c_handle) = c.await.unwrap().unwrap();
        let (mut h_link, h_handle) = h.await.unwrap().unwrap();

        assert_eq!(c_handle.peer_public_key, f.h_id.public_key());
        assert_eq!(h_handle.peer_public_key, f.c_id.public_key());
        assert_eq!(c_link.peer.device_code, H_CODE);
        assert_eq!(h_link.peer.device_code, C_CODE);
        assert_eq!(c_link.peer.platform, "windows");
        assert_eq!(h_handle.password_kind, 0);

        // 双向收发，含批量通道
        c_link.tx.send(ping(1)).await.unwrap();
        assert!(
            matches!(recv_one(&mut h_link).await.body, Some(pb::frame::Body::Ping(p)) if p.ts == 1)
        );
        h_link
            .tx
            .send(pb::Frame {
                channel: 3,
                body: Some(pb::frame::Body::TermOutput(pb::TermOutput {
                    seq: 7,
                    data: b"hello".to_vec(),
                })),
            })
            .await
            .unwrap();
        let got = recv_one(&mut c_link).await;
        assert_eq!(got.channel, 3);
        assert!(
            matches!(got.body, Some(pb::frame::Body::TermOutput(o)) if o.seq == 7 && o.data == b"hello")
        );
        let chunk = pb::Frame {
            channel: 0,
            body: Some(pb::frame::Body::FileChunk(pb::FileChunk {
                file_id: 9,
                offset: 0,
                data: vec![0xAB; 32 * 1024],
            })),
        };
        c_link.tx.send_bulk(chunk).await.unwrap();
        assert!(
            matches!(recv_one(&mut h_link).await.body, Some(pb::frame::Body::FileChunk(c)) if c.data.len() == 32 * 1024)
        );
    }

    #[tokio::test]
    async fn fixed_password_kind() {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let fixed = derive_pw_key("a long fixed password!", H_CODE).expect("kdf");
        let c = tokio::spawn(establish_controller_ex(
            f.controller("a long fixed password!", None),
        ));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: Some(fixed),
        })));
        let (_cl, ch) = c.await.unwrap().unwrap();
        let (_hl, hh) = h.await.unwrap().unwrap();
        assert_eq!(ch.password_kind, 1);
        assert_eq!(hh.password_kind, 1);
    }

    #[tokio::test]
    async fn wrong_password_both_sides_get_explicit_error() {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let c = tokio::spawn(establish_controller(f.controller("abc23457", None)));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        let c_err = c.await.unwrap().err().unwrap();
        let h_err = h.await.unwrap().err().unwrap();
        assert!(
            matches!(h_err, EstablishError::BadPassword),
            "被控端: {h_err:?}"
        );
        assert!(
            matches!(c_err, EstablishError::BadPassword),
            "主控端: {c_err:?}"
        );
        assert!(!c_err.is_retryable());
    }

    #[tokio::test]
    async fn fixed_password_requested_but_not_set() {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let c = tokio::spawn(establish_controller(
            f.controller("some fixed password", None),
        ));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        assert!(matches!(
            h.await.unwrap().err().unwrap(),
            EstablishError::BadPassword
        ));
        assert!(matches!(
            c.await.unwrap().err().unwrap(),
            EstablishError::BadPassword
        ));
    }

    #[tokio::test]
    async fn peer_key_change_detected_unless_accepted() {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let old_key = Identity::generate().public_key().to_vec();

        let c = tokio::spawn(establish_controller(
            f.controller("abc23456", Some(old_key.clone())),
        ));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        match c.await.unwrap() {
            Err(EstablishError::PeerKeyChanged { known, actual }) => {
                assert_eq!(known, old_key);
                assert_eq!(actual, f.h_id.public_key().to_vec());
            }
            other => panic!("应报公钥变化，实际 {:?}", other.err()),
        }
        let _ = h.await;

        // 用户确认后接受
        let f2 = Fixture {
            sid: format!("S2{}", rand::random::<u32>()),
            relay: f.relay.clone(),
            c_id: f.c_id.clone(),
            h_id: f.h_id.clone(),
        };
        let mut p = f2.controller("abc23456", Some(old_key));
        p.accept_key_change = true;
        let c = tokio::spawn(establish_controller(p));
        let h = tokio::spawn(establish_host(f2.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        assert!(c.await.unwrap().is_ok());
        assert!(h.await.unwrap().is_ok());

        // 公钥相同则不告警
        let f3 = Fixture {
            sid: format!("S3{}", rand::random::<u32>()),
            relay: f.relay.clone(),
            c_id: f.c_id.clone(),
            h_id: f.h_id.clone(),
        };
        let c = tokio::spawn(establish_controller(
            f3.controller("abc23456", Some(f.h_id.public_key().to_vec())),
        ));
        let h = tokio::spawn(establish_host(f3.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        assert!(c.await.unwrap().is_ok());
        assert!(h.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn signaling_key_mismatch_is_detected() {
        // 信令告知主控端的被控端公钥与实际握手公钥不同 -> 主控端在步骤 3 失败
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let mut p = f.controller("abc23456", None);
        p.host_public_key = Identity::generate().public_key().to_vec();
        let c = tokio::spawn(establish_controller(p));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        assert!(matches!(
            c.await.unwrap().err().unwrap(),
            EstablishError::SignalKeyMismatch
        ));
        let _ = h.await;
    }

    /// 审查 L1：信令下发的被控端公钥与本地记住的不一致时，在连中继、发 PakeInit 之前就返回 `PeerKeyChanged`，
    /// 不能先完成 PAKE 再报告（恶意信令可借此对每次连接获得一次在线猜密码的机会）。
    #[tokio::test]
    async fn key_change_is_reported_before_any_handshake_traffic() {
        let f = fixture().await;
        let other = Identity::generate().public_key().to_vec();
        let mut p = f.controller("abc23456", None);
        // 用无效票据：只要真的去连了中继就会得到 RelayClosed(4001)，而不是 PeerKeyChanged
        p.ticket = "bad-ticket".into();
        p.known_host_key = Some(other.clone());
        match establish_controller(p).await {
            Err(EstablishError::PeerKeyChanged { known, actual }) => {
                assert_eq!(known, other);
                assert_eq!(actual, f.h_id.public_key().to_vec());
            }
            other => panic!("应直接返回 PeerKeyChanged，实际 {:?}", other.err()),
        }
        // 用户确认接受变化后，才会继续去连中继
        let mut p = f.controller("abc23456", None);
        p.ticket = "bad-ticket".into();
        p.known_host_key = Some(other);
        p.accept_key_change = true;
        assert!(matches!(
            establish_controller(p).await,
            Err(EstablishError::RelayClosed { code: Some(4001) })
        ));
        // 一致时同样不受影响
        let mut p = f.controller("abc23456", None);
        p.ticket = "bad-ticket".into();
        p.known_host_key = Some(f.h_id.public_key().to_vec());
        assert!(matches!(
            establish_controller(p).await,
            Err(EstablishError::RelayClosed { code: Some(4001) })
        ));
    }

    #[tokio::test]
    async fn bad_ticket_reports_relay_close_code() {
        let f = fixture().await;
        let mut p = f.controller("abc23456", None);
        p.ticket = "bad-ticket".into();
        match establish_controller(p).await {
            Err(EstablishError::RelayClosed { code: Some(4001) }) => {}
            other => panic!("应为 4001，实际 {:?}", other.err()),
        }
    }

    #[tokio::test]
    async fn connect_failure_is_retryable_error() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let f = fixture().await;
        let mut p = f.controller("abc23456", None);
        p.relay_url = format!("ws://127.0.0.1:{port}");
        let e = establish_controller(p).await.err().unwrap();
        assert!(matches!(e, EstablishError::Connect(_)), "{e:?}");
        assert!(e.is_retryable());
    }

    #[tokio::test]
    async fn host_times_out_waiting_for_peer_is_not_tested_here_but_peer_close_after_session_is_reported(
    ) {
        let f = fixture().await;
        let temp = derive_pw_key("abc23456", H_CODE).expect("kdf");
        let c = tokio::spawn(establish_controller_ex(f.controller("abc23456", None)));
        let h = tokio::spawn(establish_host(f.host(Pw {
            temp: Some(temp),
            fixed: None,
        })));
        let (c_link, mut c_handle) = c.await.unwrap().unwrap();
        let (mut h_link, _h_handle) = h.await.unwrap().unwrap();
        // 主控端丢弃 Link -> 被控端 rx 结束；
        drop(c_link);
        assert!(
            tokio::time::timeout(Duration::from_secs(5), h_link.rx.recv())
                .await
                .unwrap()
                .is_none()
        );
        let info = tokio::time::timeout(Duration::from_secs(5), c_handle.mux.wait_closed())
            .await
            .unwrap();
        assert!(info.local);
    }

    #[tokio::test]
    async fn text_message_from_relay_is_protocol_error() {
        use futures_util::SinkExt;
        use tokio::net::TcpListener;
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            ws.send(Message::Text("hi".into())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
        });
        let mut sock = RelaySocket::connect(
            &format!("ws://{addr}"),
            "t",
            &NetOptions {
                proxy: Some(String::new()),
                use_system_certs: false,
            },
        )
        .await
        .unwrap();
        match sock.next().await {
            Some(Err(RelayError::Protocol(_))) => {}
            other => panic!("{other:?}"),
        }
        assert!(sock.next().await.is_none());
    }
}
