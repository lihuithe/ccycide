//! shell 探测、Claude Code 探测、HostInfo 构建（《实现方案.md》5.5.1、5.5.2）。
use std::path::{Path, PathBuf};
use std::time::Duration;

use rterm_proto::pb;

/// shell 的种类。决定启动参数、UTF-8 设置方式和命令行引号规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// PowerShell 7（pwsh）
    Pwsh,
    /// Windows PowerShell 5.1
    WindowsPowerShell,
    Cmd,
    Bash,
    Zsh,
    Fish,
    Sh,
    /// Windows 上的 Git Bash
    GitBash,
    Wsl,
    Other,
}

/// 命令行引号规则（《开发指南.md》T39）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteStyle {
    PowerShell,
    Posix,
    Cmd,
}

impl ShellKind {
    pub fn quote_style(self) -> QuoteStyle {
        match self {
            ShellKind::Pwsh | ShellKind::WindowsPowerShell => QuoteStyle::PowerShell,
            ShellKind::Cmd => QuoteStyle::Cmd,
            _ => QuoteStyle::Posix,
        }
    }

    pub fn is_powershell(self) -> bool {
        matches!(self, ShellKind::Pwsh | ShellKind::WindowsPowerShell)
    }
}

#[derive(Debug, Clone)]
pub struct ShellEntry {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub kind: ShellKind,
    pub is_default: bool,
}

impl ShellEntry {
    /// 启动程序与参数。Windows 上同时处理 UTF-8：cmd 执行 `chcp 65001`，PowerShell 设置输出编码；
    /// Unix 上是登录 shell（`-l`），这样 PATH 才完整。
    pub fn launch_args(&self) -> Vec<String> {
        match self.kind {
            ShellKind::Cmd => vec!["/K".into(), "chcp 65001 >nul".into()],
            ShellKind::Pwsh | ShellKind::WindowsPowerShell => vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                "[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; $OutputEncoding=[Console]::OutputEncoding".into(),
            ],
            ShellKind::GitBash => vec!["--login".into(), "-i".into()],
            ShellKind::Wsl => vec![],
            ShellKind::Fish | ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh | ShellKind::Other => {
                if cfg!(windows) {
                    vec![]
                } else {
                    vec!["-l".into()]
                }
            }
        }
    }
}

fn kind_from_path(p: &Path) -> ShellKind {
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "pwsh" => ShellKind::Pwsh,
        "powershell" => ShellKind::WindowsPowerShell,
        "cmd" => ShellKind::Cmd,
        "bash" => ShellKind::Bash,
        "zsh" => ShellKind::Zsh,
        "fish" => ShellKind::Fish,
        "sh" | "dash" | "ash" => ShellKind::Sh,
        _ => ShellKind::Other,
    }
}

/// 在 PATH 里找可执行文件（Windows 补 `.exe`）。
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(if cfg!(windows) && !name.contains('.') {
            format!("{name}.exe")
        } else {
            name.to_string()
        });
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 探测本机可用的 shell，默认项排在最前并标记 `is_default`。
pub fn detect_shells() -> Vec<ShellEntry> {
    let mut list = if cfg!(windows) {
        detect_windows()
    } else {
        detect_unix()
    };
    if let Some(first) = list.first_mut() {
        first.is_default = true;
    }
    list
}

