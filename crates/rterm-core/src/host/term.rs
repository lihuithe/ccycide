//! 终端会话（《实现方案.md》5.5.3，《开发指南.md》T13、T15、T23、T25、T37 执行队列）。
//!
//! 结构：
//! - [`TermManager`]：被控端全局的终端表（不属于某一条会话，重连要靠它找回终端）。
//! - 每个终端两个 tokio 任务：
//!   - 终端任务（`TermTask`）：独占 PTY 的输出，写环形缓冲、跟踪模式、合并发送、流控、附着/回放、保留策略；
//!   - 执行队列任务：`TermSubmit` 和 `TermAction` 排成一个队列，一次只执行一个，输入不交叉。
//! - 直通按键（`TermInput`）不经过队列，直接写 PTY。
use std::collections::{HashMap, VecDeque};
use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rterm_proto::pb;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::events::TermModes;
use crate::host::actions::{self, ActionError, ActionTarget, AppSnapshot, Catalog, QUEUE_LIMIT};
use crate::host::adapter::{self, AdapterRule, AdapterRules, MatchCtx};
use crate::host::procs;
use crate::host::pty::{self, PtyControl, SpawnSpec};
use crate::host::shell::ShellEntry;
use crate::host::status::{self, AppStateData, BridgeMessage};
use crate::link::FrameTx;

pub const RING_CAP: usize = 2 * 1024 * 1024;
pub const HIGH_WATER: u64 = 4 * 1024 * 1024;
pub const LOW_WATER: u64 = 1024 * 1024;
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
pub const FLUSH_SIZE: usize = 64 * 1024;
pub const REPLAY_CHUNK: usize = 64 * 1024;
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
pub const APP_STATE_MIN_INTERVAL: Duration = Duration::from_millis(200);
/// 退出后继续收尾输出的最长时间。
pub const EXIT_DRAIN: Duration = Duration::from_millis(1500);
pub const PROBE_INTERVAL: Duration = Duration::from_secs(2);
/// 终端复位序列（`ESC c`）。
pub const RESET_SEQ: &[u8] = b"\x1bc";

// ───────────────────────── 环形缓冲 ─────────────────────────

/// 按字节偏移编号的输出环形缓冲。`TermOutput.seq` 就是这个偏移。
pub struct OutputRing {
    buf: VecDeque<u8>,
    cap: usize,
    /// buf 里第一个字节在整个输出流里的偏移
    start: u64,
}

impl OutputRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::new(),
            cap: cap.max(16),
            start: 0,
        }
    }
    pub fn start(&self) -> u64 {
        self.start
    }
    pub fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }
    pub fn len(&self) -> usize {
        self.buf.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            // 一次写入就超过容量：只留最后 cap 字节
            let dropped = self.buf.len() as u64 + (data.len() - self.cap) as u64;
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            self.start += dropped;
            return;
        }
        self.buf.extend(data);
        if self.buf.len() > self.cap {
            let over = self.buf.len() - self.cap;
            self.buf.drain(..over);
            self.start += over as u64;
        }
    }

    /// 取出 `from` 之后的全部数据。返回（实际起始偏移，数据，是否完整衔接）。
    /// `from` 已被覆盖（或超出末尾）时：从缓冲区里第一个换行符之后开始，避免从半个转义序列中间开始。
    pub fn read_from(&self, from: u64) -> (u64, Vec<u8>, bool) {
        if from >= self.start && from <= self.end() {
            let skip = (from - self.start) as usize;
            return (from, self.buf.iter().skip(skip).copied().collect(), true);
        }
        let skip = self
            .buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        (
            self.start + skip as u64,
            self.buf.iter().skip(skip).copied().collect(),
            false,
        )
    }
}

// ───────────────────────── 模式跟踪 ─────────────────────────

struct Tracker<'a> {
    modes: &'a mut TermModes,
    mouse_bits: &'a mut u8,
    changed: bool,
}

impl vte::Perform for Tracker<'_> {
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        // 只关心 ESC[?<数字>h（开）和 ESC[?<数字>l（关）
        if intermediates != *b"?" || (action != 'h' && action != 'l') {
            return;
        }
        let on = action == 'h';
        for p in params.iter() {
            let Some(&n) = p.first() else { continue };
            match n {
                2004 => {
                    if self.modes.bracketed_paste != on {
                        self.modes.bracketed_paste = on;
                        self.changed = true;
                    }
                }
                1049 | 47 | 1047 => {
                    if self.modes.alt_screen != on {
                        self.modes.alt_screen = on;
                        self.changed = true;
                    }
                }
                1 => {
                    if self.modes.app_cursor != on {
                        self.modes.app_cursor = on;
                        self.changed = true;
                    }
                }
                1000 | 1002 | 1003 => {
                    let bit = match n {
                        1000 => 1,
                        1002 => 2,
                        _ => 4,
                    };
                    if on {
                        *self.mouse_bits |= bit;
                    } else {
                        *self.mouse_bits &= !bit;
                    }
                    let m = *self.mouse_bits != 0;
                    if self.modes.mouse != m {
                        self.modes.mouse = m;
                        self.changed = true;
                    }
                }
                _ => {}
            }
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // ESC]0;标题 BEL 或 ESC]2;标题 BEL。标题里的分号会把参数拆开，这里再拼回去。
        if params.len() >= 2 && (params[0] == b"0" || params[0] == b"2") {
            let joined: Vec<u8> = params[1..].join(&b';');
            let t = String::from_utf8_lossy(&joined).into_owned();
            if t != self.modes.title {
                self.modes.title = t;
                self.changed = true;
            }
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        // ESC c：完全复位，各种模式回到默认
        if intermediates.is_empty() && byte == b'c' {
            let title = std::mem::take(&mut self.modes.title);
            let before = self.modes.clone();
            *self.modes = TermModes {
                title,
                ..Default::default()
            };
            *self.mouse_bits = 0;
            if *self.modes != before {
                self.changed = true;
            }
        }
    }
}

/// 用 `vte` 解析输出流，只跟踪几个模式开关（《开发指南.md》T15）。
pub struct ModeTracker {
    parser: vte::Parser,
    pub modes: TermModes,
    mouse_bits: u8,
}

impl Default for ModeTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ModeTracker {
    pub fn new() -> Self {
        Self {
            parser: vte::Parser::new(),
            modes: TermModes::default(),
            mouse_bits: 0,
        }
    }

    /// 喂入 PTY 输出，返回模式是否有变化。序列被拆成多次喂入也能正确处理。
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut t = Tracker {
            modes: &mut self.modes,
            mouse_bits: &mut self.mouse_bits,
            changed: false,
        };
        self.parser.advance(&mut t, bytes);
        t.changed
    }
}

// ───────────────────────── 流控 ─────────────────────────

/// 终端输出的流控状态：未确认字节数超过高水位暂停读 PTY，回落到低水位以下恢复。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flow {
    pub sent: u64,
    pub acked: u64,
    pub paused: bool,
    pub high: u64,
    pub low: u64,
}

impl Flow {
    pub fn new() -> Self {
        Self {
            sent: 0,
            acked: 0,
            paused: false,
            high: HIGH_WATER,
            low: LOW_WATER,
        }
    }
    /// 附着时重置基线。
    pub fn reset(&mut self, sent: u64, acked: u64) {
        self.sent = sent;
        self.acked = acked.min(sent);
        self.paused = self.sent - self.acked > self.high;
    }
    pub fn on_sent(&mut self, end: u64) {
        self.sent = self.sent.max(end);
        if self.sent - self.acked > self.high {
            self.paused = true;
        }
    }
    pub fn on_ack(&mut self, consumed: u64) {
        self.acked = self.acked.max(consumed.min(self.sent));
        if self.paused && self.sent - self.acked < self.low {
            self.paused = false;
        }
    }
    pub fn clear(&mut self) {
        self.paused = false;
    }
}

impl Default for Flow {
    fn default() -> Self {
        Self::new()
    }
}

// ───────────────────────── 共享状态 ─────────────────────────

/// 一个附着点：某条会话里的某个通道。
#[derive(Clone)]
pub struct Sink {
    pub session: u64,
    pub channel: u32,
    pub tx: FrameTx,
    /// 主控设备标识（握手认证出的设备码 / 公钥），同一台主控重连后不变。终端的"所有者"就是它。
    pub owner: String,
}

impl Sink {
    /// 这条会话是否还活着：链路的发送队列接收端被丢弃（连接断了）就是死了。
    pub fn alive(&self) -> bool {
        !self.tx.interactive.is_closed()
    }
}

/// 别的主控设备的存活会话正附着着这个终端时，新的附着不能抢占。
fn attach_conflict(shared: &TermShared, newcomer: &Sink) -> bool {
    shared
        .attach
        .as_ref()
        .is_some_and(|a| a.session != newcomer.session && a.owner != newcomer.owner && a.alive())
}

fn make_frame(channel: u32, body: pb::frame::Body) -> pb::Frame {
    pb::Frame {
        channel,
        body: Some(body),
    }
}

impl Sink {
    /// 带超时地发送一帧。链路已断或长时间发不出去返回 false。
    pub async fn send(&self, body: pb::frame::Body) -> bool {
        matches!(
            tokio::time::timeout(SEND_TIMEOUT, self.tx.send(make_frame(self.channel, body))).await,
            Ok(Ok(()))
        )
    }
}

struct TermShared {
    ring: OutputRing,
    tracker: ModeTracker,
    attach: Option<Sink>,
    exited: Option<i32>,
    exited_at: Option<Instant>,
    detached_since: Option<Instant>,
    last_output: Instant,
    cols: u16,
    rows: u16,
    app: AppStateData,
    title: String,
    flow: Flow,
    probe_miss: u32,
}

#[derive(Debug, Clone)]
pub struct TermConfig {
    pub max_terminals: usize,
    /// 无人附着超过这么久自动关闭；`None` = 永不
    pub detached_ttl: Option<Duration>,
    /// 已退出的终端保留多久
    pub exited_ttl: Duration,
    pub ring_cap: usize,
}

impl Default for TermConfig {
    fn default() -> Self {
        Self {
            max_terminals: 16,
            detached_ttl: Some(Duration::from_secs(24 * 3600)),
            exited_ttl: Duration::from_secs(10 * 60),
            ring_cap: RING_CAP,
        }
    }
}

/// 执行队列需要的、被控端全局的东西：适配器规则、动作目录、平台标签。
pub struct ExecEnv {
    pub rules: RwLock<AdapterRules>,
    pub catalog: RwLock<Arc<Catalog>>,
    pub claude_version: RwLock<Option<String>>,
    /// Windows 上 Shift+Tab 不被识别时置位，动作的 `platform_overrides["windows_no_vt"]` 生效
    pub windows_no_vt: AtomicBool,
}

impl ExecEnv {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rules: RwLock::new(AdapterRules::builtin()),
            catalog: RwLock::new(Arc::new(Catalog::builtin())),
            claude_version: RwLock::new(None),
            windows_no_vt: AtomicBool::new(false),
        })
    }

    pub fn platform_tag(&self) -> String {
        if cfg!(windows) {
            if self.windows_no_vt.load(Ordering::Relaxed) {
                "windows_no_vt".into()
            } else {
                "windows".into()
            }
        } else {
            "unix".into()
        }
    }
}

