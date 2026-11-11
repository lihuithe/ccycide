//! 被控端会话（《实现方案.md》3.5–3.8、4.6，《开发指南.md》T13、T23、T26）。
//!
//! `HostSession::run(link, ctx)` 在一条已建立的 `Link` 上处理控制端发来的全部帧：
//! `Hello/HelloAck`、动作目录下发、终端的打开/列出/附着/关闭、终端数据、文件上传、动作执行、自定义命令清单。
//! 终端属于 [`HostCtx`]（被控端全局），不属于会话：会话结束时终端只是"脱离"，继续运行并把输出写进环形缓冲。
//! 一条会话里用通道号区分多个终端（通道号由被控端分配，0 是控制通道）。
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rterm_proto::{pb, MIN_PROTO_VER, PROTO_VER};
use tokio::sync::{broadcast, mpsc, watch, Notify};

use crate::host::actions::{self, Catalog};
use crate::host::adapter::{AdapterRules, RulesError};
use crate::host::commands;
use crate::host::guard::{Guard, GuardEvent};
use crate::host::inbox::{ChunkOutcome, Inbox, InboxConfig, InboxSession};
use crate::host::shell::{self, ClaudeProbe, ShellEntry};
use crate::host::status::{self, BridgeArgs, BridgeServer};
use crate::host::term::{ExecEnv, OpenSpec, Sink, TermConfig, TermManager};
use crate::link::{FrameTx, Link, PeerInfo};

pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// 被控端运行参数（对应《实现方案.md》17.2 的 `host` 段，加上本模块需要的几项）。
#[derive(Debug, Clone)]
pub struct HostConfig {
    /// 数据目录：inbox、claude-plugin 都在它下面
    pub data_dir: PathBuf,
    pub app_version: String,
    /// 是否接收文件
    pub file_receive: bool,
    pub max_file_size: u64,
    pub max_inbox_total: u64,
    pub term: TermConfig,
    /// `rterm-cli` 可执行文件的绝对路径（状态回传的 hook 命令）。None = 不做状态回传
    pub rterm_cli: Option<PathBuf>,
    /// "Claude Code 集成"总开关；关闭后不注入任何参数，工具条为无状态模式
    pub claude_integration: bool,
    /// 是否注入状态栏命令（默认开）
    pub inject_statusline: bool,
    /// 默认 shell 的 id（None = 自动探测的默认项）
    pub default_shell: Option<String>,
    /// Windows 上 Shift+Tab 不被识别时置位（见 M0 验证结论）
    pub windows_no_vt: bool,
    /// 终端隔离的初始值（默认开）；之后由 `HostCtx::bind_guard` / `set_isolate_terminals` 随设置更新
    pub isolate_terminals: bool,
    /// 启动时是否执行 `claude --version` 探测（最长 5 秒）
    pub probe_claude: bool,
}

impl HostConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            file_receive: true,
            max_file_size: 200 * 1024 * 1024,
            max_inbox_total: 2 * 1024 * 1024 * 1024,
            term: TermConfig::default(),
            rterm_cli: None,
            claude_integration: true,
            inject_statusline: true,
            default_shell: None,
            windows_no_vt: false,
            isolate_terminals: true,
            probe_claude: true,
        }
    }
}

/// 被控端全局上下文，所有会话共享。
pub struct HostCtx {
    pub config: HostConfig,
    pub terms: TermManager,
    pub inbox: Arc<Inbox>,
    env: Arc<ExecEnv>,
    shells: RwLock<Vec<ShellEntry>>,
    claude: RwLock<ClaudeProbe>,
    bridge_args: Option<BridgeArgs>,
    bridge: Option<BridgeServer>,
    catalog_tx: watch::Sender<Arc<Catalog>>,
    next_session: AtomicU64,
}