fn detect_windows() -> Vec<ShellEntry> {
    let mut out: Vec<ShellEntry> = Vec::new();
    let push = |out: &mut Vec<ShellEntry>, id: &str, name: &str, path: PathBuf, kind: ShellKind| {
        if path.is_file() && !out.iter().any(|e| e.id == id) {
            out.push(ShellEntry {
                id: id.into(),
                name: name.into(),
                path,
                kind,
                is_default: false,
            });
        }
    };
    // 默认顺序：pwsh -> powershell -> cmd
    let pwsh = which("pwsh").or_else(|| {
        let p = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        p.is_file().then_some(p)
    });
    if let Some(p) = pwsh {
        push(&mut out, "pwsh", "PowerShell 7", p, ShellKind::Pwsh);
    }
    if let Some(p) = which("powershell") {
        push(
            &mut out,
            "powershell",
            "Windows PowerShell",
            p,
            ShellKind::WindowsPowerShell,
        );
    }
    let sysroot = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let cmd = which("cmd").unwrap_or_else(|| sysroot.join(r"System32\cmd.exe"));
    push(&mut out, "cmd", "命令提示符", cmd, ShellKind::Cmd);

    // 可选项：Git Bash、WSL
    let mut git_bash: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Some(git) = which("git") {
        // git.exe 通常在 <Git>\cmd\git.exe，bash 在 <Git>\bin\bash.exe
        if let Some(root) = git.parent().and_then(|p| p.parent()) {
            git_bash.insert(0, root.join(r"bin\bash.exe"));
        }
    }
    if let Some(p) = git_bash.into_iter().find(|p| p.is_file()) {
        push(&mut out, "gitbash", "Git Bash", p, ShellKind::GitBash);
    }
    push(
        &mut out,
        "wsl",
        "WSL",
        sysroot.join(r"System32\wsl.exe"),
        ShellKind::Wsl,
    );
    out
}

fn detect_unix() -> Vec<ShellEntry> {
    let mut out: Vec<ShellEntry> = Vec::new();
    let mut add = |path: PathBuf| {
        if !path.is_file() {
            return;
        }
        let kind = kind_from_path(&path);
        let id = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if id.is_empty() || out.iter().any(|e| e.path == path || e.id == id) {
            return;
        }
        out.push(ShellEntry {
            name: id.clone(),
            id,
            path,
            kind,
            is_default: false,
        });
    };
    // $SHELL -> /etc/passwd 里的登录 shell -> /bin/bash -> /bin/sh
    if let Some(s) = std::env::var_os("SHELL") {
        add(PathBuf::from(s));
    }
    if let Some(s) = passwd_shell() {
        add(PathBuf::from(s));
    }
    add(PathBuf::from("/bin/bash"));
    add(PathBuf::from("/bin/sh"));
    // 其余列在 /etc/shells 里的，作为可选项
    if let Ok(text) = std::fs::read_to_string("/etc/shells") {
        for line in text
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('/'))
            .take(12)
        {
            add(PathBuf::from(line));
        }
    }
    out
}

#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*pw).pw_shell)
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}

#[cfg(not(unix))]
fn passwd_shell() -> Option<String> {
    None
}

/// 按 id 找 shell；`id` 为空返回默认项。
pub fn find_shell<'a>(shells: &'a [ShellEntry], id: &str) -> Option<&'a ShellEntry> {
    if id.is_empty() {
        shells
            .iter()
            .find(|s| s.is_default)
            .or_else(|| shells.first())
    } else {
        shells.iter().find(|s| s.id == id)
    }
}

/// 用户主目录。
pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { r"C:\" } else { "/" }))
}

pub fn username() -> String {
    let var = if cfg!(windows) { "USERNAME" } else { "USER" };
    std::env::var(var).unwrap_or_default()
}

pub fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_default()
}

/// Claude Code 探测结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeProbe {
    pub available: bool,
    pub version: String,
}

/// 从 `claude --version` 的输出中取版本号（形如 `2.1.322 (Claude Code)`）。
pub fn parse_claude_version(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let tok = l.split_whitespace().next()?;
        let ok = tok.chars().next().is_some_and(|c| c.is_ascii_digit()) && tok.contains('.');
        ok.then(|| tok.to_string())
    })
}

/// 在默认 shell 里执行一次 `claude --version`，超时 5 秒。
pub async fn probe_claude(shell: &ShellEntry) -> ClaudeProbe {
    probe_claude_with(shell, "claude --version", Duration::from_secs(5)).await
}

