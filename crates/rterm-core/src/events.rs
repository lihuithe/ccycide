//! 核心库向界面层抛出的事件（《开发指南.md》7.0）。
use rterm_proto::pb;

use crate::core::LocalInfo;
use crate::settings::Settings;

pub type SessionId = String;
pub type TermId = String;
pub type FileId = u64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TermModes {
    pub bracketed_paste: bool,
    pub alt_screen: bool,
    pub app_cursor: bool,
    pub mouse: bool,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Connecting,
    /// 已向对方发出连接请求，等待对方用户确认（可能很久，可用 `cancel_connect` 取消）
    AwaitingApproval,
    Ready,
    Reconnecting,
    /// 关闭原因：用户断开 / 密码错误 / 对方拒绝 / 网络错误等
    Closed(String),
}

#[derive(Debug, Clone)]
pub enum CoreEvent {
    SignalState {
        online: bool,
    },
    /// 来访会话。同一个 `session` 可能出现两次：先 `pending_confirm = true`（等本机用户确认），
    /// 握手成功后再来一次 `pending_confirm = false`（界面按 session 更新）。
    IncomingSession {
        session: SessionId,
        from_code: String,
        platform: String,
        /// 毫秒时间戳
        started_at_ms: u64,
        pending_confirm: bool,
    },
    IncomingClosed {
        session: SessionId,
    },
    SessionState {
        session: SessionId,
        state: SessionState,
    },
    /// 会话关闭的结构化原因（紧跟在 `SessionState(Closed)` 之后）。`code` 见 `error::codes`，
    /// 如 `PASSWORD_WRONG`（界面应要求重新输入密码）、`USER`、`PEER_KEY_CHANGED`、`HOST_BYE`、`REFUSED`。
    SessionClosed {
        session: SessionId,
        code: String,
        reason: String,
    },
    /// 即将进行第 `attempt` 次（从 1 开始）自动重连，`retry_in_ms` 毫秒后开始
    ReconnectInfo {
        session: SessionId,
        attempt: u32,
        retry_in_ms: u64,
    },
    /// 往返延迟（毫秒），每 5 秒一次
    Latency {
        session: SessionId,
        ms: u64,
    },
    HostInfo {
        session: SessionId,
        info: pb::HostInfo,
    },
    TermOutput {
        session: SessionId,
        term: TermId,
        seq: u64,
        data: Vec<u8>,
    },
    TermState {
        session: SessionId,
        term: TermId,
        state: TermModes,
    },
    TermExit {
        session: SessionId,
        term: TermId,
        code: i32,
    },
    UploadProgress {
        session: SessionId,
        file: FileId,
        sent: u64,
        total: u64,
    },
    UploadDone {
        session: SessionId,
        file: FileId,
        remote_path: String,
    },
    UploadFailed {
        session: SessionId,
        file: FileId,
        reason: String,
    },
    ActionCatalog {
        session: SessionId,
        catalog: pb::ActionCatalog,
    },
    AppState {
        session: SessionId,
        term: TermId,
        state: pb::AppState,
    },
    AppNotice {
        session: SessionId,
        term: TermId,
        notice: pb::AppNotice,
    },
    ActionResult {
        session: SessionId,
        term: TermId,
        result: pb::TermActionResult,
    },
    CommandList {
        session: SessionId,
        term: TermId,
        list: pb::CommandList,
    },
    /// 设置被核心库内部改动（托盘“暂停被控”等）后的完整设置
    SettingsChanged {
        settings: Box<Settings>,
    },
    /// 本机信息变化：临时密码刷新、设备码拿到、注册失败/重试状态等
    LocalInfoChanged {
        info: Box<LocalInfo>,
    },
    /// 服务端公告、被踢下线、认证错误等需要告知用户的消息。`level`：info | warn | error
    Notice {
        level: String,
        code: String,
        text: String,
    },
    /// 本机版本低于服务端要求的最低版本：界面应阻止使用并引导升级
    UpgradeRequired {
        min_version: String,
        current_version: String,
        latest_version: Option<String>,
    },
}