impl HostCtx {
    pub async fn new(config: HostConfig) -> Arc<HostCtx> {
        let mut shells = shell::detect_shells();
        if let Some(id) = &config.default_shell {
            for s in shells.iter_mut() {
                s.is_default = &s.id == id;
            }
            if !shells.iter().any(|s| s.is_default) {
                if let Some(f) = shells.first_mut() {
                    f.is_default = true;
                }
            }
        }
        let claude = if config.probe_claude {
            match shell::find_shell(&shells, "") {
                Some(sh) => shell::probe_claude(sh).await,
                None => ClaudeProbe::default(),
            }
        } else {
            ClaudeProbe::default()
        };

        let env = ExecEnv::new();
        env.windows_no_vt
            .store(config.windows_no_vt, Ordering::Relaxed);
        if let Ok(mut v) = env.claude_version.write() {
            *v = claude.available.then(|| claude.version.clone());
        }
        let terms = TermManager::new(config.term.clone(), env.clone());
        terms.set_isolate_terminals(config.isolate_terminals);

        let mut icfg = InboxConfig::new(config.data_dir.join("inbox"));
        icfg.enabled = config.file_receive;
        icfg.max_file_size = config.max_file_size;
        icfg.max_total = config.max_inbox_total;
        let inbox = Inbox::new(icfg);
        inbox.spawn_cleanup_task();

        // 状态回传：插件目录 + 本机 IPC
        let (bridge_args, bridge) = if config.claude_integration {
            match &config.rterm_cli {
                Some(cli) => {
                    match status::write_plugin_dir(&config.data_dir, cli, config.inject_statusline)
                    {
                        Ok(args) => match BridgeServer::start(&config.data_dir) {
                            Ok((server, mut rx)) => {
                                terms.set_bridge_tokens(server.tokens());
                                let t = terms.clone();
                                tokio::spawn(async move {
                                    while let Some(m) = rx.recv().await {
                                        t.dispatch_bridge(m);
                                    }
                                });
                                (Some(args), Some(server))
                            }
                            Err(e) => {
                                tracing::warn!("状态回传的本机通信启动失败，降级为无状态：{e}");
                                (None, None)
                            }
                        },
                        Err(e) => {
                            tracing::warn!("生成状态回传插件失败，降级为无状态：{e}");
                            (None, None)
                        }
                    }
                }
                None => (None, None),
            }
        } else {
            (None, None)
        };

        let (catalog_tx, _) = watch::channel(Arc::new(Catalog::builtin()));
        let ctx = Arc::new(HostCtx {
            config,
            terms,
            inbox,
            env,
            shells: RwLock::new(shells),
            claude: RwLock::new(claude),
            bridge_args,
            bridge,
            catalog_tx,
            next_session: AtomicU64::new(1),
        });
        ctx.apply_catalog(None);
        ctx
    }

    /// 终端隔离开关（对新请求立即生效，已附着的不强制踢）。
    pub fn set_isolate_terminals(&self, on: bool) {
        self.terms.set_isolate_terminals(on);
    }

