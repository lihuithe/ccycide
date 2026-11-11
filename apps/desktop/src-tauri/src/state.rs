//! 全局状态：核心库句柄、终端输出路由、托盘句柄。
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rterm_core::core::Core;
use tokio::sync::{mpsc, oneshot, watch};

use crate::error::{CmdResult, CommandError};
use crate::events::RouterCmd;
use crate::tray::TrayHandles;

/// 核心库的启动状态。
#[derive(Clone)]
pub enum CoreSlot {
    Starting,
    Ready(Core),
    Failed(CommandError),
}

/// `cancel_connect` 找到的结果。
pub enum CancelTarget {
    /// 没有这个 requestId（已结束或从未开始）：静默成功
    Unknown,
    /// 已对应核心会话：调用 `Core::cancel_connect(session)`
    Session(String),
    /// 还没拿到核心会话（排队或刚开始）：已记下，拿到会话时立刻取消
    Deferred,
}

/// 进行中的 `connect` 命令：前端的 requestId ↔ 核心库会话 ID。
///
/// 核心库只在 `SessionState(Connecting/AwaitingApproval)` 事件里给出会话 ID，而 `connect` 要等到握手完成
/// 才返回。为了不混淆并发的请求，`connect_gate` 把“开始连接 → 事件泵看到该会话的第一个状态事件”这一小段串行化
/// （等待对方确认的漫长阶段不占用它）。
#[derive(Default)]
pub struct ConnectTable {
    /// 正在等核心会话 ID 的请求，最多一个
    waiting: Option<(String, Option<oneshot::Sender<()>>)>,
    /// 已登记的请求 -> 会话（None = 还没拿到）
    by_request: HashMap<String, Option<String>>,
    /// 进行中的会话 -> 请求
    by_session: HashMap<String, String>,
    cancel_requested: HashSet<String>,
    /// 失败的 connect 对应的会话：它们的后续事件（如 closed）由命令的错误返回承载，不再发给前端
    failed: HashSet<String>,
}

impl ConnectTable {
    /// 命令一进来就登记，这样排队等 gate 期间的取消也能找到它。
    pub fn register(&mut self, rid: &str) {
        self.by_request.entry(rid.to_string()).or_insert(None);
    }

    /// 拿到 gate 之后开始连接；已被取消则返回 false。
    pub fn begin(&mut self, rid: &str, release: oneshot::Sender<()>) -> bool {
        if self.cancel_requested.contains(rid) {
            return false;
        }
        self.waiting = Some((rid.to_string(), Some(release)));
        true
    }

    /// 事件泵：看到新会话的 Connecting/AwaitingApproval。若它属于等待中的请求，绑定并返回“是否要立刻取消”。
    pub fn bind(&mut self, session: &str) -> Option<bool> {
        if self.by_session.contains_key(session) {
            return None;
        }
        let (rid, release) = self.waiting.take()?;
        if let Some(tx) = release {
            let _ = tx.send(());
        }
        self.by_request
            .insert(rid.clone(), Some(session.to_string()));
        self.by_session.insert(session.to_string(), rid.clone());
        Some(self.cancel_requested.contains(&rid))
    }

    pub fn request_of(&self, session: &str) -> Option<String> {
        self.by_session.get(session).cloned()
    }

    pub fn is_pending_or_failed(&self, session: &str) -> bool {
        self.by_session.contains_key(session) || self.failed.contains(session)
    }

    pub fn request_cancel(&mut self, rid: &str) -> CancelTarget {
        match self.by_request.get(rid) {
            None => CancelTarget::Unknown,
            Some(Some(sid)) => {
                self.cancel_requested.insert(rid.to_string());
                CancelTarget::Session(sid.clone())
            }
            Some(None) => {
                self.cancel_requested.insert(rid.to_string());
                CancelTarget::Deferred
            }
        }
    }

    /// connect 命令结束（成功/失败/被取消）。
    pub fn finish(&mut self, rid: &str, ok: bool) {
        if matches!(&self.waiting, Some((w, _)) if w == rid) {
            self.waiting = None;
        }
        self.cancel_requested.remove(rid);
        if let Some(Some(sid)) = self.by_request.remove(rid) {
            self.by_session.remove(&sid);
            if !ok {
                if self.failed.len() >= 64 {
                    self.failed.clear();
                }
                self.failed.insert(sid);
            }
        }
    }
}

pub struct AppState {
    connects: Mutex<ConnectTable>,
    pub connect_gate: Arc<tokio::sync::Mutex<()>>,
    /// 本机用户拒绝过的待确认来访（用于给 `incomingClosed` 合成 reason = rejected）
    rejected: Mutex<HashSet<String>>,
    slot: watch::Sender<CoreSlot>,
    router: mpsc::Sender<RouterCmd>,
    /// 关闭窗口时是否最小化到托盘（由设置同步）
    pub close_to_tray: AtomicBool,
    /// 托盘是否创建成功（Linux 无托盘时关闭窗口改为最小化）
    pub tray_ok: AtomicBool,
    pub tray: OnceLock<TrayHandles>,
    /// 退出流程只执行一次
    pub shutting_down: AtomicBool,
}