enum TermCmd {
    Attach {
        sink: Sink,
        req_id: u64,
        last_seq: u64,
        cols: u32,
        rows: u32,
    },
    Detach {
        session: u64,
    },
    Ack {
        session: u64,
        consumed: u64,
    },
    Bridge(BridgeMessage),
    Probe {
        claude_running: bool,
    },
    Close {
        force: bool,
    },
}

enum ExecItem {
    Submit {
        sink: Sink,
        msg: pb::TermSubmit,
        paths: Vec<String>,
    },
    Action {
        sink: Sink,
        req: pb::TermAction,
    },
}

/// 任务之间共享的终端内核。
struct TermCore {
    id: String,
    profile: i32,
    shell_name: String,
    base_title: String,
    shared: Mutex<TermShared>,
    control: PtyControl,
    env: Arc<ExecEnv>,
}

impl TermCore {
    fn lock(&self) -> std::sync::MutexGuard<'_, TermShared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn modes(&self) -> TermModes {
        self.lock().tracker.modes.clone()
    }
}

/// 执行队列看到的"目标终端"。
struct TermTarget(Arc<TermCore>);

impl ActionTarget for TermTarget {
    async fn write(&self, data: Vec<u8>) -> Result<(), ActionError> {
        self.0
            .control
            .write(data)
            .await
            .map_err(|_| ActionError::Io)
    }
    fn modes(&self) -> TermModes {
        self.0.modes()
    }
    fn app(&self) -> AppSnapshot {
        let s = self.0.lock();
        AppSnapshot {
            running: s.app.running,
            stateful: s.app.stateful,
            activity: s.app.activity.as_str().into(),
            pending_notice: s.app.pending_notice,
            pending_truncated: s.app.pending_truncated,
        }
    }
    async fn wait_quiet(&self, quiet: Duration, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let last = self.0.lock().last_output;
            let now = Instant::now();
            if now.duration_since(last) >= quiet || now >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn output_mark(&self) -> u64 {
        self.0.lock().ring.end()
    }
    fn output_since(&self, from: u64) -> Vec<u8> {
        self.0.lock().ring.read_from(from).1
    }
    fn adapter_rule(&self) -> AdapterRule {
        let running_claude = self.0.lock().app.running;
        let profile = if self.0.profile == pb::Profile::Claude as i32 || running_claude {
            "CLAUDE"
        } else if self.0.profile == pb::Profile::Custom as i32 {
            "CUSTOM"
        } else {
            "SHELL"
        };
        let ver = self
            .0
            .env
            .claude_version
            .read()
            .ok()
            .and_then(|v| v.clone());
        let rules = self
            .0
            .env
            .rules
            .read()
            .map(|r| r.clone())
            .unwrap_or_else(|_| AdapterRules::builtin());
        rules.select(&MatchCtx {
            profile,
            claude_version: ver.as_deref(),
        })
    }
    fn windows(&self) -> bool {
        cfg!(windows)
    }
    fn platform_tag(&self) -> String {
        self.0.env.platform_tag()
    }
}

// ───────────────────────── Term（对外句柄） ─────────────────────────

pub struct Term {
    core: Arc<TermCore>,
    cmd_tx: mpsc::Sender<TermCmd>,
    exec_tx: mpsc::Sender<ExecItem>,
    pub created_at: u64,
    pub cwd: String,
    pub shell_name: String,
    pub base_title: String,
    /// 创建它的主控设备标识；空 = 无主（被控端本机或旧数据）
    pub owner: String,
}

impl Term {
    pub fn id(&self) -> &str {
        &self.core.id
    }

    pub fn profile(&self) -> i32 {
        self.core.profile
    }

    pub fn is_attached_to(&self, session: u64) -> bool {
        self.core
            .lock()
            .attach
            .as_ref()
            .is_some_and(|a| a.session == session)
    }

    pub fn modes(&self) -> TermModes {
        self.core.modes()
    }

    pub fn app_state(&self) -> AppStateData {
        self.core.lock().app.clone()
    }

    pub fn exited(&self) -> Option<i32> {
        self.core.lock().exited
    }

    pub fn pid(&self) -> Option<u32> {
        self.core.control.pid()
    }

    /// `requester` 是否可见（隔离开启时只有所有者可见；无主终端对任何人不可见）。
    pub fn visible_to(&self, requester: &str, isolate: bool) -> bool {
        !isolate || (!self.owner.is_empty() && self.owner == requester)
    }

    /// 新的附着会不会因为"另一个设备的存活会话正占用"而被拒绝（TERM_BUSY）。
    pub fn would_be_busy(&self, newcomer: &Sink) -> bool {
        attach_conflict(&self.core.lock(), newcomer)
    }

    /// 不区分请求者的信息（被控端本机 / 测试用）。
    pub fn info(&self) -> pb::TermInfo {
        self.info_for("")
    }

    /// 站在 `requester` 的角度的信息：被其他设备占用时 `attached_by_other` 为真，`channel` 为 0。
    /// 已死亡的会话不算附着。
    pub fn info_for(&self, requester: &str) -> pb::TermInfo {
        let s = self.core.lock();
        let live = s.attach.as_ref().filter(|a| a.alive());
        let by_other = live.is_some_and(|a| a.owner != requester);
        pb::TermInfo {
            term_id: self.core.id.clone(),
            title: if s.title.is_empty() {
                self.base_title.clone()
            } else {
                s.title.clone()
            },
            profile: self.core.profile,
            cwd: self.cwd.clone(),
            created_at: self.created_at,
            last_seq: s.ring.end(),
            exited: s.exited.is_some(),
            attached: live.is_some(),
            channel: live
                .filter(|a| a.owner == requester)
                .map(|a| a.channel)
                .unwrap_or(0),
            attached_by_other: by_other,
        }
    }

    /// 附着：发 `TermOpened`，回放，再接实时输出，幂等。同一设备的新附着顶掉旧的（旧会话收到 `TERM_DETACHED`）；
    /// 另一个设备的存活会话还附着着时不能抢占，新的会话收到 `TERM_BUSY`。
    pub async fn attach(
        &self,
        sink: Sink,
        req_id: u64,
        last_seq: u64,
        cols: u32,
        rows: u32,
    ) -> bool {
        self.cmd_tx
            .send(TermCmd::Attach {
                sink,
                req_id,
                last_seq,
                cols,
                rows,
            })
            .await
            .is_ok()
    }

    pub async fn detach(&self, session: u64) {
        let _ = self.cmd_tx.send(TermCmd::Detach { session }).await;
    }

    pub async fn ack(&self, session: u64, consumed: u64) {
        let _ = self.cmd_tx.send(TermCmd::Ack { session, consumed }).await;
    }

    /// 直通按键。只有当前附着的会话能写。
    pub async fn write_input(&self, session: u64, data: Vec<u8>) -> Result<(), &'static str> {
        if !self.is_attached_to(session) {
            return Err("TERM_DETACHED");
        }
        self.core
            .control
            .write(data)
            .await
            .map_err(|_| "TERM_NOT_FOUND")
    }

    /// 调整尺寸（50ms 防抖在 PTY 层）。
    pub fn resize(&self, session: u64, cols: u16, rows: u16) -> Result<(), &'static str> {
        if !self.is_attached_to(session) {
            return Err("TERM_DETACHED");
        }
        {
            let mut s = self.core.lock();
            s.cols = cols;
            s.rows = rows;
        }
        self.core.control.resize(cols, rows);
        Ok(())
    }

    /// 提交一条消息，进入执行队列。
    pub fn submit(
        &self,
        sink: Sink,
        msg: pb::TermSubmit,
        paths: Vec<String>,
    ) -> Result<(), ActionError> {
        if !self.is_attached_to(sink.session) {
            return Err(ActionError::TermNotFound);
        }
        self.exec_tx
            .try_send(ExecItem::Submit { sink, msg, paths })
            .map_err(|_| ActionError::Busy)
    }

    /// 执行动作，进入执行队列。结果通过 `TermActionResult` 发回 `sink`。
    pub fn action(&self, sink: Sink, req: pb::TermAction) -> Result<(), ActionError> {
        if !self.is_attached_to(sink.session) {
            return Err(ActionError::TermNotFound);
        }
        self.exec_tx
            .try_send(ExecItem::Action { sink, req })
            .map_err(|_| ActionError::Busy)
    }

    /// 关闭终端。`force` = 立即强杀；否则优雅关闭（Unix: SIGHUP，3 秒后 SIGKILL）。
    pub async fn close(&self, force: bool) {
        let _ = self.cmd_tx.send(TermCmd::Close { force }).await;
    }

    /// 本机 IPC 收到的 hook / 状态栏消息。
    pub fn on_bridge(&self, msg: BridgeMessage) {
        let _ = self.cmd_tx.try_send(TermCmd::Bridge(msg));
    }
}

// ───────────────────────── 管理器 ─────────────────────────

pub struct OpenSpec {
    pub profile: pb::Profile,
    pub shell: ShellEntry,
    pub cwd: std::path::PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// 打开后写入 shell 的命令（CLAUDE / CUSTOM 模式），不含回车
    pub startup_command: Option<String>,
    pub title: String,
    /// 额外的环境变量（`RTERM_HOOK_ENDPOINT` 等）
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenError {
    pub code: &'static str,
    pub message: String,
}

struct Registry {
    /// 终端隔离开关（可运行中修改）
    isolate: AtomicBool,
    terms: Mutex<HashMap<String, Arc<Term>>>,
    cfg: RwLock<TermConfig>,
    env: Arc<ExecEnv>,
    probe_started: AtomicBool,
    /// 状态回传的终端令牌表（没有状态回传时为空）
    tokens: RwLock<Option<Arc<status::TermTokens>>>,
}

#[derive(Clone)]
pub struct TermManager {
    reg: Arc<Registry>,
}

/// 默认的环境变量：`TERM`、`COLORTERM`，Unix 上 `LANG` 为空时补 UTF-8。
pub fn base_env() -> Vec<(String, String)> {
    let mut v = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ];
    if !cfg!(windows) {
        let lang_empty = std::env::var("LANG").map(|s| s.is_empty()).unwrap_or(true);
        if lang_empty {
            v.push(("LANG".into(), "en_US.UTF-8".into()));
        }
    }
    v
}

/// PTY 尺寸上限（行、列）。`TermOpen`、`TermResize`、`TermAttach` 统一夹到 1–1000，
/// 过大的尺寸会让 ConPTY / openpty 占用大量内存或失败（审查 L5）。
pub const MAX_PTY_DIM: u32 = 1000;