    /// 把 `Guard` 的接入设置里的 `isolate_terminals` 同步过来：立即应用一次，之后每次设置变化自动应用。
    /// 只持有 `Guard` 的弱引用，`Guard` 被丢弃后后台任务自行结束。
    pub fn bind_guard(&self, guard: &Arc<Guard>) {
        self.terms
            .set_isolate_terminals(guard.settings().isolate_terminals);
        let mut rx = guard.subscribe();
        let weak = Arc::downgrade(guard);
        let terms = self.terms.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(GuardEvent::SettingsChanged)
                    | Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Some(g) = weak.upgrade() else { break };
                        terms.set_isolate_terminals(g.settings().isolate_terminals);
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub fn shells(&self) -> Vec<ShellEntry> {
        self.shells.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn claude(&self) -> ClaudeProbe {
        self.claude.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn host_info(&self) -> pb::HostInfo {
        shell::build_host_info(
            &self.shells(),
            &self.claude(),
            self.inbox.config().max_file_size,
        )
    }

    /// 重新探测 Claude Code（用户装完之后）。
    pub async fn refresh_claude(&self) {
        let shells = self.shells();
        if let Some(sh) = shell::find_shell(&shells, "") {
            let probe = shell::probe_claude(sh).await;
            if let Ok(mut v) = self.env.claude_version.write() {
                *v = probe.available.then(|| probe.version.clone());
            }
            if let Ok(mut c) = self.claude.write() {
                *c = probe;
            }
        }
    }

    /// 用 `/config` 下发的 JSON 更新输入适配器规则；格式不对返回错误，继续使用旧规则。
    pub fn set_adapter_rules_json(&self, json: &str) -> Result<(), RulesError> {
        let rules = AdapterRules::from_json(json)?;
        if let Ok(mut r) = self.env.rules.write() {
            *r = rules;
        }
        Ok(())
    }

    /// 恢复内置的输入适配器规则（下发的规则没有可信签名时用）。
    pub fn reset_adapter_rules(&self) {
        if let Ok(mut r) = self.env.rules.write() {
            *r = AdapterRules::builtin();
        }
    }

    /// 用 `/config` 下发的 `claude_catalog`（对象或数组）更新动作目录。非法的整份丢弃，退回内置。
    /// 目录变化时，所有在线会话会收到新的 `ActionCatalog`。
    pub fn set_remote_catalog_json(&self, json: Option<&str>) {
        self.apply_catalog(json);
    }

    fn apply_catalog(&self, json: Option<&str>) {
        let ver = self.claude().available.then(|| self.claude().version);
        let cat = Arc::new(actions::pick_catalog(json, ver.as_deref()));
        let old = self
            .env
            .catalog
            .read()
            .map(|c| c.catalog_ver.clone())
            .unwrap_or_default();
        if old != cat.catalog_ver {
            tracing::info!("动作目录版本：{old} -> {}", cat.catalog_ver);
        }
        if let Ok(mut c) = self.env.catalog.write() {
            *c = cat.clone();
        }
        self.catalog_tx.send_replace(cat);
    }

    pub fn catalog(&self) -> Arc<Catalog> {
        self.catalog_tx.borrow().clone()
    }

    pub fn exec_env(&self) -> Arc<ExecEnv> {
        self.env.clone()
    }

    /// 在设置里开关文件接收。
    pub fn set_file_receive(&self, on: bool) {
        self.inbox.set_enabled(on);
    }

    fn features(&self) -> Vec<String> {
        let mut f = vec![
            "term.submit".to_string(),
            "app.actions".into(),
            "app.state".into(),
            "app.commands".into(),
        ];
        if self.inbox.is_enabled() {
            f.push("file.upload".into());
        }
        f
    }

    /// 关闭被控端：强杀全部终端（本机 IPC 随 `HostCtx` 丢弃而停止）。
    pub async fn shutdown(&self) {
        self.terms.close_all().await;
    }
}

/// 会话结束的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEnd {
    /// 链路断开（`Link.rx` 返回 None）
    LinkClosed,
    /// 对方发了 `Bye`
    Bye(String),
    /// 被本端主动断开（`kick`）
    Kicked,
    /// 握手阶段出错
    Handshake(String),
}

pub struct HostSession;

impl HostSession {
    pub async fn run(link: Link, ctx: Arc<HostCtx>) -> SessionEnd {
        Self::run_with_kick(link, ctx, Arc::new(Notify::new())).await
    }

    /// 与 `run` 相同，另外允许门面通过 `kick.notify_one()` 一键断开这条会话。
    pub async fn run_with_kick(link: Link, ctx: Arc<HostCtx>, kick: Arc<Notify>) -> SessionEnd {
        let id = ctx.next_session.fetch_add(1, Ordering::Relaxed);
        let owner = owner_of(&link.peer, id);
        let mut s = SessionState::new(id, ctx, link.tx.clone(), owner);
        let mut rx = link.rx;
        let end = s.serve(&mut rx, kick).await;
        s.finish().await;
        end
    }
}

struct SessionState {
    id: u64,
    /// 这条会话的主控设备标识（见 `owner_of`）
    owner: String,
    ctx: Arc<HostCtx>,
    tx: FrameTx,
    channels: HashMap<u32, String>,
    next_channel: u32,
    peer_features: HashSet<String>,
    done_files: Arc<std::sync::Mutex<HashMap<u64, PathBuf>>>,
    file_tx: Option<mpsc::Sender<pb::Frame>>,
    file_task: Option<tokio::task::JoinHandle<()>>,
}

/// 主控设备标识：握手认证出的设备码；没有设备码时用公钥；都没有（测试 / 未认证）就用会话号，
/// 这样它不会和任何别的会话相同，也就看不到别人的终端。同一台主控重连后设备码不变，所以仍是自己的终端。
pub fn owner_of(peer: &PeerInfo, session_id: u64) -> String {
    if !peer.device_code.is_empty() {
        return format!("dev:{}", peer.device_code);
    }
    if !peer.public_key.is_empty() {
        let hex: String = peer.public_key.iter().map(|b| format!("{b:02x}")).collect();
        return format!("pk:{hex}");
    }
    format!("anon:{session_id}")
}

fn frame(channel: u32, body: pb::frame::Body) -> pb::Frame {
    pb::Frame {
        channel,
        body: Some(body),
    }
}

impl SessionState {
    fn new(id: u64, ctx: Arc<HostCtx>, tx: FrameTx, owner: String) -> Self {
        let inbox_session = ctx.inbox.session();
        let done_files = inbox_session.done_files();
        let (file_tx, file_rx) = mpsc::channel::<pb::Frame>(64);
        let file_task = tokio::spawn(file_loop(inbox_session, tx.clone(), file_rx));
        Self {
            id,
            owner,
            ctx,
            tx,
            channels: HashMap::new(),
            next_channel: 1,
            peer_features: HashSet::new(),
            done_files,
            file_tx: Some(file_tx),
            file_task: Some(file_task),
        }
    }

    async fn send(&self, channel: u32, body: pb::frame::Body) -> bool {
        self.tx.send(frame(channel, body)).await.is_ok()
    }

    async fn send_error(&self, channel: u32, code: &str, message: &str, ref_id: u64) {
        let _ = self
            .send(
                channel,
                pb::frame::Body::Error(pb::Error {
                    code: code.into(),
                    message: message.into(),
                    ref_id,
                }),
            )
            .await;
    }

    fn sink(&self, channel: u32) -> Sink {
        Sink {
            session: self.id,
            channel,
            tx: self.tx.clone(),
            owner: self.owner.clone(),
        }
    }

    async fn serve(&mut self, rx: &mut mpsc::Receiver<pb::Frame>, kick: Arc<Notify>) -> SessionEnd {
        // 1. Hello
        let first = tokio::select! {
            f = tokio::time::timeout(HELLO_TIMEOUT, rx.recv()) => f,
            _ = kick.notified() => return SessionEnd::Kicked,
        };
        let hello = match first {
            Ok(Some(f)) => match f.body {
                Some(pb::frame::Body::Hello(h)) => h,
                _ => {
                    self.send_error(0, "BAD_REQUEST", "第一条消息必须是 Hello", 0)
                        .await;
                    return SessionEnd::Handshake("首帧不是 Hello".into());
                }
            },
            Ok(None) => return SessionEnd::LinkClosed,
            Err(_) => {
                self.send_error(0, "BAD_REQUEST", "等待 Hello 超时", 0)
                    .await;
                return SessionEnd::Handshake("Hello 超时".into());
            }
        };
        if hello.min_proto_ver > PROTO_VER || hello.proto_ver < MIN_PROTO_VER {
            self.send_error(0, "UNSUPPORTED", "协议版本不兼容，请升级客户端", 0)
                .await;
            let _ = self
                .send(
                    0,
                    pb::frame::Body::Bye(pb::Bye {
                        reason: "version".into(),
                    }),
                )
                .await;
            return SessionEnd::Handshake("协议版本不兼容".into());
        }
        self.peer_features = hello.features.iter().cloned().collect();
        let ack = pb::HelloAck {
            proto_ver: hello.proto_ver.min(PROTO_VER),
            app_version: self.ctx.config.app_version.clone(),
            features: self.ctx.features(),
            host: Some(self.ctx.host_info()),
        };
        if !self.send(0, pb::frame::Body::HelloAck(ack)).await {
            return SessionEnd::LinkClosed;
        }
        if self.peer_features.contains("app.actions") {
            let cat = self.ctx.catalog().to_pb();
            self.send(0, pb::frame::Body::ActionCatalog(cat)).await;
        }

        // 2. 主循环
        let mut catalog_rx = self.ctx.catalog_tx.subscribe();
        catalog_rx.mark_unchanged();
        loop {
            tokio::select! {
                f = rx.recv() => {
                    let Some(f) = f else { return SessionEnd::LinkClosed };
                    if let Some(end) = self.handle(f).await {
                        return end;
                    }
                }
                _ = kick.notified() => {
                    let _ = self.send(0, pb::frame::Body::Bye(pb::Bye { reason: "kicked".into() })).await;
                    return SessionEnd::Kicked;
                }
                changed = catalog_rx.changed() => {
                    if changed.is_ok() && self.peer_features.contains("app.actions") {
                        let cat = catalog_rx.borrow_and_update().to_pb();
                        self.send(0, pb::frame::Body::ActionCatalog(cat)).await;
                    }
                }
            }
        }
    }

    /// 返回 Some 表示会话应当结束。
    async fn handle(&mut self, f: pb::Frame) -> Option<SessionEnd> {
        let ch = f.channel;
        let body = f.body?;
        use pb::frame::Body as B;
        match body {
            B::Ping(p) => {
                self.send(0, B::Pong(pb::Pong { ts: p.ts })).await;
            }
            B::Bye(b) => return Some(SessionEnd::Bye(b.reason)),
            B::TermOpen(req) => self.on_term_open(req).await,
            B::TermList(_) => {
                let terms = self.ctx.terms.list_visible(&self.owner);
                self.send(0, B::TermListResp(pb::TermListResp { terms }))
                    .await;
            }
            B::TermAttach(req) => self.on_term_attach(req).await,
            B::TermClose(req) => self.on_term_close(req).await,
            B::FileBegin(_) | B::FileChunk(_) | B::FileEnd(_) | B::FileCancel(_) => {
                if let Some(tx) = &self.file_tx {
                    let _ = tx
                        .send(pb::Frame {
                            channel: ch,
                            body: Some(body),
                        })
                        .await;
                }
            }
            B::TermInput(_)
            | B::TermSubmit(_)
            | B::TermResize(_)
            | B::TermAck(_)
            | B::TermAction(_)
            | B::CommandListReq(_) => {
                self.on_term_frame(ch, body).await;
            }
            // 被控端不处理的方向（HelloAck、TermOutput 等）和未知分支：忽略
            _ => {}
        }
        None
    }

    fn alloc_channel(&mut self) -> u32 {
        let c = self.next_channel;
        self.next_channel = self.next_channel.wrapping_add(1).max(1);
        c
    }

    async fn on_term_open(&mut self, req: pb::TermOpen) {
        let ctx = self.ctx.clone();
        let shells = ctx.shells();
        let Some(sh) = shell::find_shell(&shells, &req.shell_id).cloned() else {
            return self
                .send_error(0, "SPAWN_FAILED", "未知的 shell", req.req_id)
                .await;
        };
        let cwd = if req.cwd.trim().is_empty() {
            shell::home_dir()
        } else {
            PathBuf::from(&req.cwd)
        };
        if !cwd.is_dir() {
            return self
                .send_error(0, "SPAWN_FAILED", "工作目录不存在", req.req_id)
                .await;
        }
        let profile = pb::Profile::try_from(req.profile).unwrap_or(pb::Profile::Shell);
        let mut env: Vec<(String, String)> = Vec::new();
        let (startup, title) = match profile {
            pb::Profile::Shell => (None, sh.name.clone()),
            pb::Profile::Claude => {
                let launch = req.launch.clone().unwrap_or_default();
                let bridge: Option<&BridgeArgs> = ctx.bridge_args.as_ref();
                let cmd =
                    match actions::build_claude_command(sh.kind.quote_style(), &launch, bridge) {
                        Ok(c) => c,
                        Err(e) => {
                            return self
                                .send_error(0, e.code(), &e.to_string(), req.req_id)
                                .await
                        }
                    };
                if let (Some(_), Some(server)) = (bridge, &ctx.bridge) {
                    env.push((status::ENV_ENDPOINT.into(), server.endpoint().to_string()));
                    if ctx.config.inject_statusline {
                        if let Some(u) = status::find_user_statusline(&cwd, &shell::home_dir()) {
                            env.push((status::ENV_USER_STATUSLINE.into(), u));
                        }
                    }
                }
                (Some(cmd), "Claude Code".to_string())
            }
            pb::Profile::Custom => {
                let c: String = req.command.chars().filter(|c| !c.is_control()).collect();
                if c.trim().is_empty() {
                    (None, sh.name.clone())
                } else {
                    (Some(c.clone()), c)
                }
            }
        };
        let channel = self.alloc_channel();
        let spec = OpenSpec {
            profile,
            shell: sh,
            cwd,
            cols: req.cols.clamp(1, 1000) as u16,
            rows: req.rows.clamp(1, 1000) as u16,
            startup_command: startup,
            title,
            env,
        };
        let sink = self.sink(channel);
        match ctx.terms.open(spec, sink, req.req_id).await {
            Ok(term) => {
                self.channels.insert(channel, term.id().to_string());
            }
            Err(e) => self.send_error(0, e.code, &e.message, req.req_id).await,
        }
    }

    async fn on_term_attach(&mut self, req: pb::TermAttach) {
        // 隔离开启时别人的终端与不存在不可区分，不泄露存在性
        let Some(term) = self.ctx.terms.get_visible(&req.term_id, &self.owner) else {
            return self
                .send_error(0, "TERM_NOT_FOUND", "终端不存在或已被清理", req.req_id)
                .await;
        };
        // 禁止抢占：另一个设备的存活会话还附着着，就不能把它顶掉
        // （同一设备重连、对方会话已死亡、终端未附着都允许）
        let probe = self.sink(0);
        if term.would_be_busy(&probe) {
            return self
                .send_error(0, "TERM_BUSY", "终端正被另一个设备使用", req.req_id)
                .await;
        }
        // 同一会话重复附着同一终端：换新通道，旧通道作废
        self.channels.retain(|_, t| t != &req.term_id);
        let channel = self.alloc_channel();
        self.channels.insert(channel, req.term_id.clone());
        let sink = self.sink(channel);
        if !term
            .attach(sink, req.req_id, req.last_seq, req.cols, req.rows)
            .await
        {
            self.channels.remove(&channel);
            self.send_error(0, "TERM_NOT_FOUND", "终端已关闭", req.req_id)
                .await;
        }
    }

    async fn on_term_close(&mut self, req: pb::TermClose) {
        match self.ctx.terms.get_visible(&req.term_id, &self.owner) {
            Some(t) => {
                // 与 TermAttach 一致：另一个设备的存活会话正占用这个终端时，不能把它关掉（审查 L3）
                let probe = self.sink(0);
                if t.would_be_busy(&probe) {
                    return self
                        .send_error(0, "TERM_BUSY", "终端正被另一个设备使用", 0)
                        .await;
                }
                t.close(req.kill).await
            }
            None => self.send_error(0, "TERM_NOT_FOUND", "终端不存在", 0).await,
        }
        self.channels.retain(|_, t| t != &req.term_id);
    }

    async fn on_term_frame(&mut self, ch: u32, body: pb::frame::Body) {
        use pb::frame::Body as B;
        let Some(term) = self.channels.get(&ch).and_then(|id| self.ctx.terms.get(id)) else {
            // 终端已不存在：动作要给出结果，其它的回错误
            if let B::TermAction(a) = &body {
                let r = pb::TermActionResult {
                    req_id: a.req_id,
                    ok: false,
                    error: "TERM_NOT_FOUND".into(),
                    ..Default::default()
                };
                self.send(ch, B::TermActionResult(r)).await;
            } else {
                self.send_error(ch, "TERM_NOT_FOUND", "该通道没有对应的终端", 0)
                    .await;
            }
            return;
        };
        match body {
            B::TermInput(i) => {
                if let Err(code) = term.write_input(self.id, i.data).await {
                    self.send_error(ch, code, "终端已被另一个会话接管或已关闭", 0)
                        .await;
                }
            }
            B::TermResize(r) => {
                let (c, rw) = (r.cols.clamp(1, 1000) as u16, r.rows.clamp(1, 1000) as u16);
                if let Err(code) = term.resize(self.id, c, rw) {
                    self.send_error(ch, code, "终端已被另一个会话接管", 0).await;
                }
            }
            B::TermAck(a) => term.ack(self.id, a.consumed).await,
            B::TermSubmit(m) => {
                let mut paths = Vec::new();
                for fid in &m.attachments {
                    let p = self
                        .done_files
                        .lock()
                        .ok()
                        .and_then(|d| d.get(fid).cloned());
                    match p {
                        Some(p) => paths.push(p.to_string_lossy().into_owned()),
                        None => {
                            return self
                                .send_error(ch, "BAD_REQUEST", "附件尚未上传完成", m.msg_id)
                                .await;
                        }
                    }
                }
                let msg_id = m.msg_id;
                if let Err(e) = term.submit(self.sink(ch), m, paths) {
                    self.send_error(ch, e.code(), &e.to_string(), msg_id).await;
                }
            }
            B::TermAction(a) => {
                let req_id = a.req_id;
                if let Err(e) = term.action(self.sink(ch), a) {
                    let r = pb::TermActionResult {
                        req_id,
                        ok: false,
                        error: e.code().into(),
                        ..Default::default()
                    };
                    self.send(ch, B::TermActionResult(r)).await;
                }
            }
            B::CommandListReq(_) => {
                let cwd = {
                    let st = term.app_state();
                    if st.cwd.is_empty() {
                        term.cwd.clone()
                    } else {
                        st.cwd
                    }
                };
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    let list = tokio::task::spawn_blocking(move || {
                        commands::scan_commands(Path::new(&cwd), &shell::home_dir())
                    })
                    .await
                    .unwrap_or_default();
                    let _ = tx
                        .send(frame(
                            ch,
                            B::CommandList(pb::CommandList { commands: list }),
                        ))
                        .await;
                });
            }
            _ => {}
        }
    }

