//! 核心事件泵：把 `CoreEvent` 转给前端，并处理桌面端自己的副作用（托盘、系统通知、防睡眠）。
//!
//! - 低频事件：`app.emit("core-event", UiEvent)`；
//! - 终端输出：`TermOutput` 不走事件，经 [`Router`] 合并后写入各终端的 `Channel`（帧格式见 `output.rs`）；
//! - 输出先于 Channel 登记到达（`open_term` 刚返回前的瞬间）时，暂存在 `pending`，登记时补发。
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rterm_core::core::{format_device_code, Core};
use rterm_core::events::CoreEvent;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

use crate::output::{encode_frame, Coalescer, FLUSH_INTERVAL, MAX_FRAME};
use crate::state::AppState;
use crate::{power, tray};

/// 终端键：(会话 ID, 终端 ID)。
pub type Key = (String, String);

/// 命令层发给路由的消息。
pub enum RouterCmd {
    /// 登记终端输出通道。`replay_pending`：把登记前暂存的输出补发出去（`open_term`）；
    /// 附着已有终端时为 false，续传由核心库的 `attach_term_from(.., lastSeq)` 负责，暂存的旧数据直接丢弃。
    Register {
        key: Key,
        channel: Channel<InvokeResponseBody>,
        replay_pending: bool,
    },
    Unregister {
        key: Key,
    },
}

struct Sink {
    channel: Channel<InvokeResponseBody>,
}

#[derive(Default)]
struct Pending {
    chunks: Vec<(u64, Vec<u8>)>,
    bytes: usize,
}

/// 单个终端在没有通道时最多暂存的字节数。
const PENDING_CAP: usize = 4 * 1024 * 1024;

struct Router {
    sinks: HashMap<Key, Sink>,
    pending: HashMap<Key, Pending>,
    co: Coalescer<Key>,
}

impl Router {
    fn new() -> Self {
        Self {
            sinks: HashMap::new(),
            pending: HashMap::new(),
            co: Coalescer::new(FLUSH_INTERVAL, MAX_FRAME),
        }
    }

    fn send_frame(&mut self, key: &Key, seq: u64, data: Vec<u8>) {
        let Some(s) = self.sinks.get(key) else { return };
        if s.channel
            .send(InvokeResponseBody::Raw(encode_frame(seq, &data)))
            .is_err()
        {
            // 窗口已销毁或页面刷新：丢掉通道，后续输出暂存，等前端重新附着
            tracing::debug!("终端输出通道已失效：{}", key.1);
            self.sinks.remove(key);
        }
    }

    fn on_output(&mut self, key: Key, seq: u64, data: Vec<u8>) {
        if self.sinks.contains_key(&key) {
            let frames = self.co.push(&key, seq, &data, Instant::now());
            for (sq, d) in frames {
                self.send_frame(&key, sq, d);
            }
            return;
        }
        let p = self.pending.entry(key.clone()).or_default();
        p.bytes += data.len();
        p.chunks.push((seq, data));
        if p.bytes > PENDING_CAP {
            tracing::warn!("终端 {} 在前端登记通道前积压过多输出，已丢弃", key.1);
            self.pending.remove(&key);
        }
    }

    fn register(&mut self, key: Key, channel: Channel<InvokeResponseBody>, replay_pending: bool) {
        self.flush_key(&key);
        self.sinks.insert(key.clone(), Sink { channel });
        if let Some(p) = self.pending.remove(&key) {
            if replay_pending {
                for (seq, data) in p.chunks {
                    self.on_output(key.clone(), seq, data);
                }
            }
        }
    }

    /// 把某个终端已合并的输出立即发出（终端状态变化、退出前保证顺序）。
    fn flush_key(&mut self, key: &Key) {
        if let Some((seq, data)) = self.co.take(key) {
            self.send_frame(key, seq, data);
        }
    }

    fn flush_due(&mut self, now: Instant) {
        for (key, seq, data) in self.co.take_due(now) {
            self.send_frame(&key, seq, data);
        }
    }