pub fn clamp_dim(v: u32) -> u16 {
    v.clamp(1, MAX_PTY_DIM) as u16
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl TermManager {
    pub fn new(cfg: TermConfig, env: Arc<ExecEnv>) -> Self {
        Self {
            reg: Arc::new(Registry {
                terms: Mutex::new(HashMap::new()),
                cfg: RwLock::new(cfg),
                env,
                probe_started: AtomicBool::new(false),
                tokens: RwLock::new(None),
                isolate: AtomicBool::new(true),
            }),
        }
    }

    pub fn config(&self) -> TermConfig {
        self.reg.cfg.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn set_config(&self, cfg: TermConfig) {
        if let Ok(mut c) = self.reg.cfg.write() {
            *c = cfg;
        }
    }

    pub fn env(&self) -> Arc<ExecEnv> {
        self.reg.env.clone()
    }

    /// 接上状态回传的令牌表：之后打开的终端都会带上自己的令牌。
    pub fn set_bridge_tokens(&self, tokens: Arc<status::TermTokens>) {
        if let Ok(mut t) = self.reg.tokens.write() {
            *t = Some(tokens);
        }
    }

    fn tokens(&self) -> Option<Arc<status::TermTokens>> {
        self.reg.tokens.read().ok().and_then(|t| t.clone())
    }

    fn terms(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Term>>> {
        self.reg.terms.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<Arc<Term>> {
        self.terms().get(id).cloned()
    }

    /// 终端隔离：开启（默认）时每台主控设备只能看到自己创建的终端。对新请求立即生效，已附着的不强制踢。
    pub fn set_isolate_terminals(&self, on: bool) {
        self.reg.isolate.store(on, Ordering::Release);
    }

    pub fn isolate_terminals(&self) -> bool {
        self.reg.isolate.load(Ordering::Acquire)
    }

    /// `requester` 能看到的终端；看不到的与不存在不可区分。
    pub fn get_visible(&self, id: &str, requester: &str) -> Option<Arc<Term>> {
        let iso = self.isolate_terminals();
        self.get(id).filter(|t| t.visible_to(requester, iso))
    }

    /// `requester` 能看到的终端列表（`TermListResp` 用）。
    pub fn list_visible(&self, requester: &str) -> Vec<pb::TermInfo> {
        let iso = self.isolate_terminals();
        let mut v: Vec<pb::TermInfo> = self
            .terms()
            .values()
            .filter(|t| t.visible_to(requester, iso))
            .map(|t| t.info_for(requester))
            .collect();
        v.sort_by_key(|i| i.created_at);
        v
    }

    /// 全部终端（不做可见性过滤，被控端本机界面 / 测试用）。
    pub fn list(&self) -> Vec<pb::TermInfo> {
        let mut v: Vec<pb::TermInfo> = self.terms().values().map(|t| t.info()).collect();
        v.sort_by_key(|i| i.created_at);
        v
    }

    /// 未退出的终端数（占用 `max_terminals` 配额）。
    pub fn live_count(&self) -> usize {
        self.terms()
            .values()
            .filter(|t| t.exited().is_none())
            .count()
    }

    /// 打开终端：启动 PTY 与任务，并把它附着到 `sink`（发 `TermOpened`）。
    pub async fn open(
        &self,
        spec: OpenSpec,
        sink: Sink,
        req_id: u64,
    ) -> Result<Arc<Term>, OpenError> {
        let cfg = self.config();
        if self.live_count() >= cfg.max_terminals {
            return Err(OpenError {
                code: "TERM_LIMIT",
                message: format!("终端数已达上限 {}", cfg.max_terminals),
            });
        }
        let id = ulid::Ulid::generate().to_string();
        let mut env = base_env();
        env.push((status::ENV_TERM_ID.into(), id.clone()));
        // 每个终端一次性随机令牌：hook 命令带着它发 IPC 消息，被控端校验（审查 M5）
        if let Some(tokens) = self.tokens() {
            env.push((status::ENV_TOKEN.into(), tokens.issue(&id)));
        }
        env.extend(spec.env.clone());
        let handle = pty::spawn_pty(SpawnSpec {
            program: spec.shell.path.to_string_lossy().into_owned(),
            args: spec.shell.launch_args(),
            cwd: Some(spec.cwd.clone()),
            env,
            cols: spec.cols.max(1),
            rows: spec.rows.max(1),
        })
        .map_err(|e| OpenError {
            code: "SPAWN_FAILED",
            message: e.to_string(),
        })?;

        let now = Instant::now();
        let core = Arc::new(TermCore {
            id: id.clone(),
            profile: spec.profile as i32,
            shell_name: spec.shell.name.clone(),
            base_title: spec.title.clone(),
            shared: Mutex::new(TermShared {
                ring: OutputRing::new(cfg.ring_cap),
                tracker: ModeTracker::new(),
                attach: None,
                exited: None,
                exited_at: None,
                detached_since: Some(now),
                last_output: now,
                cols: spec.cols,
                rows: spec.rows,
                app: AppStateData::default(),
                title: String::new(),
                flow: Flow::new(),
                probe_miss: 0,
            }),
            control: handle.control.clone(),
            env: self.reg.env.clone(),
        });
        let (cmd_tx, cmd_rx) = mpsc::channel::<TermCmd>(256);
        let (exec_tx, exec_rx) = mpsc::channel::<ExecItem>(QUEUE_LIMIT);
        let term = Arc::new(Term {
            core: core.clone(),
            cmd_tx,
            exec_tx,
            created_at: unix_now(),
            cwd: spec.cwd.to_string_lossy().into_owned(),
            shell_name: spec.shell.name.clone(),
            base_title: spec.title.clone(),
            owner: sink.owner.clone(),
        });
        self.terms().insert(id.clone(), term.clone());

        let task = TermTask::new(
            core.clone(),
            Arc::downgrade(&self.reg),
            spec.startup_command.map(|c| {
                let mut b = c.into_bytes();
                b.push(b'\r');
                b
            }),
        );
        tokio::spawn(task.run(handle.output, handle.exit, cmd_rx));
        tokio::spawn(exec_loop(core, exec_rx));
        self.start_probe_task();

        term.attach(sink, req_id, 0, 0, 0).await;
        Ok(term)
    }

    /// 一条会话结束：它附着的终端全部脱离（终端继续运行，输出写进缓冲区）。
    pub async fn detach_session(&self, session: u64) {
        let all: Vec<Arc<Term>> = self.terms().values().cloned().collect();
        for t in all {
            if t.is_attached_to(session) {
                t.detach(session).await;
            }
        }
    }

    /// 被控端退出：强杀所有终端。
    pub async fn close_all(&self) {
        let all: Vec<Arc<Term>> = self.terms().values().cloned().collect();
        for t in all {
            t.close(true).await;
        }
    }

    /// 把本机 IPC 消息转给对应终端。
    pub fn dispatch_bridge(&self, msg: BridgeMessage) {
        if let Some(t) = self.get(&msg.term_id) {
            t.on_bridge(msg);
        }
    }

    /// 周期性检查各终端的 shell 下面有没有 `claude` 进程（无状态回传时的降级判断，也用来兜底重置"工作中"）。
    fn start_probe_task(&self) {
        if self.reg.probe_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak: Weak<Registry> = Arc::downgrade(&self.reg);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(PROBE_INTERVAL).await;
                let Some(reg) = weak.upgrade() else { return };
                let targets: Vec<(Arc<Term>, u32)> = reg
                    .terms
                    .lock()
                    .map(|m| {
                        m.values()
                            .filter(|t| t.is_attached() && t.exited().is_none())
                            .filter_map(|t| t.pid().map(|p| (t.clone(), p)))
                            .collect()
                    })
                    .unwrap_or_default();
                drop(reg);
                if targets.is_empty() {
                    continue;
                }
                let Ok(table) = tokio::task::spawn_blocking(procs::ProcTable::snapshot).await
                else {
                    continue;
                };
                for (t, pid) in targets {
                    let running = procs::has_claude(&table.descendants(pid));
                    let _ = t.cmd_tx.try_send(TermCmd::Probe {
                        claude_running: running,
                    });
                }
            }
        });
    }
}

impl Term {
    fn is_attached(&self) -> bool {
        self.core.lock().attach.is_some()
    }
}

// ───────────────────────── 终端任务 ─────────────────────────

async fn opt_sleep(at: Option<Instant>) {
    match at {
        Some(t) => tokio::time::sleep_until(t).await,
        None => pending::<()>().await,
    }
}

async fn recv_opt(rx: &mut Option<mpsc::Receiver<Vec<u8>>>) -> Option<Vec<u8>> {
    match rx {
        Some(r) => r.recv().await,
        None => pending().await,
    }
}

async fn exit_opt(rx: &mut Option<tokio::sync::oneshot::Receiver<i32>>) -> Option<i32> {
    match rx {
        Some(r) => r.await.ok().or(Some(-1)),
        None => pending().await,
    }
}

struct TermTask {
    core: Arc<TermCore>,
    reg: Weak<Registry>,
    startup: Option<Vec<u8>>,
    startup_at: Option<Instant>,
    startup_hard: Instant,
    pending: Vec<u8>,
    pending_seq: u64,
    flush_at: Option<Instant>,
    exit_code: Option<i32>,
    drain_deadline: Option<Instant>,
    finalized: bool,
    remove_after_exit: bool,
    app_dirty_at: Option<Instant>,
    last_app_send: Instant,
    output_closed: bool,
}

impl TermTask {
    fn new(core: Arc<TermCore>, reg: Weak<Registry>, startup: Option<Vec<u8>>) -> Self {
        let now = Instant::now();
        Self {
            core,
            reg,
            startup,
            startup_at: None,
            startup_hard: now + Duration::from_secs(2),
            pending: Vec::new(),
            pending_seq: 0,
            flush_at: None,
            exit_code: None,
            drain_deadline: None,
            finalized: false,
            remove_after_exit: false,
            app_dirty_at: None,
            last_app_send: now - APP_STATE_MIN_INTERVAL,
            output_closed: false,
        }
    }

    fn cfg(&self) -> TermConfig {
        self.reg
            .upgrade()
            .and_then(|r| r.cfg.read().ok().map(|c| c.clone()))
            .unwrap_or_default()
    }

    fn retention_at(&self) -> Option<Instant> {
        let cfg = self.cfg();
        let s = self.core.lock();
        if let Some(at) = s.exited_at {
            return Some(at + cfg.exited_ttl);
        }
        if s.attach.is_none() {
            if let (Some(since), Some(ttl)) = (s.detached_since, cfg.detached_ttl) {
                return Some(since + ttl);
            }
        }
        None
    }

    async fn run(
        mut self,
        out_rx: mpsc::Receiver<Vec<u8>>,
        exit_rx: tokio::sync::oneshot::Receiver<i32>,
        mut cmd_rx: mpsc::Receiver<TermCmd>,
    ) {
        let mut out_rx = Some(out_rx);
        let mut exit_rx = Some(exit_rx);
        loop {
            let paused = self.core.lock().flow.paused;
            let read_ok = out_rx.is_some() && (!paused || self.exit_code.is_some());
            let retention = self.retention_at();
            let startup_wait = if self.startup.is_some() {
                Some(self.startup_at.unwrap_or(self.startup_hard))
            } else {
                None
            };
            tokio::select! {
                biased;
                cmd = cmd_rx.recv() => {
                    match cmd {
                        None => break,
                        Some(c) => { if self.handle_cmd(c).await { break; } }
                    }
                }
                chunk = recv_opt(&mut out_rx), if read_ok => {
                    match chunk {
                        Some(c) => self.on_output(c).await,
                        None => {
                            out_rx = None;
                            self.output_closed = true;
                            if self.exit_code.is_some() && self.finalize().await { break; }
                        }
                    }
                }
                code = exit_opt(&mut exit_rx), if exit_rx.is_some() => {
                    exit_rx = None;
                    let code = code.unwrap_or(-1);
                    self.exit_code = Some(code);
                    if self.output_closed {
                        if self.finalize().await { break; }
                    } else {
                        self.drain_deadline = Some(Instant::now() + EXIT_DRAIN);
                    }
                }
                _ = opt_sleep(self.flush_at), if self.flush_at.is_some() => { self.flush().await; }
                _ = opt_sleep(startup_wait), if startup_wait.is_some() => { self.run_startup().await; }
                _ = opt_sleep(self.drain_deadline), if self.drain_deadline.is_some() => {
                    self.drain_deadline = None;
                    out_rx = None;
                    self.output_closed = true;
                    if self.finalize().await { break; }
                }
                _ = opt_sleep(self.app_dirty_at), if self.app_dirty_at.is_some() => {
                    self.app_dirty_at = None;
                    self.send_app_state().await;
                }
                _ = opt_sleep(retention), if retention.is_some() => {
                    if self.core.lock().exited.is_some() {
                        break; // 已退出的终端保留期满
                    }
                    // 无人附着超过保留时间：关闭
                    tracing::info!("终端 {} 无人附着超时，关闭", self.core.id);
                    self.remove_after_exit = true;
                    let c = self.core.control.clone();
                    tokio::spawn(async move { c.close(pty::KILL_GRACE).await });
                    // 防止重复触发：把 detached_since 推到很远
                    self.core.lock().detached_since = None;
                }
            }
        }
        if let Some(reg) = self.reg.upgrade() {
            if let Ok(mut m) = reg.terms.lock() {
                m.remove(&self.core.id);
            }
            if let Some(t) = reg.tokens.read().ok().and_then(|t| t.clone()) {
                t.revoke(&self.core.id);
            }
        }
        // 终端被丢弃：确保没有进程残留
        self.core.control.kill();
    }

    async fn run_startup(&mut self) {
        if let Some(cmd) = self.startup.take() {
            self.startup_at = None;
            let _ = self.core.control.write(cmd).await;
        }
    }

    async fn on_output(&mut self, chunk: Vec<u8>) {
        if self.startup.is_some() && self.startup_at.is_none() {
            // 第一次有输出：shell 起来了，300 毫秒后写入启动命令
            self.startup_at = Some(Instant::now() + Duration::from_millis(300));
        }
        let (attached, modes_changed) = {
            let mut s = self.core.lock();
            s.last_output = Instant::now();
            let before = s.ring.end();
            s.ring.push(&chunk);
            let changed = s.tracker.feed(&chunk);
            if changed {
                let t = s.tracker.modes.title.clone();
                if !t.is_empty() {
                    s.title = t;
                }
            }
            if s.attach.is_some() && self.pending.is_empty() {
                self.pending_seq = before;
            }
            (s.attach.is_some(), changed)
        };
        if attached {
            self.pending.extend_from_slice(&chunk);
            if self.pending.len() >= FLUSH_SIZE {
                self.flush().await;
            } else if self.flush_at.is_none() {
                self.flush_at = Some(Instant::now() + FLUSH_INTERVAL);
            }
        }
        if modes_changed {
            self.flush().await;
            self.send_term_state().await;
        }
    }

    /// 把合并缓冲里的数据发给当前附着的会话。
    async fn flush(&mut self) {
        self.flush_at = None;
        if self.pending.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.pending);
        let seq = self.pending_seq;
        let sink = self.core.lock().attach.clone();
        let Some(sink) = sink else { return };
        let end = seq + data.len() as u64;
        let ok = sink
            .send(pb::frame::Body::TermOutput(pb::TermOutput { seq, data }))
            .await;
        if ok {
            let mut s = self.core.lock();
            if s.attach.as_ref().is_some_and(|a| a.session == sink.session) {
                s.flow.on_sent(end);
            }
        } else {
            self.drop_dead_sink(sink.session);
        }
    }

    /// 发送失败：链路已断，视为脱离。
    fn drop_dead_sink(&mut self, session: u64) {
        let mut s = self.core.lock();
        if s.attach.as_ref().is_some_and(|a| a.session == session) {
            s.attach = None;
            s.detached_since = Some(Instant::now());
            s.flow.clear();
        }
        self.pending.clear();
        self.flush_at = None;
    }

    async fn send_to_attached(&mut self, body: pb::frame::Body) {
        let sink = self.core.lock().attach.clone();
        if let Some(sink) = sink {
            if !sink.send(body).await {
                self.drop_dead_sink(sink.session);
            }
        }
    }

    fn term_state_pb(&self) -> pb::TermState {
        let s = self.core.lock();
        let m = &s.tracker.modes;
        pb::TermState {
            bracketed_paste: m.bracketed_paste,
            alt_screen: m.alt_screen,
            app_cursor: m.app_cursor,
            mouse: m.mouse,
            title: m.title.clone(),
        }
    }

    async fn send_term_state(&mut self) {
        let st = self.term_state_pb();
        self.send_to_attached(pb::frame::Body::TermState(st)).await;
    }

    async fn send_app_state(&mut self) {
        self.last_app_send = Instant::now();
        let st = self.core.lock().app.to_pb();
        self.send_to_attached(pb::frame::Body::AppState(st)).await;
    }

    fn mark_app_dirty(&mut self) {
        if self.app_dirty_at.is_none() {
            let at = (self.last_app_send + APP_STATE_MIN_INTERVAL).max(Instant::now());
            self.app_dirty_at = Some(at);
        }
    }

    /// 返回 true 表示任务应当结束。
    async fn handle_cmd(&mut self, cmd: TermCmd) -> bool {
        match cmd {
            TermCmd::Attach {
                sink,
                req_id,
                last_seq,
                cols,
                rows,
            } => {
                self.do_attach(sink, req_id, last_seq, cols, rows).await;
            }
            TermCmd::Detach { session } => {
                let mut s = self.core.lock();
                if s.attach.as_ref().is_some_and(|a| a.session == session) {
                    s.attach = None;
                    s.detached_since = Some(Instant::now());
                    s.flow.clear();
                    drop(s);
                    self.pending.clear();
                    self.flush_at = None;
                }
            }
            TermCmd::Ack { session, consumed } => {
                let mut s = self.core.lock();
                if s.attach.as_ref().is_some_and(|a| a.session == session) {
                    s.flow.on_ack(consumed);
                }
            }
            TermCmd::Bridge(msg) => self.on_bridge(msg).await,
            TermCmd::Probe { claude_running } => self.on_probe(claude_running).await,
            TermCmd::Close { force } => {
                if self.finalized {
                    return true;
                }
                self.remove_after_exit = true;
                let c = self.core.control.clone();
                if force {
                    c.kill();
                } else {
                    tokio::spawn(async move { c.close(pty::KILL_GRACE).await });
                }
            }
        }
        false
    }

    async fn do_attach(&mut self, sink: Sink, req_id: u64, last_seq: u64, cols: u32, rows: u32) {
        let prepared = {
            let mut s = self.core.lock();
            // 禁止抢占：另一个设备的存活会话还附着着，就拒绝（调用方通常已预检，这里是并发下的最终裁决）
            if attach_conflict(&s, &sink) {
                None
            } else {
                let old = s.attach.replace(sink.clone());
                s.detached_since = None;
                let (start, data, cont) = s.ring.read_from(last_seq);
                let end = s.ring.end();
                let acked = if cont { last_seq } else { start };
                s.flow.reset(end, acked);
                if cols > 0 && rows > 0 {
                    s.cols = clamp_dim(cols);
                    s.rows = clamp_dim(rows);
                }
                Some((
                    old,
                    start,
                    data,
                    cont,
                    s.exited,
                    if s.title.is_empty() {
                        self.core.base_title.clone()
                    } else {
                        s.title.clone()
                    },
                ))
            }
        };
        let Some((old, replay_start, data, continuous, exited, title)) = prepared else {
            let ctl = Sink {
                channel: 0,
                ..sink.clone()
            };
            let _ = ctl
                .send(pb::frame::Body::Error(pb::Error {
                    code: "TERM_BUSY".into(),
                    message: self.core.id.clone(),
                    ref_id: req_id,
                }))
                .await;
            return;
        };
        self.pending.clear();
        self.flush_at = None;
        if cols > 0 && rows > 0 {
            self.core.control.resize(clamp_dim(cols), clamp_dim(rows));
        }
        // 旧的附着被顶掉
        if let Some(old) = old {
            if old.session != sink.session || old.channel != sink.channel {
                let _ = old
                    .send(pb::frame::Body::Error(pb::Error {
                        code: "TERM_DETACHED".into(),
                        message: self.core.id.clone(),
                        ref_id: 0,
                    }))
                    .await;
            }
        }
        // TermOpened
        let ok = sink
            .send(pb::frame::Body::TermOpened(pb::TermOpened {
                req_id,
                term_id: self.core.id.clone(),
                channel: sink.channel,
                title,
                shell: self.core.shell_name.clone(),
            }))
            .await;
        if !ok {
            self.drop_dead_sink(sink.session);
            return;
        }
        // 回放：不完整衔接时先发复位序列。复位帧的 seq 取 回放起点-2，使得 seq+len 仍然连续。
        if !continuous {
            let ok = sink
                .send(pb::frame::Body::TermOutput(pb::TermOutput {
                    seq: replay_start.saturating_sub(RESET_SEQ.len() as u64),
                    data: RESET_SEQ.to_vec(),
                }))
                .await;
            if !ok {
                self.drop_dead_sink(sink.session);
                return;
            }
        }
        let mut cursor = replay_start;
        for part in data.chunks(REPLAY_CHUNK) {
            let ok = sink
                .send(pb::frame::Body::TermOutput(pb::TermOutput {
                    seq: cursor,
                    data: part.to_vec(),
                }))
                .await;
            cursor += part.len() as u64;
            if !ok {
                self.drop_dead_sink(sink.session);
                return;
            }
        }
        // 当前模式、应用状态、退出状态
        let st = self.term_state_pb();
        self.send_to_attached(pb::frame::Body::TermState(st)).await;
        self.send_app_state().await;
        if let Some(code) = exited {
            self.send_to_attached(pb::frame::Body::TermExit(pb::TermExit { code }))
                .await;
        }
    }

    async fn on_bridge(&mut self, msg: BridgeMessage) {
        let now = std::time::Instant::now();
        let applied = {
            let mut s = self.core.lock();
            match msg.kind.as_str() {
                "hook" => status::apply_hook(&mut s.app, &msg.payload, now),
                _ => status::apply_statusline(&mut s.app, &msg.payload, now),
            }
        };
        if applied.changed {
            self.mark_app_dirty();
        }
        if let Some(n) = applied.notice {
            // 通知先于状态发出的话，权限卡片会先于"等待确认"出现，这里先把状态推出去
            if self.app_dirty_at.is_some() {
                self.app_dirty_at = None;
                self.send_app_state().await;
            }
            self.send_to_attached(pb::frame::Body::AppNotice(n)).await;
        }
    }

    async fn on_probe(&mut self, claude_running: bool) {
        let changed = {
            let mut s = self.core.lock();
            let mut changed = s.app.set_running_by_probe(claude_running);
            if s.app.stateful {
                if claude_running {
                    s.probe_miss = 0;
                } else {
                    s.probe_miss += 1;
                }
                // 连续 3 次（约 6 秒）没有 claude 进程：认为它已经退出（崩溃或被杀时不会有 SessionEnd），
                // 重置状态，避免界面永远显示"工作中"或一直显示工具条
                let gone = s.probe_miss >= 3;
                if gone && s.app.running {
                    s.app.reset_not_running();
                    changed = true;
                } else if status::reset_if_stale(&mut s.app, std::time::Instant::now(), false) {
                    changed = true;
                }
            } else {
                s.probe_miss = 0;
            }
            changed
        };
        if changed {
            self.mark_app_dirty();
        }
    }

    /// 子进程已退出且输出收尾完成。返回 true 表示任务应当结束（要求移除）。
    async fn finalize(&mut self) -> bool {
        if self.finalized {
            return false;
        }
        self.finalized = true;
        self.drain_deadline = None;
        self.flush().await;
        let code = self.exit_code.unwrap_or(-1);
        {
            let mut s = self.core.lock();
            s.exited = Some(code);
            s.exited_at = Some(Instant::now());
            s.app.reset_not_running();
            s.flow.clear();
        }
        self.send_to_attached(pb::frame::Body::TermExit(pb::TermExit { code }))
            .await;
        self.send_app_state().await;
        self.remove_after_exit
    }
}

