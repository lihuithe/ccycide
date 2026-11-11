//! 主控端会话任务（《开发指南.md》7.0.1 的"任务 + 有界通道"模式）。
//!
//! 一台被控端一个会话任务，独占该会话的全部可变状态：当前链路、终端表、待回复的请求、上传任务的收件箱。
//! 外部只通过 [`Cmd`]（有界通道）与它交互；它通过 `events`（有界通道）向界面投递 [`CoreEvent`]。
//!
//! 生命周期：`Ready` →（链路意外断开）→ `Reconnecting`（退避重试，期间用户操作返回"尚未连接"）→
//! 重连成功后 `TermList` + 对每个已打开的终端 `TermAttach{last_seq}` → `Ready`；
//! 不可重试的错误（密码错误等）或用户断开/对方 `Bye` → `Closed(原因)`。
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rterm_proto::pb;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant as TokioInstant;

use super::connect::{establish, frame, lost_reason, Conn, ConnectSpec, Connector, Resync};
use super::term::{modes_from_pb, AckBoard, TermOpenOptions, TermSize, TermTable};
use super::upload::{self, Prepared, UploadJob, UploadMsg, FILE_ID_BASE, MAX_CONCURRENT};
use super::{CloseReason, ControllerTiming, CtlError};
use crate::events::{CoreEvent, FileId, SessionId, SessionState, TermId};

pub(crate) type Reply<T> = oneshot::Sender<Result<T, CtlError>>;

/// 发给会话任务的命令。
pub(crate) enum Cmd {
    OpenTerm {
        opts: TermOpenOptions,
        reply: Reply<TermId>,
    },
    ListTerms {
        reply: Reply<Vec<pb::TermInfo>>,
    },
    AttachTerm {
        term: TermId,
        size: TermSize,
        /// 界面已渲染到的流偏移；None = 沿用控制器自己已交付的偏移
        from_seq: Option<u64>,
        reply: Reply<()>,
    },
    Input {
        term: TermId,
        data: Vec<u8>,
        reply: Reply<()>,
    },
    Submit {
        term: TermId,
        text: String,
        attachments: Vec<FileId>,
        press_enter: bool,
        reply: Reply<u64>,
    },
    Resize {
        term: TermId,
        size: TermSize,
        reply: Reply<()>,
    },
    CloseTerm {
        term: TermId,
        reply: Reply<()>,
    },
    Action {
        term: TermId,
        action_id: String,
        args: HashMap<String, String>,
        reply: Reply<u64>,
    },
    CommandList {
        term: TermId,
        reply: Reply<()>,
    },
    Upload {
        prepared: Prepared,
        reply: Reply<FileId>,
    },
    CancelUpload {
        file: FileId,
    },
    ReconnectNow,
    Disconnect {
        reply: oneshot::Sender<()>,
    },
}

/// 被控端的能力快照（`HelloAck`）。
#[derive(Debug, Clone, Default)]
pub struct HostSnapshot {
    pub info: pb::HostInfo,
    pub features: HashSet<String>,
    pub app_version: String,
    pub proto_ver: u32,
}

/// 会话任务与外部句柄共享的只读观察数据。
pub(crate) struct Shared {
    pub state: watch::Sender<SessionState>,
    pub host: Mutex<Option<HostSnapshot>>,
    pub close_reason: Mutex<Option<CloseReason>>,
    pub peer_key: Mutex<Vec<u8>>,
    /// 最近一次 Ping/Pong 往返延迟（毫秒）；`u64::MAX` = 尚无测量
    pub rtt_ms: AtomicU64,
    /// 终端打开时被控端给的 `(title, shell)`，界面显示标签用
    pub term_meta: Mutex<HashMap<TermId, (String, String)>>,
}

enum Pending {
    Open {
        size: TermSize,
        reply: Reply<TermId>,
        at: Instant,
    },
    Attach {
        size: TermSize,
        reply: Option<Reply<()>>,
        /// 是重连后自动恢复发出的
        resync: bool,
        term: TermId,
        at: Instant,
    },
}

impl Pending {
    fn at(&self) -> Instant {
        match self {
            Pending::Open { at, .. } | Pending::Attach { at, .. } => *at,
        }
    }

    fn fail(self, e: CtlError) {
        match self {
            Pending::Open { reply, .. } => {
                let _ = reply.send(Err(e));
            }
            Pending::Attach { reply: Some(r), .. } => {
                let _ = r.send(Err(e));
            }
            Pending::Attach { .. } => {}
        }
    }
}

enum ListWaiter {
    User(Reply<Vec<pb::TermInfo>>),
    Resync,
}