impl AppState {
    pub fn new(router: mpsc::Sender<RouterCmd>) -> Self {
        let (slot, _) = watch::channel(CoreSlot::Starting);
        Self {
            connects: Mutex::new(ConnectTable::default()),
            connect_gate: Arc::new(tokio::sync::Mutex::new(())),
            rejected: Mutex::new(HashSet::new()),
            slot,
            router,
            close_to_tray: AtomicBool::new(true),
            tray_ok: AtomicBool::new(false),
            tray: OnceLock::new(),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn mark_rejected(&self, session: &str) {
        let mut r = self.rejected.lock().unwrap_or_else(|e| e.into_inner());
        if r.len() >= 256 {
            r.clear();
        }
        r.insert(session.to_string());
    }

    pub fn take_rejected(&self, session: &str) -> bool {
        self.rejected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session)
    }

    fn connects(&self) -> std::sync::MutexGuard<'_, ConnectTable> {
        self.connects.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 在持锁期间操作进行中的 connect 表。
    pub fn with_connects<R>(&self, f: impl FnOnce(&mut ConnectTable) -> R) -> R {
        f(&mut self.connects())
    }

    pub fn bind_connect(&self, session: &str) -> Option<bool> {
        self.connects().bind(session)
    }

    pub fn pending_request_of(&self, session: &str) -> Option<String> {
        self.connects().request_of(session)
    }

    pub fn is_pending_or_failed(&self, session: &str) -> bool {
        self.connects().is_pending_or_failed(session)
    }

    pub fn set_core(&self, core: Core) {
        self.slot.send_replace(CoreSlot::Ready(core));
    }

    pub fn set_failed(&self, e: CommandError) {
        self.slot.send_replace(CoreSlot::Failed(e));
    }

    /// 已就绪时立即返回核心库句柄（不等待）。
    pub fn core_now(&self) -> Option<Core> {
        match &*self.slot.borrow() {
            CoreSlot::Ready(c) => Some(c.clone()),
            _ => None,
        }
    }

    /// 取核心库句柄；启动中则最多等 30 秒（命令在窗口刚打开时就可能被调用）。
    pub async fn core(&self) -> CmdResult<Core> {
        match self.slot.borrow().clone() {
            CoreSlot::Ready(c) => return Ok(c),
            CoreSlot::Failed(e) => return Err(e),
            CoreSlot::Starting => {}
        }
        let mut rx = self.slot.subscribe();
        let waited = tokio::time::timeout(
            Duration::from_secs(30),
            rx.wait_for(|s| !matches!(s, CoreSlot::Starting)),
        )
        .await;
        match waited {
            Ok(Ok(s)) => match &*s {
                CoreSlot::Ready(c) => Ok(c.clone()),
                CoreSlot::Failed(e) => Err(e.clone()),
                CoreSlot::Starting => Err(CommandError::new("NOT_READY", "核心尚未就绪")),
            },
            _ => Err(CommandError::new("NOT_READY", "核心启动超时")),
        }
    }

    /// 向输出路由登记 / 注销终端的 Channel。
    pub async fn router(&self, cmd: RouterCmd) {
        if self.router.send(cmd).await.is_err() {
            tracing::warn!("输出路由已停止，忽略登记");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_maps_request_and_session() {
        let mut t = ConnectTable::default();
        t.register("r1");
        let (tx, mut rx) = oneshot::channel();
        assert!(t.begin("r1", tx));
        assert_eq!(t.bind("S1"), Some(false));
        assert!(rx.try_recv().is_ok());
        assert_eq!(t.request_of("S1").as_deref(), Some("r1"));
        // 同一会话的第二个状态事件不再算新绑定
        assert_eq!(t.bind("S1"), None);
        // 没有等待中的请求时，陌生会话不绑定
        assert_eq!(t.bind("S2"), None);
        t.finish("r1", true);
        assert!(t.request_of("S1").is_none());
        assert!(!t.is_pending_or_failed("S1"));
    }

    #[test]
    fn cancel_before_and_after_bind() {
        let mut t = ConnectTable::default();
        assert!(matches!(t.request_cancel("nope"), CancelTarget::Unknown));
        t.register("r1");
        assert!(matches!(t.request_cancel("r1"), CancelTarget::Deferred));
        // 排队期间被取消：begin 拒绝
        let (tx, _rx) = oneshot::channel();
        assert!(!t.begin("r1", tx));
        t.finish("r1", false);

        t.register("r2");
        let (tx, _rx) = oneshot::channel();
        assert!(t.begin("r2", tx));
        assert!(matches!(t.request_cancel("r2"), CancelTarget::Deferred));
        // 取消先于绑定：绑定时要求立刻取消
        assert_eq!(t.bind("S9"), Some(true));
        assert!(matches!(t.request_cancel("r2"), CancelTarget::Session(s) if s == "S9"));
        t.finish("r2", false);
        // 失败的会话后续事件被屏蔽
        assert!(t.is_pending_or_failed("S9"));
    }

    #[test]
    fn concurrent_requests_bind_in_order() {
        let mut t = ConnectTable::default();
        t.register("a");
        t.register("b");
        let (tx, _rx) = oneshot::channel();
        assert!(t.begin("a", tx));
        assert_eq!(t.bind("SA"), Some(false));
        let (tx, _rx) = oneshot::channel();
        assert!(t.begin("b", tx));
        assert_eq!(t.bind("SB"), Some(false));
        assert_eq!(t.request_of("SA").as_deref(), Some("a"));
        assert_eq!(t.request_of("SB").as_deref(), Some("b"));
    }
}