pub async fn probe_claude_with(
    shell: &ShellEntry,
    command: &str,
    timeout: Duration,
) -> ClaudeProbe {
    let mut cmd = tokio::process::Command::new(&shell.path);
    match shell.kind {
        ShellKind::Cmd => {
            cmd.args(["/D", "/C", command]);
        }
        ShellKind::Pwsh | ShellKind::WindowsPowerShell => {
            cmd.args(["-NoLogo", "-NoProfile", "-Command", command]);
        }
        ShellKind::GitBash => {
            cmd.args(["--login", "-c", command]);
        }
        ShellKind::Wsl => {
            cmd.args(["-e", "sh", "-lc", command]);
        }
        _ => {
            cmd.args(["-l", "-c", command]);
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：不要弹出控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    let run = async {
        let out = cmd.output().await.ok()?;
        if !out.status.success() {
            return None;
        }
        parse_claude_version(&String::from_utf8_lossy(&out.stdout))
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(Some(v)) => ClaudeProbe {
            available: true,
            version: v,
        },
        _ => ClaudeProbe::default(),
    }
}

pub fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 构建 `HostInfo`（放进 `HelloAck`）。
pub fn build_host_info(
    shells: &[ShellEntry],
    claude: &ClaudeProbe,
    max_file_size: u64,
) -> pb::HostInfo {
    pb::HostInfo {
        platform: platform_name().into(),
        arch: std::env::consts::ARCH.into(),
        hostname: hostname(),
        username: username(),
        home_dir: home_dir().to_string_lossy().into_owned(),
        shells: shells
            .iter()
            .map(|s| pb::ShellInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                path: s.path.to_string_lossy().into_owned(),
                is_default: s.is_default,
            })
            .collect(),
        claude_available: claude.available,
        claude_version: claude.version.clone(),
        max_file_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_has_default() {
        let list = detect_shells();
        assert!(!list.is_empty());
        assert_eq!(list.iter().filter(|s| s.is_default).count(), 1);
        assert!(find_shell(&list, "").is_some());
        if cfg!(windows) {
            assert!(list.iter().any(|s| s.id == "cmd"));
            // 默认项是 pwsh -> powershell -> cmd 里最靠前的
            let d = find_shell(&list, "")
                .map(|s| s.id.clone())
                .unwrap_or_default();
            assert!(["pwsh", "powershell", "cmd"].contains(&d.as_str()));
        }
    }

    #[test]
    fn version_parse() {
        assert_eq!(
            parse_claude_version("2.1.322 (Claude Code)\n").as_deref(),
            Some("2.1.322")
        );
        assert_eq!(
            parse_claude_version("hello\n1.0.0\n").as_deref(),
            Some("1.0.0")
        );
        assert_eq!(parse_claude_version("command not found"), None);
        assert_eq!(parse_claude_version(""), None);
    }

    #[tokio::test]
    async fn probe_missing_command_is_unavailable() {
        let shells = detect_shells();
        let sh = find_shell(&shells, "").expect("shell");
        let r = probe_claude_with(
            sh,
            "definitely-not-a-real-command-xyz --version",
            Duration::from_secs(5),
        )
        .await;
        assert!(!r.available);
    }

    #[tokio::test]
    async fn probe_timeout_is_unavailable() {
        let shells = detect_shells();
        let sh = find_shell(&shells, "cmd")
            .or_else(|| find_shell(&shells, ""))
            .expect("shell");
        let slow = if cfg!(windows) {
            "ping -n 20 127.0.0.1"
        } else {
            "sleep 20"
        };
        let t = std::time::Instant::now();
        let r = probe_claude_with(sh, slow, Duration::from_millis(500)).await;
        assert!(!r.available);
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn host_info_fields() {
        let shells = detect_shells();
        let info = build_host_info(
            &shells,
            &ClaudeProbe {
                available: true,
                version: "2.1.0".into(),
            },
            123,
        );
        assert_eq!(info.max_file_size, 123);
        assert!(info.claude_available);
        assert_eq!(info.platform, platform_name());
        assert!(!info.shells.is_empty());
    }

    #[test]
    fn cmd_uses_utf8_codepage() {
        let e = ShellEntry {
            id: "cmd".into(),
            name: "cmd".into(),
            path: "cmd.exe".into(),
            kind: ShellKind::Cmd,
            is_default: false,
        };
        assert_eq!(e.launch_args(), vec!["/K", "chcp 65001 >nul"]);
    }
}