    fn drop_term(&mut self, key: &Key) {
        self.flush_key(key);
        self.sinks.remove(key);
        self.pending.remove(key);
    }

    fn drop_session(&mut self, session: &str) {
        self.co.discard(|k| k.0 == session);
        self.sinks.retain(|k, _| k.0 != session);
        self.pending.retain(|k, _| k.0 != session);
    }
}

/// 事件里带终端标识的，取出 (会话, 终端)。
fn term_key(ev: &CoreEvent) -> Option<Key> {
    match ev {
        CoreEvent::TermState { session, term, .. }
        | CoreEvent::TermExit { session, term, .. }
        | CoreEvent::AppState { session, term, .. }
        | CoreEvent::AppNotice { session, term, .. }
        | CoreEvent::CommandList { session, term, .. } => Some((session.clone(), term.clone())),
        _ => None,
    }
}

/// 显示主窗口（取消最小化、置前）。
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 发系统通知；失败只记日志。
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("系统通知发送失败：{e}");
    }
}

/// 运行事件泵，直到事件通道关闭。
pub async fn run_pump(
    app: AppHandle,
    core: Core,
    mut ev_rx: mpsc::Receiver<CoreEvent>,
    mut cmd_rx: mpsc::Receiver<RouterCmd>,
) {
    let mut router = Router::new();
    let mut pump = PumpState::default();
    // 睡眠唤醒检测：定时器的实际间隔远大于期望值，说明系统睡过
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    let mut last_tick = Instant::now();

    tray::refresh(&app, &core);
    sync_power(&core);

    loop {
        let deadline = router.co.next_deadline();
        let flush_wait = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(tokio::time::Instant::from_std(d)).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            ev = ev_rx.recv() => {
                let Some(ev) = ev else { break };
                handle_event(&app, &core, &mut router, &mut pump, ev);
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(RouterCmd::Register { key, channel, replay_pending }) => router.register(key, channel, replay_pending),
                    Some(RouterCmd::Unregister { key }) => router.drop_term(&key),
                    None => break,
                }
            }
            _ = flush_wait => router.flush_due(Instant::now()),
            _ = tick.tick() => {
                let now = Instant::now();
                if now.duration_since(last_tick) > Duration::from_secs(20) {
                    tracing::info!("检测到系统睡眠唤醒，立即重连");
                    core.network_changed();
                }
                last_tick = now;
            }
        }
    }
    tracing::info!("核心事件通道已关闭，事件泵退出");
}

/// 事件泵自己的状态。
#[derive(Default)]
struct PumpState {
    /// 已通知过的待确认来访会话
    seen_incoming: HashSet<String>,
    /// 刚收到 `Notice(INCOMING_CANCELLED)`：紧随其后的 `IncomingClosed` 是主控方取消
    cancel_notice: bool,
}

/// `incomingClosed.reason`：用户拒绝 → rejected；主控方取消 → cancelled；其余 → closed。
/// （同意后条目保留、核心库不发 `IncomingClosed`，所以不会出现 accepted；若握手随后失败则是 closed。）
fn incoming_closed_reason(app: &AppHandle, pump: &mut PumpState, session: &str) -> &'static str {
    let rejected = app.state::<AppState>().take_rejected(session);
    if std::mem::take(&mut pump.cancel_notice) {
        "cancelled"
    } else if rejected {
        "rejected"
    } else {
        "closed"
    }
}

fn emit_json(app: &AppHandle, v: serde_json::Value) {
    if let Err(e) = app.emit("core-event", v) {
        tracing::warn!("向前端发送事件失败：{e}");
    }
}