    /// 会话结束：终端脱离（继续运行），未完成的上传文件被删除。
    async fn finish(&mut self) {
        self.ctx.terms.detach_session(self.id).await;
        self.file_tx = None; // 关闭通道，文件任务收尾并删除 .part
        if let Some(h) = self.file_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), h).await;
        }
    }
}

/// 文件任务：串行处理本会话的文件帧，不阻塞终端帧。
async fn file_loop(mut inbox: InboxSession, tx: FrameTx, mut rx: mpsc::Receiver<pb::Frame>) {
    use pb::frame::Body as B;
    let err = |code: &str, msg: &str, id: u64| pb::Frame {
        channel: 0,
        body: Some(B::Error(pb::Error {
            code: code.into(),
            message: msg.into(),
            ref_id: id,
        })),
    };
    while let Some(f) = rx.recv().await {
        let Some(body) = f.body else { continue };
        let out: Option<pb::Frame> = match body {
            B::FileBegin(b) => {
                let id = b.file_id;
                Some(match inbox.begin(&b).await {
                    Ok(a) => frame(0, B::FileAccept(a)),
                    Err(e) => err(e.code, &e.message, id),
                })
            }
            B::FileChunk(c) => {
                let id = c.file_id;
                match inbox.chunk(&c).await {
                    Ok(ChunkOutcome::Ack(ack)) => Some(frame(0, B::FileAck(ack))),
                    Ok(ChunkOutcome::Done(d)) => Some(frame(0, B::FileDone(d))),
                    Ok(ChunkOutcome::Continue) => None,
                    Err(e) => Some(err(e.code, &e.message, id)),
                }
            }
            B::FileEnd(e) => {
                let id = e.file_id;
                match inbox.end(&e).await {
                    Ok(Some(d)) => Some(frame(0, B::FileDone(d))),
                    Ok(None) => None, // FileEnd 先到了，等最后一块数据
                    Err(e) => Some(err(e.code, &e.message, id)),
                }
            }
            B::FileCancel(c) => {
                inbox.cancel(c.file_id).await;
                None
            }
            _ => None,
        };
        if let Some(o) = out {
            if tx.send(o).await.is_err() {
                break;
            }
        }
    }
    // 会话中断：删除所有未完成的 .part
    inbox.abort_all().await;
}