/// 链路结束的去向。
enum Exit {
    /// 意外断开，附原因文字，去重连
    Lost(String),
    /// 会话结束
    Close(CloseReason),
}

/// 离线时处理一条命令的结果。
enum Off {
    Continue,
    Wake,
    Close,
}

/// 请求在被控端无响应时，等待登记保留多久后清理。
const PENDING_TTL: Duration = Duration::from_secs(60);
/// 被控端回 `TERM_BUSY` 时给界面的提示。
const TERM_BUSY_TEXT: &str = "该终端正被其他设备使用";
const CMD_QUEUE: usize = 64;
const UPLOAD_INBOX: usize = 64;

pub(crate) fn cmd_channel() -> (mpsc::Sender<Cmd>, mpsc::Receiver<Cmd>) {
    mpsc::channel(CMD_QUEUE)
}

pub(crate) struct Actor {
    pub id: SessionId,
    pub connector: Arc<dyn Connector>,
    pub spec: ConnectSpec,
    pub timing: ControllerTiming,
    pub app_version: String,
    pub events: mpsc::Sender<CoreEvent>,
    pub cmd_rx: mpsc::Receiver<Cmd>,
    pub acks: Arc<AckBoard>,
    pub shared: Arc<Shared>,
    consumer_gone: bool,
    terms: TermTable,
    next_req: u64,
    next_msg: u64,
    next_file: u64,
    pending: HashMap<u64, Pending>,
    list_waiters: Vec<ListWaiter>,
    uploads: HashMap<FileId, mpsc::Sender<UploadMsg>>,
    /// 本连接内已上传完成的文件（被控端的记录也是按会话的，重连后作废）
    done_files: HashSet<FileId>,
    host_features: HashSet<String>,
    /// 离线期间用户关闭的终端，重连后补发 `TermClose`
    pending_closes: Vec<TermId>,
}