fn handle_event(
    app: &AppHandle,
    core: &Core,
    router: &mut Router,
    pump: &mut PumpState,
    ev: CoreEvent,
) {
    // 终端输出：只进路由
    if let CoreEvent::TermOutput {
        session,
        term,
        seq,
        data,
    } = ev
    {
        router.on_output((session, term), seq, data);
        return;
    }
    // 同一终端的低频事件前，先把已合并的输出发出去，保证“输出在前、状态在后”
    if let Some(k) = term_key(&ev) {
        router.flush_key(&k);
    }

    let state = app.state::<AppState>();
    // 该事件是否由桌面端自己改写后发送（不再走 core.ui_event）
    let mut handled = false;

    match &ev {
        CoreEvent::SignalState { .. } | CoreEvent::LocalInfoChanged { .. } => {
            tray::refresh(app, core)
        }
        CoreEvent::SettingsChanged { settings } => {
            state.close_to_tray.store(
                settings.app.close_to_tray,
                std::sync::atomic::Ordering::Relaxed,
            );
            tray::refresh(app, core);
            sync_power(core);
        }
        CoreEvent::IncomingSession {
            session,
            from_code,
            pending_confirm,
            ..
        } => {
            // 等待确认（没有超时，可同时排多个）：前端的确认对话框在窗口里，窗口藏在托盘时要拉出来，
            // 并发系统通知提醒。已连入的通知由前端按 notifyOnConnect 发送（controller.ts），这里不重复发。
            if *pending_confirm && pump.seen_incoming.insert(session.clone()) {
                show_main(app);
                if core.get_settings().host.notify_on_connect {
                    let who = format_device_code(from_code);
                    notify(
                        app,
                        "RTerm 有设备请求连接",
                        &format!("设备 {who} 请求连接，请在窗口中确认"),
                    );
                }
            }
            tray::refresh(app, core);
            sync_power(core);
        }
        CoreEvent::Notice { level, code, text } => {
            tracing::info!("核心通知 [{level}/{code}]：{text}");
            if code == "INCOMING_CANCELLED" {
                pump.cancel_notice = true;
            }
        }
        CoreEvent::IncomingClosed { session } => {
            pump.seen_incoming.remove(session);
            let reason = incoming_closed_reason(app, pump, session);
            tray::refresh(app, core);
            sync_power(core);
            emit_json(
                app,
                serde_json::json!({"type": "incomingClosed", "sessionId": session, "reason": reason}),
            );
            handled = true;
        }
        CoreEvent::UpgradeRequired { .. } => show_main(app),
        CoreEvent::SessionState { session, state: st } => {
            use rterm_core::events::SessionState as S;
            if matches!(st, S::Connecting | S::AwaitingApproval) {
                // connect 命令还在进行：把核心会话与前端的 requestId 对上（必要时立刻取消）
                if let Some(cancel_now) = state.bind_connect(session) {
                    if cancel_now {
                        core.cancel_connect(session);
                    }
                }
            }
            if let Some(rid) = state.pending_request_of(session) {
                // connect 还没返回：前端不知道 sessionId，只发 awaitingApproval（空 sessionId + requestId）
                if matches!(st, S::AwaitingApproval) {
                    emit_json(
                        app,
                        serde_json::json!({"type": "sessionState", "sessionId": "", "requestId": rid, "state": "awaitingApproval"}),
                    );
                }
                if matches!(st, S::Connecting | S::AwaitingApproval) {
                    handled = true;
                }
            }
        }
        CoreEvent::SessionClosed { session, .. } => {
            router.drop_session(session);
            // connect 失败时由命令的错误返回承载原因，不再另发 closed 事件
            if state.is_pending_or_failed(session) {
                handled = true;
            }
        }
        _ => {}
    }

    if !handled {
        if let Some(ui) = core.ui_event(&ev) {
            match serde_json::to_value(&ui) {
                Ok(v) => emit_json(app, v),
                Err(e) => tracing::warn!("事件序列化失败：{e}"),
            }
        }
    }

    // 终端退出：输出和 exit 事件都发完之后再释放通道
    if let CoreEvent::TermExit { session, term, .. } = &ev {
        router.drop_term(&(session.clone(), term.clone()));
    }
}

/// 按设置和当前来访连接数更新“有连接时阻止睡眠”。
fn sync_power(core: &Core) {
    let want = core.get_settings().host.prevent_sleep_when_connected
        && core.list_incoming().iter().any(|i| !i.pending_confirm);
    power::set_keep_awake(want);
}