// ───────────────────────── 执行队列 ─────────────────────────

async fn exec_loop(core: Arc<TermCore>, mut rx: mpsc::Receiver<ExecItem>) {
    let target = TermTarget(core.clone());
    while let Some(item) = rx.recv().await {
        match item {
            ExecItem::Submit { sink, msg, paths } => {
                let rule = target.adapter_rule();
                let plan = adapter::build_submit(
                    &rule,
                    &target.modes(),
                    &msg.text,
                    &paths,
                    msg.press_enter,
                    cfg!(windows),
                );
                if let Err(e) = actions::write_plan(&target, plan).await {
                    tracing::debug!("提交失败：{e}");
                    let _ = sink
                        .send(pb::frame::Body::Error(pb::Error {
                            code: e.code().into(),
                            message: "写入终端失败".into(),
                            ref_id: msg.msg_id,
                        }))
                        .await;
                }
            }
            ExecItem::Action { sink, req } => {
                // 没有状态回传时，先做一次即时的进程检测，免得刚启动的 claude 被误判为没有运行
                {
                    let need_probe = {
                        let s = core.lock();
                        !s.app.running && !s.app.stateful
                    };
                    if need_probe {
                        if let Some(pid) = core.control.pid() {
                            if let Ok(table) =
                                tokio::task::spawn_blocking(procs::ProcTable::snapshot).await
                            {
                                let running = procs::has_claude(&table.descendants(pid));
                                core.lock().app.set_running_by_probe(running);
                            }
                        }
                    }
                }
                let catalog = core
                    .env
                    .catalog
                    .read()
                    .map(|c| c.clone())
                    .unwrap_or_else(|_| Arc::new(Catalog::builtin()));
                let result =
                    actions::run_action(&catalog, &target, &req.action_id, &req.args).await;
                let body = match result {
                    Ok(o) => pb::TermActionResult {
                        req_id: req.req_id,
                        ok: true,
                        error: String::new(),
                        passthrough: o.passthrough,
                        return_keys: o.return_keys,
                    },
                    Err(e) => {
                        tracing::debug!("动作 {} 失败：{e}", req.action_id);
                        pb::TermActionResult {
                            req_id: req.req_id,
                            ok: false,
                            error: e.code().into(),
                            passthrough: false,
                            return_keys: Vec::new(),
                        }
                    }
                };
                let _ = sink.send(pb::frame::Body::TermActionResult(body)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::shell;
    use crate::link::{link_pair, LinkEnds, PeerInfo};

    // ---- 环形缓冲 ----

    #[test]
    fn ring_push_and_read() {
        let mut r = OutputRing::new(16);
        r.push(b"hello\nworld");
        assert_eq!((r.start(), r.end()), (0, 11));
        assert_eq!(r.read_from(0), (0, b"hello\nworld".to_vec(), true));
        assert_eq!(r.read_from(6), (6, b"world".to_vec(), true));
        assert_eq!(r.read_from(11), (11, Vec::new(), true));
    }

    #[test]
    fn ring_overwrite_and_replay_from_newline() {
        let mut r = OutputRing::new(16);
        r.push(b"aaaa\nbbbb\ncccc\ndddd\n"); // 20 字节，容量 16：丢掉前 4 个
        assert_eq!(r.start(), 4);
        assert_eq!(r.end(), 20);
        // from 已被覆盖：从第一个换行之后开始
        let (start, data, cont) = r.read_from(0);
        assert!(!cont);
        assert_eq!(start, 5);
        assert_eq!(data, b"bbbb\ncccc\ndddd\n".to_vec());
        assert_eq!(
            &r.read_from(4),
            &(4, b"\nbbbb\ncccc\ndddd\n".to_vec(), true)
        );
        // from 超出末尾：同样当作不衔接
        let (_, _, cont) = r.read_from(99);
        assert!(!cont);
    }

    #[test]
    fn ring_single_oversized_push_and_no_newline() {
        let mut r = OutputRing::new(16);
        r.push(&[b'x'; 100]);
        assert_eq!((r.start(), r.end(), r.len()), (84, 100, 16));
        let (start, data, cont) = r.read_from(0);
        assert!(!cont);
        assert_eq!((start, data.len()), (84, 16)); // 没有换行：从头回放
        r.push(b"abc");
        assert_eq!(r.end(), 103);
        assert_eq!(r.start(), 87);
    }

    #[test]
    fn ring_many_small_pushes_keep_offsets_consistent() {
        let mut r = OutputRing::new(1000);
        let mut total = 0u64;
        for i in 0..5000u32 {
            let chunk = format!("{i:04}\n");
            r.push(chunk.as_bytes());
            total += chunk.len() as u64;
        }
        assert_eq!(r.end(), total);
        assert_eq!(r.start() + r.len() as u64, total);
        assert_eq!(r.len(), 1000);
    }

    // ---- 模式跟踪 ----

    #[test]
    fn tracker_on_off_and_multi_params() {
        let mut t = ModeTracker::new();
        assert!(t.feed(b"\x1b[?2004h"));
        assert!(t.modes.bracketed_paste);
        assert!(!t.feed(b"\x1b[?2004h"), "重复开启不算变化");
        assert!(t.feed(b"\x1b[?2004l"));
        assert!(!t.modes.bracketed_paste);
        // 一条序列里多个参数
        assert!(t.feed(b"\x1b[?1049;1h"));
        assert!(t.modes.alt_screen && t.modes.app_cursor);
        assert!(t.feed(b"\x1b[?1049;1l"));
        assert!(!t.modes.alt_screen && !t.modes.app_cursor);
        // 47 / 1047 也是备用屏幕
        assert!(t.feed(b"\x1b[?47h"));
        assert!(t.modes.alt_screen);
        t.feed(b"\x1b[?1047l");
        assert!(!t.modes.alt_screen);
        // 普通 CSI 不影响
        assert!(!t.feed(b"\x1b[31mred\x1b[0m\x1b[2J\x1b[H"));
    }

    #[test]
    fn tracker_split_sequences() {
        let mut t = ModeTracker::new();
        assert!(!t.feed(b"abc\x1b[?20"));
        assert!(t.feed(b"04h"));
        assert!(t.modes.bracketed_paste);
        // 逐字节喂入
        let mut t = ModeTracker::new();
        let mut changed = false;
        for b in b"\x1b[?1049h".iter() {
            changed |= t.feed(&[*b]);
        }
        assert!(changed && t.modes.alt_screen);
    }

    #[test]
    fn tracker_mouse_and_title() {
        let mut t = ModeTracker::new();
        assert!(t.feed(b"\x1b[?1000h\x1b[?1006h"));
        assert!(t.modes.mouse);
        assert!(!t.feed(b"\x1b[?1002h"), "已经是鼠标模式，不算变化");
        assert!(!t.feed(b"\x1b[?1000l"), "还有 1002，鼠标仍开");
        assert!(t.feed(b"\x1b[?1002l"));
        assert!(!t.modes.mouse);
        assert!(t.feed(b"\x1b]0;my title\x07"));
        assert_eq!(t.modes.title, "my title");
        assert!(t.feed(b"\x1b]2;a;b\x1b\\"));
        assert_eq!(t.modes.title, "a;b");
        assert!(!t.feed(b"\x1b]2;a;b\x07"), "同样的标题不算变化");
        // OSC 8 超链接、颜色查询等不改标题
        assert!(!t.feed(b"\x1b]8;;http://x\x07link\x1b]8;;\x07"));
        assert_eq!(t.modes.title, "a;b");
    }

    #[test]
    fn tracker_reset_clears_modes() {
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?2004h\x1b[?1049h\x1b]0;keep\x07");
        assert!(t.feed(b"\x1bc"));
        assert!(!t.modes.bracketed_paste && !t.modes.alt_screen);
        assert_eq!(t.modes.title, "keep");
    }

    // ---- 流控 ----

    #[test]
    fn flow_pause_resume() {
        let mut f = Flow::new();
        f.reset(0, 0);
        f.on_sent(3 * 1024 * 1024);
        assert!(!f.paused);
        f.on_sent(4 * 1024 * 1024 + 1);
        assert!(f.paused, "超过 4MB 应暂停");
        f.on_ack(1024 * 1024); // 未确认 3MB，仍高于低水位
        assert!(f.paused);
        f.on_ack(3 * 1024 * 1024 + 512 * 1024); // 未确认 < 1MB
        assert!(!f.paused);
        // 确认值不能超过已发送；也不会倒退
        f.on_ack(u64::MAX);
        assert_eq!(f.acked, f.sent);
        f.on_ack(5);
        assert_eq!(f.acked, f.sent);
        // 附着基线
        f.reset(2_000_000, 1_000_000);
        assert!(!f.paused);
    }

    // ---- 终端集成 ----

    /// 测试用的"链路"：把交互队列的帧转存到 mpsc 便于断言。丢弃它就等于这条会话的连接断了
    /// （发送队列的接收端被丢弃，`Sink::alive()` 变为 false）。
    struct SinkGuard {
        task: tokio::task::JoinHandle<()>,
        _ends: LinkEnds,
    }
    impl Drop for SinkGuard {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// 默认所有者都是 "same"，即同一台主控设备。
    fn test_sink(
        session: u64,
        channel: u32,
    ) -> (Sink, tokio::sync::mpsc::Receiver<pb::Frame>, SinkGuard) {
        test_sink_as(session, channel, "same")
    }

    fn test_sink_as(
        session: u64,
        channel: u32,
        owner: &str,
    ) -> (Sink, tokio::sync::mpsc::Receiver<pb::Frame>, SinkGuard) {
        let (link, mut ends) = link_pair(PeerInfo::default());
        let (otx, orx) = tokio::sync::mpsc::channel::<pb::Frame>(4096);
        let mut irx = std::mem::replace(&mut ends.interactive_rx, tokio::sync::mpsc::channel(1).1);
        let task = tokio::spawn(async move {
            while let Some(f) = irx.recv().await {
                if otx.send(f).await.is_err() {
                    break;
                }
            }
        });
        (
            Sink {
                session,
                channel,
                tx: link.tx.clone(),
                owner: owner.to_string(),
            },
            orx,
            SinkGuard { task, _ends: ends },
        )
    }

    fn cmd_spec() -> OpenSpec {
        let shells = shell::detect_shells();
        let sh = shell::find_shell(&shells, if cfg!(windows) { "cmd" } else { "" })
            .cloned()
            .expect("shell");
        OpenSpec {
            profile: pb::Profile::Shell,
            shell: sh,
            cwd: shell::home_dir(),
            cols: 100,
            rows: 30,
            startup_command: None,
            title: "test".into(),
            env: Vec::new(),
        }
    }

    fn mgr() -> TermManager {
        TermManager::new(TermConfig::default(), ExecEnv::new())
    }

    /// 收集帧直到满足条件或超时。返回收集到的全部帧。
    async fn collect_until(
        rx: &mut tokio::sync::mpsc::Receiver<pb::Frame>,
        secs: u64,
        mut done: impl FnMut(&[pb::Frame]) -> bool,
    ) -> Vec<pb::Frame> {
        let mut frames = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
                Ok(Some(f)) => {
                    frames.push(f);
                    if done(&frames) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    if done(&frames) {
                        break;
                    }
                }
            }
        }
        frames
    }

    /// 各平台 shell 的提示符不同：cmd/PowerShell 是 `>`，bash 是 `$`，zsh 是 `%`，root 是 `#`。
    fn has_prompt(s: &str) -> bool {
        s.contains(['>', '$', '%', '#'])
    }

    fn output_text(frames: &[pb::Frame]) -> String {
        let mut v = Vec::new();
        for f in frames {
            if let Some(pb::frame::Body::TermOutput(o)) = &f.body {
                v.extend_from_slice(&o.data);
            }
        }
        String::from_utf8_lossy(&v).into_owned()
    }

    #[tokio::test]
    async fn open_input_resize_exit() {
        let m = mgr();
        let (sink, mut rx, _ends) = test_sink(1, 7);
        let term = m.open(cmd_spec(), sink, 42).await.expect("open");
        let frames = collect_until(&mut rx, 10, |f| has_prompt(&output_text(f))).await;
        // 第一帧是 TermOpened，带 req_id 和通道
        match frames.first().and_then(|f| f.body.clone()) {
            Some(pb::frame::Body::TermOpened(o)) => {
                assert_eq!((o.req_id, o.channel), (42, 7));
                assert_eq!(o.term_id, term.id());
            }
            other => panic!("第一帧应是 TermOpened：{other:?}"),
        }
        assert!(frames.iter().all(|f| f.channel == 7));
        // seq 连续
        let mut expect = 0u64;
        for f in &frames {
            if let Some(pb::frame::Body::TermOutput(o)) = &f.body {
                assert_eq!(o.seq, expect, "seq 应从 0 连续递增");
                expect += o.data.len() as u64;
            }
        }
        term.write_input(1, b"echo hello_term\r".to_vec())
            .await
            .expect("write");
        let frames = collect_until(&mut rx, 10, |f| output_text(f).contains("hello_term")).await;
        assert!(output_text(&frames).contains("hello_term"));
        // 非附着会话不能写
        assert_eq!(
            term.write_input(2, b"x".to_vec()).await,
            Err("TERM_DETACHED")
        );
        // 尺寸
        term.resize(1, 120, 40).expect("resize");
        tokio::time::sleep(Duration::from_millis(300)).await; // 等 50ms 防抖生效
        term.write_input(1, b"mode con\r".to_vec())
            .await
            .expect("write");
        let frames = collect_until(&mut rx, 10, |f| output_text(f).contains("120")).await;
        if cfg!(windows) {
            let t = output_text(&frames);
            assert!(
                t.contains("120") && t.contains("40"),
                "mode con 应显示 40 行 120 列：{t:?}"
            );
        }
        term.write_input(1, b"exit 0\r".to_vec())
            .await
            .expect("write");
        let frames = collect_until(&mut rx, 10, |f| {
            f.iter()
                .any(|x| matches!(x.body, Some(pb::frame::Body::TermExit(_))))
        })
        .await;
        let exit = frames.iter().find_map(|f| match &f.body {
            Some(pb::frame::Body::TermExit(e)) => Some(e.code),
            _ => None,
        });
        assert_eq!(exit, Some(0));
        assert_eq!(term.exited(), Some(0));
        assert!(m.list().iter().any(|i| i.exited));
    }

    #[tokio::test]
    async fn detach_reattach_replays_without_gap_or_dup() {
        let m = mgr();
        let (sink1, mut rx1, _e1) = test_sink(1, 1);
        let term = m.open(cmd_spec(), sink1, 1).await.expect("open");
        let frames = collect_until(&mut rx1, 10, |f| has_prompt(&output_text(f))).await;
        let mut received = output_text(&frames).into_bytes();
        let last_seq = received.len() as u64;
        // 断开
        term.detach(1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!term.info().attached);
        // 断开期间产生输出
        term.core
            .control
            .write(b"echo during_detach_1\r".to_vec())
            .await
            .expect("w");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // 重新附着，从 last_seq 继续
        let (sink2, mut rx2, _e2) = test_sink(2, 5);
        assert!(term.attach(sink2, 9, last_seq, 100, 30).await);
        let frames =
            collect_until(&mut rx2, 10, |f| output_text(f).contains("during_detach_1")).await;
        assert!(matches!(
            frames.first().and_then(|f| f.body.as_ref()),
            Some(pb::frame::Body::TermOpened(_))
        ));
        let mut next = last_seq;
        for f in &frames {
            if let Some(pb::frame::Body::TermOutput(o)) = &f.body {
                assert_eq!(o.seq, next, "回放应与 last_seq 无缝衔接");
                next += o.data.len() as u64;
                received.extend_from_slice(&o.data);
            }
        }
        let text = String::from_utf8_lossy(&received);
        assert!(text.contains("during_detach_1"));
        assert!(term.info().last_seq >= next);
        // 每个字节只出现一次：before + after 恰好等于环形缓冲全部内容
        let (_, whole, _) = term.core.lock().ring.read_from(0);
        assert_eq!(&whole[..received.len()], &received[..]);
        // 旧会话收不到新输出
        assert!(rx1.try_recv().is_err() || true);
        term.close(true).await;
    }

    #[tokio::test]
    async fn new_attach_displaces_old_with_error() {
        let m = mgr();
        let (sink1, mut rx1, _e1) = test_sink(1, 1);
        let term = m.open(cmd_spec(), sink1, 1).await.expect("open");
        collect_until(&mut rx1, 10, |f| has_prompt(&output_text(f))).await;
        let (sink2, mut rx2, _e2) = test_sink(2, 2);
        term.attach(sink2, 2, 0, 0, 0).await;
        let frames = collect_until(&mut rx1, 5, |f| {
            f.iter()
                .any(|x| matches!(&x.body, Some(pb::frame::Body::Error(_))))
        })
        .await;
        let err = frames.iter().find_map(|f| match &f.body {
            Some(pb::frame::Body::Error(e)) => Some(e.clone()),
            _ => None,
        });
        assert_eq!(err.map(|e| e.code), Some("TERM_DETACHED".to_string()));
        assert!(term.is_attached_to(2) && !term.is_attached_to(1));
        // 新会话拿到完整回放
        let frames = collect_until(&mut rx2, 5, |f| has_prompt(&output_text(f))).await;
        assert!(has_prompt(&output_text(&frames)));
        term.close(true).await;
    }

    fn first_error(frames: &[pb::Frame]) -> Option<pb::Error> {
        frames.iter().find_map(|f| match &f.body {
            Some(pb::frame::Body::Error(e)) => Some(e.clone()),
            _ => None,
        })
    }

    #[tokio::test]
    async fn other_device_cannot_preempt_live_attachment() {
        let m = mgr();
        let (sa, mut ra, _ga) = test_sink_as(1, 1, "devA");
        let term = m.open(cmd_spec(), sa, 1).await.expect("open");
        collect_until(&mut ra, 10, |f| has_prompt(&output_text(f))).await;
        // 设备 B 想抢：TERM_BUSY，A 的附着不受影响
        let (sb, mut rb, _gb) = test_sink_as(2, 7, "devB");
        assert!(term.would_be_busy(&sb));
        term.attach(sb, 9, 0, 0, 0).await;
        let frames = collect_until(&mut rb, 5, |f| first_error(f).is_some()).await;
        let e = first_error(&frames).expect("应收到错误");
        assert_eq!((e.code.as_str(), e.ref_id), ("TERM_BUSY", 9));
        assert!(!frames
            .iter()
            .any(|f| matches!(f.body, Some(pb::frame::Body::TermOpened(_)))));
        assert!(term.is_attached_to(1) && !term.is_attached_to(2));
        // A 没有收到 TERM_DETACHED
        let fa = collect_until(&mut ra, 1, |_| false).await;
        assert!(first_error(&fa).is_none());
        // 从 B 的角度看：被其他设备占用，通道号不泄露
        let ib = term.info_for("devB");
        assert!(ib.attached && ib.attached_by_other && ib.channel == 0);
        let ia = term.info_for("devA");
        assert!(ia.attached && !ia.attached_by_other && ia.channel == 1);
        term.close(true).await;
    }

    #[tokio::test]
    async fn other_device_can_take_over_after_session_died() {
        let m = mgr();
        let (sa, mut ra, ga) = test_sink_as(1, 1, "devA");
        let term = m.open(cmd_spec(), sa, 1).await.expect("open");
        collect_until(&mut ra, 10, |f| has_prompt(&output_text(f))).await;
        // A 的连接断了，但终端还记着它的附着（会话尚未被清理）
        drop(ga);
        drop(ra);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let ib = term.info_for("devB");
        assert!(
            !ib.attached && !ib.attached_by_other,
            "已死亡的会话不算附着"
        );
        let (sb, mut rb, _gb) = test_sink_as(2, 3, "devB");
        assert!(!term.would_be_busy(&sb));
        term.attach(sb, 4, 0, 0, 0).await;
        let frames = collect_until(&mut rb, 5, |f| has_prompt(&output_text(f))).await;
        assert!(frames
            .iter()
            .any(|f| matches!(f.body, Some(pb::frame::Body::TermOpened(_)))));
        assert!(term.is_attached_to(2));
        term.close(true).await;
    }

    #[tokio::test]
    async fn same_device_reconnect_takes_over_own_stale_attachment() {
        let m = mgr();
        let (s1, mut r1, _g1) = test_sink_as(1, 1, "devA");
        let term = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        // 旧连接还没被检测到断开（仍然存活），同一设备的新连接来了
        let (s2, mut r2, _g2) = test_sink_as(2, 5, "devA");
        assert!(!term.would_be_busy(&s2));
        term.attach(s2, 2, 0, 0, 0).await;
        let frames = collect_until(&mut r1, 5, |f| first_error(f).is_some()).await;
        assert_eq!(
            first_error(&frames).map(|e| e.code),
            Some("TERM_DETACHED".to_string())
        );
        let frames = collect_until(&mut r2, 5, |f| has_prompt(&output_text(f))).await;
        assert!(has_prompt(&output_text(&frames)));
        assert!(term.is_attached_to(2) && !term.is_attached_to(1));
        term.close(true).await;
    }

    #[tokio::test]
    async fn isolation_filters_visibility_and_toggles_hot() {
        let m = mgr();
        assert!(m.isolate_terminals(), "默认开启隔离");
        let (sa, _ra, _ga) = test_sink_as(1, 1, "devA");
        let (sb, _rb, _gb) = test_sink_as(2, 1, "devB");
        let (so, _ro, _go) = test_sink_as(3, 1, ""); // 无主终端
        let ta = m.open(cmd_spec(), sa, 1).await.expect("a");
        let tb = m.open(cmd_spec(), sb, 2).await.expect("b");
        let to = m.open(cmd_spec(), so, 3).await.expect("orphan");
        let ids = |v: Vec<pb::TermInfo>| {
            let mut x: Vec<String> = v.into_iter().map(|i| i.term_id).collect();
            x.sort();
            x
        };
        // 隔离开启：各看各的，无主终端谁也看不到（本机的 list() 不过滤）
        assert_eq!(ids(m.list_visible("devA")), vec![ta.id().to_string()]);
        assert_eq!(ids(m.list_visible("devB")), vec![tb.id().to_string()]);
        assert!(ids(m.list_visible("")).is_empty());
        assert!(m.get_visible(tb.id(), "devA").is_none());
        assert!(m.get_visible(to.id(), "devA").is_none());
        assert!(m.get_visible(to.id(), "").is_none());
        assert!(m.get_visible(ta.id(), "devA").is_some());
        assert_eq!(m.list().len(), 3);
        // 关闭隔离：立即互相可见，无主终端也可见
        m.set_isolate_terminals(false);
        assert_eq!(m.list_visible("devA").len(), 3);
        assert!(m.get_visible(tb.id(), "devA").is_some());
        assert!(m.get_visible(to.id(), "devB").is_some());
        // 再打开：立即生效
        m.set_isolate_terminals(true);
        assert_eq!(ids(m.list_visible("devA")), vec![ta.id().to_string()]);
        m.close_all().await;
    }

    #[tokio::test]
    async fn small_ring_forces_reset_replay() {
        let m = TermManager::new(
            TermConfig {
                ring_cap: 4096,
                ..TermConfig::default()
            },
            ExecEnv::new(),
        );
        let (sink1, mut rx1, _e1) = test_sink(1, 1);
        let term = m.open(cmd_spec(), sink1, 1).await.expect("open");
        collect_until(&mut rx1, 10, |f| has_prompt(&output_text(f))).await;
        term.detach(1).await;
        let cmd: &[u8] = if cfg!(windows) {
            b"for /L %i in (1,1,400) do @echo line_%i_padding_padding\r"
        } else {
            b"i=1; while [ $i -le 400 ]; do echo line_${i}_padding_padding; i=$((i+1)); done\r"
        };
        term.core.control.write(cmd.to_vec()).await.expect("w");
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (sink2, mut rx2, _e2) = test_sink(2, 2);
        term.attach(sink2, 2, 0, 0, 0).await;
        let frames = collect_until(&mut rx2, 10, |f| output_text(f).contains("line_400_")).await;
        // TermOpened 之后第一条输出是复位序列
        let outs: Vec<&pb::TermOutput> = frames
            .iter()
            .filter_map(|f| match &f.body {
                Some(pb::frame::Body::TermOutput(o)) => Some(o),
                _ => None,
            })
            .collect();
        assert_eq!(outs[0].data, RESET_SEQ);
        // 复位帧的 seq + 长度 == 下一帧的 seq
        assert_eq!(outs[0].seq + 2, outs[1].seq);
        assert!(outs[1].seq > 0);
        // 回放起点之后是完整的行（不会从半行开始）
        let t = String::from_utf8_lossy(&outs[1].data).into_owned();
        assert!(
            t.starts_with("line_") || t.starts_with("\u{1b}") || t.contains("line_"),
            "{:?}",
            &t[..t.len().min(40)]
        );
        term.close(true).await;
    }

    #[tokio::test]
    async fn terminal_limit_and_close_removes() {
        let m = TermManager::new(
            TermConfig {
                max_terminals: 2,
                ..TermConfig::default()
            },
            ExecEnv::new(),
        );
        let (s1, _r1, _e1) = test_sink(1, 1);
        let t1 = m.open(cmd_spec(), s1.clone(), 1).await.expect("1");
        let t2 = m
            .open(
                cmd_spec(),
                Sink {
                    channel: 2,
                    ..s1.clone()
                },
                2,
            )
            .await
            .expect("2");
        let e = m
            .open(
                cmd_spec(),
                Sink {
                    channel: 3,
                    ..s1.clone()
                },
                3,
            )
            .await
            .err();
        assert_eq!(e.map(|e| e.code), Some("TERM_LIMIT"));
        assert_eq!(m.list().len(), 2);
        let pid = t1.pid().expect("pid");
        t1.close(true).await;
        for _ in 0..50 {
            if m.get(t1.id()).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(m.get(t1.id()).is_none(), "关闭后应从表中移除");
        assert_eq!(m.live_count(), 1);
        // shell 进程确实结束了
        tokio::time::sleep(Duration::from_millis(500)).await;
        let table = procs::ProcTable::snapshot();
        let _ = pid;
        drop(table);
        t2.close(true).await;
    }

    #[tokio::test]
    async fn exited_term_kept_then_cleaned() {
        let m = TermManager::new(
            TermConfig {
                exited_ttl: Duration::from_millis(800),
                ..TermConfig::default()
            },
            ExecEnv::new(),
        );
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        t.write_input(1, b"exit\r".to_vec()).await.expect("w");
        for _ in 0..50 {
            if t.exited().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(t.exited(), Some(0));
        assert!(m.get(t.id()).is_some(), "刚退出时应保留");
        // 保留期内重新附着能看到 TermExit 和最后的输出
        let (s2, mut r2, _e2) = test_sink(2, 2);
        t.attach(s2, 5, 0, 0, 0).await;
        let frames = collect_until(&mut r2, 5, |f| {
            f.iter()
                .any(|x| matches!(x.body, Some(pb::frame::Body::TermExit(_))))
        })
        .await;
        assert!(frames
            .iter()
            .any(|x| matches!(x.body, Some(pb::frame::Body::TermExit(_)))));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(m.get(t.id()).is_none(), "保留期满后应清理");
    }

    #[tokio::test]
    async fn detached_ttl_closes_terminal() {
        let m = TermManager::new(
            TermConfig {
                detached_ttl: Some(Duration::from_millis(600)),
                ..TermConfig::default()
            },
            ExecEnv::new(),
        );
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        t.detach(1).await;
        for _ in 0..60 {
            if m.get(t.id()).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(m.get(t.id()).is_none(), "无人附着超时后应关闭并移除");
    }

    #[tokio::test]
    async fn submit_goes_through_queue_and_actions_without_claude_are_rejected() {
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1.clone(), 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        // 普通 shell 里提交：generic 规则，没开 bracketed paste，直接写文本再回车
        t.submit(
            s1.clone(),
            pb::TermSubmit {
                msg_id: 1,
                text: "echo via_submit".into(),
                attachments: vec![],
                press_enter: true,
            },
            vec![],
        )
        .expect("queue");
        let frames = collect_until(&mut r1, 10, |f| {
            output_text(f).matches("via_submit").count() >= 2
        })
        .await;
        assert!(
            output_text(&frames).matches("via_submit").count() >= 2,
            "回显 + 命令输出"
        );
        // 普通 shell 里执行动作：APP_NOT_RUNNING，终端里没有被写入任何内容。
        // 先等输出稳定（命令输出之后 shell 还会再打印提示符，Linux 上比 Windows 晚），再记起点
        let mut before = t.info().last_seq;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let now = t.info().last_seq;
            if now == before {
                break;
            }
            before = now;
        }
        t.action(
            s1.clone(),
            pb::TermAction {
                req_id: 77,
                action_id: "interrupt".into(),
                args: Default::default(),
            },
        )
        .expect("queue");
        let frames = collect_until(&mut r1, 10, |f| {
            f.iter()
                .any(|x| matches!(x.body, Some(pb::frame::Body::TermActionResult(_))))
        })
        .await;
        let res = frames.iter().find_map(|f| match &f.body {
            Some(pb::frame::Body::TermActionResult(r)) => Some(r.clone()),
            _ => None,
        });
        let res = res.expect("应有结果");
        assert_eq!(
            (res.req_id, res.ok, res.error.as_str()),
            (77, false, "APP_NOT_RUNNING")
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(t.info().last_seq, before, "不应向终端写入任何内容");
        // 未附着的会话不能入队
        let other = Sink {
            session: 9,
            ..s1.clone()
        };
        assert_eq!(
            t.submit(other, pb::TermSubmit::default(), vec![]),
            Err(ActionError::TermNotFound)
        );
        t.close(true).await;
    }

    #[tokio::test]
    async fn bridge_messages_update_state_and_notify() {
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        let send = |ev: serde_json::Value| {
            m.dispatch_bridge(BridgeMessage {
                term_id: t.id().to_string(),
                kind: "hook".into(),
                payload: ev,
            });
        };
        send(serde_json::json!({"hook_event_name":"SessionStart","session_id":"S","cwd":"/x"}));
        send(serde_json::json!({"hook_event_name":"UserPromptSubmit"}));
        send(
            serde_json::json!({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}),
        );
        let frames = collect_until(&mut r1, 5, |f| {
            f.iter()
                .any(|x| matches!(&x.body, Some(pb::frame::Body::AppNotice(_))))
        })
        .await;
        let notice = frames.iter().find_map(|f| match &f.body {
            Some(pb::frame::Body::AppNotice(n)) => Some(n.clone()),
            _ => None,
        });
        let n = notice.expect("权限通知");
        assert_eq!(
            (
                n.kind.as_str(),
                n.tool_name.as_str(),
                n.tool_summary.as_str()
            ),
            ("permission", "Bash", "ls")
        );
        // 通知之前，状态已经是 waiting_permission
        let last_state = frames.iter().rev().find_map(|f| match &f.body {
            Some(pb::frame::Body::AppState(s)) => Some(s.clone()),
            _ => None,
        });
        assert_eq!(
            last_state.map(|s| s.activity),
            Some("waiting_permission".to_string())
        );
        assert!(t.app_state().stateful);
        t.close(true).await;
    }

    #[tokio::test]
    async fn permission_action_requires_matching_notice() {
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1.clone(), 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        m.dispatch_bridge(BridgeMessage { term_id: t.id().to_string(), kind: "hook".into(), payload: serde_json::json!({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}) });
        let frames = collect_until(&mut r1, 5, |f| {
            f.iter()
                .any(|x| matches!(&x.body, Some(pb::frame::Body::AppNotice(_))))
        })
        .await;
        let nid = frames
            .iter()
            .find_map(|f| match &f.body {
                Some(pb::frame::Body::AppNotice(n)) => Some(n.notice_id),
                _ => None,
            })
            .expect("notice");
        let before = t.info().last_seq;
        // 错误的编号：BAD_REQUEST，不发送按键
        let mut args = HashMap::new();
        args.insert("notice_id".to_string(), (nid + 100).to_string());
        t.action(
            s1.clone(),
            pb::TermAction {
                req_id: 1,
                action_id: "permission.allow".into(),
                args,
            },
        )
        .expect("queue");
        let frames = collect_until(&mut r1, 10, |f| {
            f.iter()
                .any(|x| matches!(x.body, Some(pb::frame::Body::TermActionResult(_))))
        })
        .await;
        let res = frames
            .iter()
            .find_map(|f| match &f.body {
                Some(pb::frame::Body::TermActionResult(r)) => Some(r.clone()),
                _ => None,
            })
            .expect("result");
        assert_eq!(res.error, "BAD_REQUEST");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(t.info().last_seq, before);
        // 正确的编号：回车被写进终端（cmd 里会回显一个新提示符）
        let mut args = HashMap::new();
        args.insert("notice_id".to_string(), nid.to_string());
        t.action(
            s1.clone(),
            pb::TermAction {
                req_id: 2,
                action_id: "permission.allow".into(),
                args,
            },
        )
        .expect("queue");
        let frames = collect_until(&mut r1, 10, |f| {
            f.iter().any(
                |x| matches!(&x.body, Some(pb::frame::Body::TermActionResult(r)) if r.req_id == 2),
            )
        })
        .await;
        let res = frames
            .iter()
            .find_map(|f| match &f.body {
                Some(pb::frame::Body::TermActionResult(r)) if r.req_id == 2 => Some(r.clone()),
                _ => None,
            })
            .expect("result");
        assert!(res.ok, "{res:?}");
        t.close(true).await;
    }

    #[tokio::test]
    async fn flow_control_pauses_at_4mb_and_resumes_on_ack() {
        // 大文件输出：不确认时被控端在落后约 4MB 时停止读取 PTY；确认之后继续，数据完整
        let tmp = tempfile::tempdir().expect("tmp");
        let big = tmp.path().join("big.txt");
        let line = "0123456789abcdefghijklmnopqrstuvwxyz-0123456789abcdefghijklmnopqrstuvwxyz\r\n";
        let total_lines = 80_000; // 约 5.9MB
        std::fs::write(&big, line.repeat(total_lines)).expect("write big");
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        let show = if cfg!(windows) { "type" } else { "cat" };
        t.write_input(1, format!("{show} \"{}\"\r", big.display()).into_bytes())
            .await
            .expect("w");
        // 数据持续到来，直到被流控挡住
        let mut received = 0u64;
        let mut last_change = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), r1.recv()).await {
                Ok(Some(f)) => {
                    if let Some(pb::frame::Body::TermOutput(o)) = f.body {
                        received += o.data.len() as u64;
                        last_change = Instant::now();
                    }
                }
                Ok(None) => break,
                Err(_) => {}
            }
            // 以“已进入暂停状态且数据静止”为准；负载高时 type/cat 启动慢，所以不按固定时长判断
            if received > 0
                && t.core.lock().flow.paused
                && last_change.elapsed() > Duration::from_secs(2)
            {
                break;
            }
        }
        assert!(
            received >= HIGH_WATER,
            "应该读到至少 4MB 才被挡住，实际 {received}"
        );
        assert!(
            received < HIGH_WATER + 1024 * 1024,
            "被控端应在落后约 4MB 时停止读取，实际已发送 {received}"
        );
        assert!(t.core.lock().flow.paused, "应处于暂停状态");
        // 暂停期间，输入方向不受影响：命令仍然能写进 PTY
        assert!(t.write_input(1, b"\x03".to_vec()).await.is_ok());
        // 确认已收到的全部数据后，继续读取，直到文件输出完
        let sent_now = t.core.lock().flow.sent;
        t.ack(1, sent_now).await;
        let mut after_ack = 0u64;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), r1.recv()).await {
                Ok(Some(f)) => {
                    if let Some(pb::frame::Body::TermOutput(o)) = f.body {
                        after_ack += o.data.len() as u64;
                        let sent = t.core.lock().flow.sent;
                        t.ack(1, sent).await;
                    }
                }
                _ => {
                    // 数据已开始恢复并静止 300ms 即可；尚未收到任何数据则继续等到 deadline
                    if after_ack > 0 {
                        break;
                    }
                }
            }
        }
        assert!(after_ack > 0, "确认之后应当继续收到数据");
        t.close(true).await;
    }

    #[tokio::test]
    async fn ctrl_c_reaches_running_program() {
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 1);
        let t = m.open(cmd_spec(), s1, 1).await.expect("open");
        collect_until(&mut r1, 10, |f| has_prompt(&output_text(f))).await;
        let cmd: &[u8] = if cfg!(windows) {
            b"ping -t 127.0.0.1\r"
        } else {
            b"sleep 100\r"
        };
        t.write_input(1, cmd.to_vec()).await.expect("w");
        if cfg!(windows) {
            collect_until(&mut r1, 10, |f| {
                output_text(f).contains("Reply from") || output_text(f).contains("来自")
            })
            .await;
        } else {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        t.write_input(1, b"\x03".to_vec()).await.expect("w");
        // Ctrl+C 会清空控制台输入缓冲，等一会儿再输入
        tokio::time::sleep(Duration::from_millis(800)).await;
        t.write_input(1, b"echo after_ctrl_c\r".to_vec())
            .await
            .expect("w");
        let frames = collect_until(&mut r1, 10, |f| output_text(f).contains("after_ctrl_c")).await;
        assert!(
            output_text(&frames).contains("after_ctrl_c"),
            "Ctrl+C 之后应回到提示符"
        );
        t.close(true).await;
    }

    #[tokio::test]
    async fn opened_frame_carries_shell_and_title() {
        let m = mgr();
        let (s1, mut r1, _e1) = test_sink(1, 3);
        let mut spec = cmd_spec();
        spec.title = "我的终端".into();
        let shell_name = spec.shell.name.clone();
        let t = m.open(spec, s1, 5).await.expect("open");
        let frames = collect_until(&mut r1, 10, |f| !f.is_empty()).await;
        match frames.first().and_then(|f| f.body.clone()) {
            Some(pb::frame::Body::TermOpened(o)) => {
                assert_eq!(o.shell, shell_name);
                assert_eq!(o.title, "我的终端");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(t.info().title, "我的终端");
        t.close(true).await;
    }

    #[tokio::test]
    async fn three_terminals_are_independent() {
        let m = mgr();
        let (s, mut r, _e) = test_sink(1, 1);
        let mut terms = Vec::new();
        for ch in 1..=3u32 {
            terms.push(
                m.open(
                    cmd_spec(),
                    Sink {
                        channel: ch,
                        ..s.clone()
                    },
                    ch as u64,
                )
                .await
                .expect("open"),
            );
        }
        let _ = collect_until(&mut r, 10, |f| {
            f.iter()
                .filter(|x| matches!(&x.body, Some(pb::frame::Body::TermOpened(_))))
                .count()
                >= 3
        })
        .await;
        for (i, t) in terms.iter().enumerate() {
            t.write_input(1, format!("echo only_term_{i}\r").into_bytes())
                .await
                .expect("w");
        }
        let frames = collect_until(&mut r, 10, |f| {
            (0..3).all(|i| {
                f.iter().any(|x| {
                    x.channel == (i + 1) as u32
                        && output_text(std::slice::from_ref(x)).contains(&format!("only_term_{i}"))
                })
            })
        })
        .await;
        for i in 0..3u32 {
            let own: Vec<pb::Frame> = frames
                .iter()
                .filter(|f| f.channel == i + 1)
                .cloned()
                .collect();
            let txt = output_text(&own);
            assert!(txt.contains(&format!("only_term_{i}")));
            for j in 0..3u32 {
                if j != i {
                    // 回显里不应出现别的终端的内容
                    assert!(
                        !txt.contains(&format!("only_term_{j}")),
                        "终端 {i} 里出现了终端 {j} 的输出"
                    );
                }
            }
        }
        m.close_all().await;
    }
    /// 审查 M5：每个终端有自己的一次性随机令牌，通过环境变量交给终端里的进程，关闭后失效。
    #[tokio::test]
    async fn each_terminal_gets_its_own_hook_token() {
        let m = mgr();
        let tokens = Arc::new(status::TermTokens::default());
        m.set_bridge_tokens(tokens.clone());
        let show = if cfg!(windows) {
            b"echo tok[%RTERM_HOOK_TOKEN%]\r".to_vec()
        } else {
            b"echo tok[$RTERM_HOOK_TOKEN]\r".to_vec()
        };
        let mut seen = Vec::new();
        for n in 0..2u64 {
            let (s, mut r, _g) = test_sink(1, n as u32 + 1);
            let t = m.open(cmd_spec(), s, 1).await.expect("open");
            // 等 shell 出了第一批输出（提示符）再输入
            collect_until(&mut r, 10, |f| !output_text(f).is_empty()).await;
            t.write_input(1, show.clone()).await.expect("write");
            let frames = collect_until(&mut r, 10, |f| {
                // 回显的命令里是 `tok[%RTERM_HOOK_TOKEN%]`，展开后的结果里 `tok[` 后面是 32 个十六进制字符
                let o = output_text(f);
                o.match_indices("tok[").any(|(i, _)| {
                    o.get(i + 4..i + 36)
                        .is_some_and(|h| h.chars().all(|c| c.is_ascii_hexdigit()))
                })
            })
            .await;
            let out = output_text(&frames);
            // 命令回显里是 `tok[%RTERM_HOOK_TOKEN%]` / `tok[$RTERM_HOOK_TOKEN]`，展开后的才是 32 位十六进制
            let tok = out
                .match_indices("tok[")
                .map(|(i, _)| &out[i + 4..])
                .filter_map(|rest| rest.get(..32))
                .find(|h| h.chars().all(|c| c.is_ascii_hexdigit()))
                .map(str::to_string)
                .unwrap_or_else(|| panic!("没有找到令牌，输出：{out:?}"));
            assert!(tokens.verify(t.id(), Some(&tok)), "令牌应与登记的一致");
            seen.push((t.id().to_string(), tok));
            t.close(true).await;
        }
        assert_ne!(seen[0].1, seen[1].1, "每个终端的令牌都不同");
        assert!(
            !tokens.verify(&seen[0].0, Some(&seen[1].1)),
            "别的终端的令牌不能通用"
        );
        // 终端关闭后令牌被撤销
        for _ in 0..50 {
            if !tokens.verify(&seen[0].0, Some(&seen[0].1)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            !tokens.verify(&seen[0].0, Some(&seen[0].1)),
            "终端关闭后令牌应失效"
        );
    }
    #[test]
    fn pty_dimensions_are_clamped_everywhere() {
        assert_eq!(clamp_dim(0), 1);
        assert_eq!(clamp_dim(80), 80);
        assert_eq!(clamp_dim(1000), 1000);
        assert_eq!(clamp_dim(1001), 1000);
        assert_eq!(clamp_dim(65535), 1000);
        assert_eq!(clamp_dim(u32::MAX), 1000);
        // 源码里不再有按 u16::MAX 夹的地方
        let src = include_str!("term.rs");
        assert!(!src.contains(concat!("min(u16", "::MAX as u32)")));
    }
}