impl Actor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: SessionId,
        connector: Arc<dyn Connector>,
        spec: ConnectSpec,
        timing: ControllerTiming,
        app_version: String,
        events: mpsc::Sender<CoreEvent>,
        cmd_rx: mpsc::Receiver<Cmd>,
        acks: Arc<AckBoard>,
        shared: Arc<Shared>,
    ) -> Self {
        Self {
            id,
            connector,
            spec,
            timing,
            app_version,
            events,
            cmd_rx,
            acks,
            shared,
            consumer_gone: false,
            terms: TermTable::default(),
            next_req: 1,
            next_msg: 1,
            next_file: FILE_ID_BASE,
            pending: HashMap::new(),
            list_waiters: Vec::new(),
            uploads: HashMap::new(),
            done_files: HashSet::new(),
            host_features: HashSet::new(),
            pending_closes: Vec::new(),
        }
    }

    // ------------------------------------------------------------ 事件

    pub async fn emit(&mut self, ev: CoreEvent) {
        if self.events.send(ev).await.is_err() {
            self.consumer_gone = true;
        }
    }

    pub async fn set_state(&mut self, s: SessionState) {
        if *self.shared.state.borrow() == s {
            return;
        }
        self.shared.state.send_replace(s.clone());
        let session = self.id.clone();
        self.emit(CoreEvent::SessionState { session, state: s })
            .await;
    }

    async fn notice_error(&mut self, term: &str, code: &str, message: &str) {
        let ev = CoreEvent::AppNotice {
            session: self.id.clone(),
            term: term.to_string(),
            notice: pb::AppNotice {
                kind: "error".into(),
                title: code.into(),
                text: message.into(),
                ..Default::default()
            },
        };
        self.emit(ev).await;
    }

    // ------------------------------------------------------------ 主流程

    /// 运行直到会话关闭。`conn` 是已完成 Hello 的首条连接（`begin_connection` 已调用）。
    pub async fn run(mut self, first: Conn) {
        let mut conn = first;
        let reason = loop {
            match self.run_connected(conn).await {
                Exit::Close(r) => break r,
                Exit::Lost(why) => {
                    tracing::info!(session = %self.id, "链路断开: {why}");
                    self.on_lost();
                    self.set_state(SessionState::Reconnecting).await;
                    match self.reconnect().await {
                        Ok(c) => conn = c,
                        Err(r) => break r,
                    }
                }
            }
        };
        self.on_lost();
        if let Ok(mut g) = self.shared.close_reason.lock() {
            *g = Some(reason.clone());
        }
        self.set_state(SessionState::Closed(reason.text())).await;
    }

    /// 链路断开后的清理：待回复的请求失败，上传任务得知连接中断，通道号作废。
    fn on_lost(&mut self) {
        for (_, p) in self.pending.drain() {
            p.fail(CtlError::ConnectionLost);
        }
        for w in self.list_waiters.drain(..) {
            if let ListWaiter::User(r) = w {
                let _ = r.send(Err(CtlError::ConnectionLost));
            }
        }
        // 丢弃收件箱发送端 = 通知上传任务连接中断
        self.uploads.clear();
        self.done_files.clear();
        self.terms.drop_channels();
    }

    async fn run_connected(&mut self, mut conn: Conn) -> Exit {
        let tick_every = (self.timing.ping_interval / 3)
            .clamp(Duration::from_millis(20), Duration::from_secs(1));
        let mut tick = tokio::time::interval(tick_every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if self.consumer_gone {
                self.send_bye(&mut conn, "client exit").await;
                return Exit::Close(CloseReason::ConsumerGone);
            }
            if conn.dead {
                if let Some(c) = &conn.close {
                    c.abort();
                }
                return Exit::Lost("发送失败".into());
            }
            tokio::select! {
                cmd = self.cmd_rx.recv() => match cmd {
                    None => {
                        // 所有句柄都已丢弃
                        self.send_bye(&mut conn, "client exit").await;
                        return Exit::Close(CloseReason::ConsumerGone);
                    }
                    Some(c) => {
                        if let Some(r) = self.on_cmd(&mut conn, c).await {
                            return Exit::Close(r);
                        }
                    }
                },
                f = conn.rx.recv() => match f {
                    None => return Exit::Lost(lost_reason(conn.close.as_ref()).await),
                    Some(f) => {
                        conn.last_rx = TokioInstant::now();
                        if let Some(r) = self.on_frame(&mut conn, f).await {
                            return Exit::Close(r);
                        }
                    }
                },
                _ = self.acks.notify.notified() => self.flush_acks(&mut conn).await,
                _ = tick.tick() => {
                    if let Some(x) = self.on_tick(&mut conn).await {
                        return x;
                    }
                }
            }
        }
    }

    async fn send_bye(&self, conn: &mut Conn, reason: &str) {
        let f = frame(
            0,
            pb::frame::Body::Bye(pb::Bye {
                reason: reason.into(),
            }),
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), conn.tx.send(f)).await;
    }

    /// 向被控端发一帧；失败或超时视为连接已死。
    async fn send(&self, conn: &mut Conn, ch: u32, body: pb::frame::Body) -> Result<(), CtlError> {
        if conn.dead {
            return Err(CtlError::NotConnected);
        }
        match tokio::time::timeout(self.timing.send_timeout, conn.tx.send(frame(ch, body))).await {
            Ok(Ok(())) => Ok(()),
            _ => {
                conn.dead = true;
                Err(CtlError::NotConnected)
            }
        }
    }

    async fn on_tick(&mut self, conn: &mut Conn) -> Option<Exit> {
        let now = TokioInstant::now();
        if now.duration_since(conn.last_rx) > self.timing.idle_timeout {
            if let Some(c) = &conn.close {
                c.abort();
            }
            return Some(Exit::Lost("连接超时（长时间没有收到数据）".into()));
        }
        if now.duration_since(conn.last_ping) >= self.timing.ping_interval {
            conn.last_ping = now;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let _ = self
                .send(conn, 0, pb::frame::Body::Ping(pb::Ping { ts }))
                .await;
        }
        // 被控端一直没回复的请求不无限堆积
        self.pending.retain(|_, p| p.at().elapsed() < PENDING_TTL);
        self.uploads.retain(|_, tx| !tx.is_closed());
        if conn.resync.as_ref().is_some_and(|r| now >= r.deadline) {
            tracing::warn!(session = %self.id, "恢复终端超时，按当前进度继续");
            self.finish_resync(conn).await;
        }
        None
    }

    // ------------------------------------------------------------ 建立连接

    /// 一条新连接（Hello 已完成）接入会话：记录被控端能力，发 HostInfo；重连时开始恢复终端，否则直接 Ready。
    pub async fn begin_connection(&mut self, conn: &mut Conn, ack: pb::HelloAck, resume: bool) {
        let info = ack.host.clone().unwrap_or_default();
        self.host_features = ack.features.iter().cloned().collect();
        if let Ok(mut g) = self.shared.host.lock() {
            *g = Some(HostSnapshot {
                info: info.clone(),
                features: self.host_features.clone(),
                app_version: ack.app_version.clone(),
                proto_ver: ack.proto_ver,
            });
        }
        if let Ok(mut g) = self.shared.peer_key.lock() {
            *g = conn.peer_key.clone();
        }
        // 之后的重连以首次认证的公钥为准，公钥变化会被拒绝
        self.spec.known_host_key = Some(conn.peer_key.clone());
        self.spec.accept_key_change = false;

        let session = self.id.clone();
        self.emit(CoreEvent::HostInfo { session, info }).await;
        self.done_files.clear();

        for t in std::mem::take(&mut self.pending_closes) {
            let _ = self
                .send(
                    conn,
                    0,
                    pb::frame::Body::TermClose(pb::TermClose {
                        term_id: t,
                        kill: true,
                    }),
                )
                .await;
        }

        if resume && !self.terms.resumable().is_empty() {
            conn.resync = Some(Resync {
                outstanding: HashSet::new(),
                list_pending: true,
                deadline: TokioInstant::now() + self.timing.resync_timeout,
            });
            self.list_waiters.push(ListWaiter::Resync);
            let _ = self
                .send(conn, 0, pb::frame::Body::TermList(pb::TermList {}))
                .await;
        } else {
            self.set_state(SessionState::Ready).await;
        }
    }

    /// 退避重连。返回新连接，或不可恢复的关闭原因。
    async fn reconnect(&mut self) -> Result<Conn, CloseReason> {
        let mut attempt: u32 = 0;
        loop {
            // 1. 退避等待，可被"立即重试"和断开打断
            let delay = backoff(self.timing.backoff_base, self.timing.backoff_max, attempt);
            let session = self.id.clone();
            self.emit(CoreEvent::ReconnectInfo {
                session,
                attempt: attempt + 1,
                retry_in_ms: delay.as_millis() as u64,
            })
            .await;
            let sleep = tokio::time::sleep(delay);
            tokio::pin!(sleep);
            loop {
                if self.consumer_gone {
                    return Err(CloseReason::ConsumerGone);
                }
                tokio::select! {
                    _ = &mut sleep => break,
                    cmd = self.cmd_rx.recv() => match cmd {
                        None => return Err(CloseReason::ConsumerGone),
                        Some(c) => match self.on_cmd_offline(c) {
                            Off::Continue => {}
                            Off::Wake => break,
                            Off::Close => return Err(CloseReason::User),
                        },
                    },
                    _ = self.acks.notify.notified() => self.absorb_acks(),
                }
            }

            // 2. 一次尝试（自成一体的 future，期间仍然响应命令）
            let connector = self.connector.clone();
            let spec = self.spec.clone();
            let timing = self.timing.clone();
            let ver = self.app_version.clone();
            let attempt_fut =
                async move { establish(connector.as_ref(), &spec, &timing, &ver).await };
            tokio::pin!(attempt_fut);
            let res = loop {
                if self.consumer_gone {
                    return Err(CloseReason::ConsumerGone);
                }
                tokio::select! {
                    r = &mut attempt_fut => break r,
                    cmd = self.cmd_rx.recv() => match cmd {
                        None => return Err(CloseReason::ConsumerGone),
                        Some(c) => {
                            if let Off::Close = self.on_cmd_offline(c) {
                                return Err(CloseReason::User);
                            }
                        }
                    },
                    _ = self.acks.notify.notified() => self.absorb_acks(),
                }
            };
            match res {
                Ok((mut conn, ack)) => {
                    self.begin_connection(&mut conn, ack, true).await;
                    return Ok(conn);
                }
                Err(e) if !e.is_retryable() => return Err(CloseReason::from_error(&e)),
                Err(e) => {
                    tracing::info!(session = %self.id, attempt, "重连失败，稍后重试: {e}");
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }

    /// 离线（重连中）时处理命令：需要网络的一律返回"尚未连接"。
    fn on_cmd_offline(&mut self, cmd: Cmd) -> Off {
        match cmd {
            Cmd::OpenTerm { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::ListTerms { reply } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::AttachTerm { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::Input { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::Submit { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::Action { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::CommandList { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::Upload { reply, .. } => {
                let _ = reply.send(Err(CtlError::NotConnected));
            }
            Cmd::Resize { term, size, reply } => {
                // 只记录尺寸，重连后附着时带上
                let r = match self.terms.get_mut(&term) {
                    Some(e) => {
                        e.size = size;
                        Ok(())
                    }
                    None => Err(CtlError::NoSuchTerm(term)),
                };
                let _ = reply.send(r);
            }
            Cmd::CloseTerm { term, reply } => {
                self.terms.remove(&term);
                self.pending_closes.push(term);
                let _ = reply.send(Ok(()));
            }
            Cmd::CancelUpload { .. } => {}
            Cmd::ReconnectNow => return Off::Wake,
            Cmd::Disconnect { reply } => {
                let _ = reply.send(());
                return Off::Close;
            }
        }
        Off::Continue
    }

    // ------------------------------------------------------------ 命令（在线）

    fn alloc_req(&mut self) -> u64 {
        let r = self.next_req;
        self.next_req += 1;
        r
    }

    /// 返回 Some 表示会话应当结束。
    async fn on_cmd(&mut self, conn: &mut Conn, cmd: Cmd) -> Option<CloseReason> {
        use pb::frame::Body as B;
        match cmd {
            Cmd::OpenTerm { opts, reply } => {
                let req = self.alloc_req();
                let (cols, rows) = (opts.size.cols, opts.size.rows);
                let body = B::TermOpen(pb::TermOpen {
                    req_id: req,
                    profile: pb::Profile::from(opts.profile) as i32,
                    shell_id: opts.shell_id,
                    cwd: opts.cwd,
                    cols,
                    rows,
                    command: opts.command,
                    launch: opts.launch,
                });
                match self.send(conn, 0, body).await {
                    Ok(()) => {
                        self.pending.insert(
                            req,
                            Pending::Open {
                                size: opts.size,
                                reply,
                                at: Instant::now(),
                            },
                        );
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::ListTerms { reply } => {
                match self.send(conn, 0, B::TermList(pb::TermList {})).await {
                    Ok(()) => self.list_waiters.push(ListWaiter::User(reply)),
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::AttachTerm {
                term,
                size,
                from_seq,
                reply,
            } => {
                let req = self.alloc_req();
                // 界面给的偏移比已交付的小（界面重建过）：回退到那里重新交付；比已交付的大则不理会
                if let (Some(seq), Some(e)) = (from_seq, self.terms.get_mut(&term)) {
                    if seq < e.received {
                        e.received = seq;
                        e.rendered = e.rendered.min(seq);
                    }
                }
                let last_seq = match (self.terms.get(&term), from_seq) {
                    (Some(e), _) => e.received,
                    (None, seq) => seq.unwrap_or(0),
                };
                let body = B::TermAttach(pb::TermAttach {
                    req_id: req,
                    term_id: term.clone(),
                    last_seq,
                    cols: size.cols,
                    rows: size.rows,
                });
                match self.send(conn, 0, body).await {
                    Ok(()) => {
                        self.pending.insert(
                            req,
                            Pending::Attach {
                                size,
                                reply: Some(reply),
                                resync: false,
                                term,
                                at: Instant::now(),
                            },
                        );
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::Input { term, data, reply } => {
                let r = match self.attached_channel(&term) {
                    Ok(ch) => {
                        self.send(conn, ch, B::TermInput(pb::TermInput { data }))
                            .await
                    }
                    Err(e) => Err(e),
                };
                let _ = reply.send(r);
            }
            Cmd::Submit {
                term,
                text,
                attachments,
                press_enter,
                reply,
            } => {
                let r = match self.attached_channel(&term) {
                    Ok(ch) => match attachments.iter().find(|f| !self.done_files.contains(f)) {
                        Some(f) => Err(CtlError::AttachmentNotReady(*f)),
                        None => {
                            let msg_id = self.next_msg;
                            self.next_msg += 1;
                            self.send(
                                conn,
                                ch,
                                B::TermSubmit(pb::TermSubmit {
                                    msg_id,
                                    text,
                                    attachments,
                                    press_enter,
                                }),
                            )
                            .await
                            .map(|_| msg_id)
                        }
                    },
                    Err(e) => Err(e),
                };
                let _ = reply.send(r);
            }
            Cmd::Resize { term, size, reply } => {
                let ch = match self.terms.get_mut(&term) {
                    None => Err(CtlError::NoSuchTerm(term)),
                    Some(e) => {
                        e.size = size;
                        Ok(e.channel)
                    }
                };
                let r = match ch {
                    Ok(Some(ch)) => {
                        self.send(
                            conn,
                            ch,
                            B::TermResize(pb::TermResize {
                                cols: size.cols,
                                rows: size.rows,
                            }),
                        )
                        .await
                    }
                    Ok(None) => Ok(()),
                    Err(e) => Err(e),
                };
                let _ = reply.send(r);
            }
            Cmd::CloseTerm { term, reply } => {
                self.terms.remove(&term);
                let r = self
                    .send(
                        conn,
                        0,
                        B::TermClose(pb::TermClose {
                            term_id: term,
                            kill: true,
                        }),
                    )
                    .await;
                let _ = reply.send(r);
            }
            Cmd::Action {
                term,
                action_id,
                args,
                reply,
            } => {
                let r = match self.attached_channel(&term) {
                    Ok(ch) => {
                        let req = self.alloc_req();
                        self.send(
                            conn,
                            ch,
                            B::TermAction(pb::TermAction {
                                req_id: req,
                                action_id,
                                args,
                            }),
                        )
                        .await
                        .map(|_| req)
                    }
                    Err(e) => Err(e),
                };
                let _ = reply.send(r);
            }
            Cmd::CommandList { term, reply } => {
                let r = match self.attached_channel(&term) {
                    Ok(ch) => {
                        self.send(conn, ch, B::CommandListReq(pb::CommandListReq {}))
                            .await
                    }
                    Err(e) => Err(e),
                };
                let _ = reply.send(r);
            }
            Cmd::Upload { prepared, reply } => {
                let r = self.start_upload(conn, prepared);
                let _ = reply.send(r);
            }
            Cmd::CancelUpload { file } => {
                if let Some(tx) = self.uploads.get(&file) {
                    let _ = tx.try_send(UploadMsg::Cancel);
                }
            }
            Cmd::ReconnectNow => {}
            Cmd::Disconnect { reply } => {
                self.send_bye(conn, "user").await;
                let _ = reply.send(());
                return Some(CloseReason::User);
            }
        }
        None
    }

    fn attached_channel(&self, term: &str) -> Result<u32, CtlError> {
        match self.terms.get(term) {
            None => Err(CtlError::NoSuchTerm(term.to_string())),
            Some(e) => e
                .channel
                .ok_or_else(|| CtlError::TermNotAttached(term.to_string())),
        }
    }

    fn start_upload(&mut self, conn: &Conn, prepared: Prepared) -> Result<FileId, CtlError> {
        if !self.host_features.contains("file.upload") {
            return Err(CtlError::FileUnsupported);
        }
        self.uploads.retain(|_, tx| !tx.is_closed());
        if self.uploads.len() >= MAX_CONCURRENT {
            return Err(CtlError::TooManyUploads);
        }
        let file_id = self.next_file;
        self.next_file += 1;
        let (tx, rx) = mpsc::channel(UPLOAD_INBOX);
        self.uploads.insert(file_id, tx);
        tokio::spawn(upload::run(UploadJob {
            session: self.id.clone(),
            file_id,
            prepared,
            tx: conn.tx.clone(),
            events: self.events.clone(),
            inbox: rx,
            stall_timeout: self.timing.upload_stall,
            progress_interval: self.timing.progress_interval,
        }));
        Ok(file_id)
    }

    // ------------------------------------------------------------ 确认偏移

    /// 离线时只记录已渲染偏移。
    fn absorb_acks(&mut self) {
        for (term, consumed) in self.acks.take() {
            let _ = self.terms.note_rendered(&term, consumed);
        }
    }

    async fn flush_acks(&mut self, conn: &mut Conn) {
        for (term, consumed) in self.acks.take() {
            if let Some((ch, off)) = self.terms.note_rendered(&term, consumed) {
                let _ = self
                    .send(
                        conn,
                        ch,
                        pb::frame::Body::TermAck(pb::TermAck { consumed: off }),
                    )
                    .await;
            }
        }
    }

    // ------------------------------------------------------------ 收到的帧

    fn to_upload(&self, file: FileId, msg: UploadMsg) {
        if let Some(tx) = self.uploads.get(&file) {
            if tx.try_send(msg).is_err() {
                tracing::debug!(file, "上传任务收件箱已满或已结束，消息丢弃");
            }
        }
    }

    /// 返回 Some 表示会话应当结束。
    async fn on_frame(&mut self, conn: &mut Conn, f: pb::Frame) -> Option<CloseReason> {
        use pb::frame::Body as B;
        let ch = f.channel;
        // 不认识的分支（body 为 None）忽略
        let body = f.body?;
        let session = self.id.clone();
        match body {
            B::Ping(p) => {
                let _ = self.send(conn, 0, B::Pong(pb::Pong { ts: p.ts })).await;
            }
            B::Pong(p) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if p.ts > 0 && now >= p.ts {
                    self.shared
                        .rtt_ms
                        .store(now - p.ts, std::sync::atomic::Ordering::Relaxed);
                }
            }
            B::Bye(b) => return Some(CloseReason::HostBye(b.reason)),
            B::ActionCatalog(catalog) => {
                self.emit(CoreEvent::ActionCatalog { session, catalog })
                    .await;
            }
            B::TermOpened(o) => self.on_term_opened(conn, o).await,
            B::TermListResp(r) => self.on_term_list(conn, r).await,
            B::Error(e) => self.on_error(conn, ch, e).await,
            B::FileAccept(a) => self.to_upload(a.file_id, UploadMsg::Accept),
            B::FileAck(a) => self.to_upload(a.file_id, UploadMsg::Ack(a.received)),
            B::FileDone(d) => {
                // 先登记再转给上传任务：界面收到 UploadDone 后马上 term_submit 时附件已就绪
                self.done_files.insert(d.file_id);
                self.to_upload(d.file_id, UploadMsg::Done(d.remote_path));
            }
            B::TermOutput(o) => {
                if let Some((term, seq, data)) = self.terms.on_output(ch, o.seq, o.data) {
                    self.emit(CoreEvent::TermOutput {
                        session,
                        term,
                        seq,
                        data,
                    })
                    .await;
                }
            }
            B::TermState(s) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    self.emit(CoreEvent::TermState {
                        session,
                        term,
                        state: modes_from_pb(&s),
                    })
                    .await;
                }
            }
            B::TermExit(e) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    if let Some(t) = self.terms.get_mut(&term) {
                        t.exited = true;
                    }
                    self.emit(CoreEvent::TermExit {
                        session,
                        term,
                        code: e.code,
                    })
                    .await;
                }
            }
            B::AppState(state) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    self.emit(CoreEvent::AppState {
                        session,
                        term,
                        state,
                    })
                    .await;
                }
            }
            B::AppNotice(notice) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    self.emit(CoreEvent::AppNotice {
                        session,
                        term,
                        notice,
                    })
                    .await;
                }
            }
            B::TermActionResult(result) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    self.emit(CoreEvent::ActionResult {
                        session,
                        term,
                        result,
                    })
                    .await;
                }
            }
            B::CommandList(list) => {
                if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                    self.emit(CoreEvent::CommandList {
                        session,
                        term,
                        list,
                    })
                    .await;
                }
            }
            // HelloAck 重复、Pong 等无需处理；主控端不处理的方向和未知分支忽略
            _ => {}
        }
        None
    }

    async fn on_term_opened(&mut self, conn: &mut Conn, o: pb::TermOpened) {
        let Some(p) = self.pending.remove(&o.req_id) else {
            tracing::debug!(req = o.req_id, "收到没有对应请求的 TermOpened，忽略");
            return;
        };
        match p {
            Pending::Open { size, reply, .. } => {
                self.terms.on_attached(&o.term_id, o.channel, size);
                if let Ok(mut m) = self.shared.term_meta.lock() {
                    m.insert(o.term_id.clone(), (o.title.clone(), o.shell.clone()));
                }
                if reply.send(Ok(o.term_id.clone())).is_err() {
                    // 调用方已经放弃（超时）：不能在被控端留下无人知晓的终端
                    self.terms.remove(&o.term_id);
                    let _ = self
                        .send(
                            conn,
                            0,
                            pb::frame::Body::TermClose(pb::TermClose {
                                term_id: o.term_id,
                                kill: true,
                            }),
                        )
                        .await;
                }
            }
            Pending::Attach {
                size,
                reply,
                resync,
                ..
            } => {
                self.terms.on_attached(&o.term_id, o.channel, size);
                if let Some(r) = reply {
                    let _ = r.send(Ok(()));
                }
                if resync {
                    // 触发远端程序按当前尺寸重绘（《开发指南.md》T23 第 6 条）
                    let _ = self
                        .send(
                            conn,
                            o.channel,
                            pb::frame::Body::TermResize(pb::TermResize {
                                cols: size.cols,
                                rows: size.rows,
                            }),
                        )
                        .await;
                    if let Some(rs) = conn.resync.as_mut() {
                        rs.outstanding.remove(&o.req_id);
                    }
                    self.maybe_finish_resync(conn).await;
                }
            }
        }
    }

    async fn on_term_list(&mut self, conn: &mut Conn, r: pb::TermListResp) {
        let waiters = std::mem::take(&mut self.list_waiters);
        for w in waiters {
            match w {
                ListWaiter::User(reply) => {
                    let _ = reply.send(Ok(r.terms.clone()));
                }
                ListWaiter::Resync => self.do_resync(conn, &r.terms).await,
            }
        }
    }

    /// 重连后的恢复：对仍然存在的终端发 `TermAttach{last_seq}`，已经不存在的通知界面。
    async fn do_resync(&mut self, conn: &mut Conn, listed: &[pb::TermInfo]) {
        let alive: HashSet<&str> = listed.iter().map(|t| t.term_id.as_str()).collect();
        for (term, last_seq, size) in self.terms.resumable() {
            if !alive.contains(term.as_str()) {
                self.term_vanished(&term).await;
                continue;
            }
            let req = self.alloc_req();
            let body = pb::frame::Body::TermAttach(pb::TermAttach {
                req_id: req,
                term_id: term.clone(),
                last_seq,
                cols: size.cols,
                rows: size.rows,
            });
            if self.send(conn, 0, body).await.is_err() {
                return;
            }
            self.pending.insert(
                req,
                Pending::Attach {
                    size,
                    reply: None,
                    resync: true,
                    term,
                    at: Instant::now(),
                },
            );
            if let Some(rs) = conn.resync.as_mut() {
                rs.outstanding.insert(req);
            }
        }
        if let Some(rs) = conn.resync.as_mut() {
            rs.list_pending = false;
        }
        self.maybe_finish_resync(conn).await;
    }

    /// 被控端上已经没有这个终端（被控端重启或终端被清理）。
    async fn term_vanished(&mut self, term: &str) {
        self.terms.remove(term);
        let session = self.id.clone();
        self.emit(CoreEvent::TermExit {
            session,
            term: term.to_string(),
            code: -1,
        })
        .await;
        self.notice_error(
            term,
            "TERM_NOT_FOUND",
            "终端已不存在（被控端可能已重启或已清理）",
        )
        .await;
    }

    async fn maybe_finish_resync(&mut self, conn: &mut Conn) {
        let done = conn
            .resync
            .as_ref()
            .is_some_and(|r| !r.list_pending && r.outstanding.is_empty());
        if done {
            self.finish_resync(conn).await;
        }
    }

    async fn finish_resync(&mut self, conn: &mut Conn) {
        conn.resync = None;
        self.set_state(SessionState::Ready).await;
    }

    async fn on_error(&mut self, conn: &mut Conn, ch: u32, e: pb::Error) {
        if ch != 0 {
            // 终端通道上的错误：TERM_DETACHED 表示被另一个会话接管
            if let Some(term) = self.terms.id_of_channel(ch).cloned() {
                if e.code == "TERM_DETACHED" {
                    self.terms.mark_taken(&term);
                    self.notice_error(&term, &e.code, "该终端已在别处打开")
                        .await;
                } else {
                    self.notice_error(&term, &e.code, &e.message).await;
                }
            }
            return;
        }
        if e.ref_id != 0 {
            if let Some(p) = self.pending.remove(&e.ref_id) {
                let err = CtlError::Remote {
                    code: e.code.clone(),
                    message: e.message.clone(),
                };
                match p {
                    Pending::Attach {
                        resync: true, term, ..
                    } => {
                        if let Some(rs) = conn.resync.as_mut() {
                            rs.outstanding.remove(&e.ref_id);
                        }
                        if e.code == "TERM_NOT_FOUND" {
                            self.term_vanished(&term).await;
                        } else if e.code == "TERM_BUSY" {
                            // 被其他设备占用：不抢占、不重试，标记为被占用，不阻塞会话 Ready
                            self.terms.mark_busy(&term);
                            self.notice_error(&term, "TERM_BUSY", TERM_BUSY_TEXT).await;
                        } else {
                            self.notice_error(&term, &e.code, &e.message).await;
                        }
                        self.maybe_finish_resync(conn).await;
                    }
                    Pending::Attach {
                        resync: false,
                        term,
                        reply,
                        ..
                    } if e.code == "TERM_BUSY" => {
                        self.terms.mark_busy(&term);
                        if let Some(r) = reply {
                            let _ = r.send(Err(err));
                        }
                        self.notice_error(&term, "TERM_BUSY", TERM_BUSY_TEXT).await;
                    }
                    other => other.fail(err),
                }
                return;
            }
            if self.uploads.contains_key(&e.ref_id) {
                self.to_upload(
                    e.ref_id,
                    UploadMsg::Error {
                        code: e.code,
                        message: e.message,
                    },
                );
                return;
            }
        }
        tracing::debug!(code = %e.code, msg = %e.message, "收到无法对应的 Error");
    }
}

/// 退避间隔：`base * 2^attempt`，不超过 `max`（默认 1、2、4、8、15、15…秒）。
pub(crate) fn backoff(base: Duration, max: Duration, attempt: u32) -> Duration {
    let mult = 1u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX);
    base.saturating_mul(mult).min(max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence_1_2_4_8_15() {
        let b = Duration::from_secs(1);
        let m = Duration::from_secs(15);
        let v: Vec<u64> = (0..7).map(|i| backoff(b, m, i).as_secs()).collect();
        assert_eq!(v, vec![1, 2, 4, 8, 15, 15, 15]);
        assert_eq!(backoff(b, m, u32::MAX), m);
    }
}
