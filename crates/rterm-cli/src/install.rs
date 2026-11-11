//! `install` / `uninstall`：把 `rterm-cli host` 装成用户级后台服务。
//!
//! - Linux：systemd user unit（`~/.config/systemd/user/rterm.service`），并检查 `loginctl` 的 linger；
//! - macOS：launchd agent（`~/Library/LaunchAgents/com.rterm.host.plist`）；
//! - Windows：不支持（请用桌面版，或把 `rterm-cli host` 放进任务计划程序）。
//!
//! 生成文件内容的函数是纯函数，有单元测试；写文件和调用 `systemctl` / `launchctl` 在 [`install`] / [`uninstall`] 里。
use std::path::{Path, PathBuf};
use std::process::Command;

pub const UNIT_NAME: &str = "rterm.service";
pub const PLIST_LABEL: &str = "com.rterm.host";

/// systemd 的 ExecStart 里，含空格的参数要加引号，`%` 要写成 `%%`。
fn systemd_quote(s: &str) -> String {
    let esc = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    if esc.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{esc}\"")
    } else {
        esc
    }
}

/// systemd user unit 的内容。`extra_args` 是 `host` 之后附加的参数（如 `--data-dir`）。
pub fn systemd_unit(exe: &Path, extra_args: &[String], env: &[(String, String)]) -> String {
    let mut exec = format!("{} host --quiet", systemd_quote(&exe.to_string_lossy()));
    for a in extra_args {
        exec.push(' ');
        exec.push_str(&systemd_quote(a));
    }
    let mut s = String::new();
    s.push_str("[Unit]\n");
    s.push_str("Description=RTerm 被控端（远程终端）\n");
    s.push_str("After=network-online.target\n");
    s.push_str("Wants=network-online.target\n\n");
    s.push_str("[Service]\n");
    s.push_str("Type=simple\n");
    s.push_str(&format!("ExecStart={exec}\n"));
    for (k, v) in env {
        s.push_str(&format!(
            "Environment={}\n",
            systemd_quote(&format!("{k}={v}"))
        ));
    }
    s.push_str("Restart=on-failure\n");
    s.push_str("RestartSec=5\n");
    s.push_str("KillSignal=SIGTERM\n");
    s.push_str("TimeoutStopSec=15\n\n");
    s.push_str("[Install]\n");
    s.push_str("WantedBy=default.target\n");
    s
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// launchd agent 的 plist 内容。
pub fn launchd_plist(
    exe: &Path,
    extra_args: &[String],
    env: &[(String, String)],
    log_path: &Path,
) -> String {
    let mut args = vec![
        exe.to_string_lossy().into_owned(),
        "host".to_string(),
        "--quiet".to_string(),
    ];
    args.extend(extra_args.iter().cloned());
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    s.push_str("<plist version=\"1.0\">\n<dict>\n");
    s.push_str(&format!(
        "  <key>Label</key>\n  <string>{PLIST_LABEL}</string>\n"
    ));
    s.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    for a in &args {
        s.push_str(&format!("    <string>{}</string>\n", xml_escape(a)));
    }
    s.push_str("  </array>\n");
    if !env.is_empty() {
        s.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
        for (k, v) in env {
            s.push_str(&format!(
                "    <key>{}</key>\n    <string>{}</string>\n",
                xml_escape(k),
                xml_escape(v)
            ));
        }
        s.push_str("  </dict>\n");
    }
    s.push_str("  <key>RunAtLoad</key>\n  <true/>\n");
    s.push_str("  <key>KeepAlive</key>\n  <true/>\n");
    let log = xml_escape(&log_path.to_string_lossy());
    s.push_str(&format!(
        "  <key>StandardOutPath</key>\n  <string>{log}</string>\n"
    ));
    s.push_str(&format!(
        "  <key>StandardErrorPath</key>\n  <string>{log}</string>\n"
    ));
    s.push_str("</dict>\n</plist>\n");
    s
}

pub fn systemd_unit_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("systemd")
        .join("user")
        .join(UNIT_NAME)
}

pub fn launchd_plist_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{PLIST_LABEL}.plist"))
}

/// 要带进服务环境的变量：当前进程里设置了的 `RTERM_*`（数据目录、服务器地址等）。
pub fn env_to_persist() -> Vec<(String, String)> {
    ["RTERM_DATA_DIR", "RTERM_API_URL", "RTERM_NO_KEYRING"]
        .iter()
        .filter_map(|k| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| (k.to_string(), v))
        })
        .collect()
}

pub struct InstallOptions {
    pub exe: PathBuf,
    pub extra_args: Vec<String>,
    pub log_path: PathBuf,
    /// 只写文件，不启动服务
    pub no_start: bool,
    /// 只打印将要写入的内容，不写文件
    pub print_only: bool,
}

fn home() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("无法确定用户主目录"))
}

fn run(cmd: &str, args: &[&str]) -> anyhow::Result<()> {
    let out = Command::new(cmd).args(args).output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => anyhow::bail!(
            "{cmd} {} 失败：{}",
            args.join(" "),
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => anyhow::bail!("无法运行 {cmd}：{e}"),
    }
}

/// `loginctl enable-linger` 未开启时，用户退出登录后服务会停止。
fn linger_enabled() -> Option<bool> {
    let user = std::env::var("USER").ok()?;
    let out = Command::new("loginctl")
        .args(["show-user", &user, "-p", "Linger"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).contains("Linger=yes"))
}

pub fn install(o: &InstallOptions) -> anyhow::Result<()> {
    let env = env_to_persist();
    if cfg!(target_os = "linux") {
        let content = systemd_unit(&o.exe, &o.extra_args, &env);
        let path = systemd_unit_path(&home()?);
        if o.print_only {
            println!("# {}\n{content}", path.display());
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, content)?;
        println!("已写入 {}", path.display());
        if o.no_start {
            println!("未启动。手动启动：systemctl --user enable --now rterm");
        } else {
            run("systemctl", &["--user", "daemon-reload"])?;
            run("systemctl", &["--user", "enable", "--now", "rterm"])?;
            println!("已启用并启动：systemctl --user status rterm");
        }
        if linger_enabled() == Some(false) {
            let user = std::env::var("USER").unwrap_or_else(|_| "<用户名>".into());
            println!(
                "注意：当前用户没有开启 linger，退出登录后服务会停止。请执行：\n  loginctl enable-linger {user}"
            );
        }
        Ok(())
    } else if cfg!(target_os = "macos") {
        let content = launchd_plist(&o.exe, &o.extra_args, &env, &o.log_path);
        let path = launchd_plist_path(&home()?);
        if o.print_only {
            println!("<!-- {} -->\n{content}", path.display());
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, content)?;
        println!("已写入 {}", path.display());
        if o.no_start {
            println!("未启动。手动启动：launchctl load -w {}", path.display());
        } else {
            let p = path.to_string_lossy().into_owned();
            let _ = run("launchctl", &["unload", &p]);
            run("launchctl", &["load", "-w", &p])?;
            println!("已加载并启动（{PLIST_LABEL}）");
        }
        Ok(())
    } else {
        anyhow::bail!(
            "Windows 上不支持安装为后台服务：请使用桌面版（开机自启 + 托盘），\
             或把 `rterm-cli host` 放进任务计划程序"
        )
    }
}

pub fn uninstall() -> anyhow::Result<()> {
    if cfg!(target_os = "linux") {
        let path = systemd_unit_path(&home()?);
        let _ = run("systemctl", &["--user", "disable", "--now", "rterm"]);
        if path.exists() {
            std::fs::remove_file(&path)?;
            let _ = run("systemctl", &["--user", "daemon-reload"]);
            println!("已移除 {}", path.display());
        } else {
            println!("没有安装过（{} 不存在）", path.display());
        }
        Ok(())
    } else if cfg!(target_os = "macos") {
        let path = launchd_plist_path(&home()?);
        if path.exists() {
            let _ = run("launchctl", &["unload", "-w", &path.to_string_lossy()]);
            std::fs::remove_file(&path)?;
            println!("已移除 {}", path.display());
        } else {
            println!("没有安装过（{} 不存在）", path.display());
        }
        Ok(())
    } else {
        anyhow::bail!("Windows 上没有安装过后台服务")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_contains_exec_restart_and_install_sections() {
        let u = systemd_unit(
            Path::new("/home/me/bin/rterm-cli"),
            &[],
            &[("RTERM_API_URL".into(), "https://api.example.com".into())],
        );
        assert!(u.contains("ExecStart=/home/me/bin/rterm-cli host --quiet\n"));
        assert!(u.contains("Environment=RTERM_API_URL=https://api.example.com\n"));
        assert!(u.contains("Restart=on-failure"));
        assert!(u.contains("[Install]\nWantedBy=default.target"));
        assert!(u.contains("After=network-online.target"));
    }

    #[test]
    fn unit_quotes_spaces_and_percent() {
        let u = systemd_unit(
            Path::new("/opt/my apps/rterm-cli"),
            &["--data-dir".into(), "/data/100%/rterm dir".into()],
            &[],
        );
        assert!(u.contains(
            "ExecStart=\"/opt/my apps/rterm-cli\" host --quiet --data-dir \"/data/100%%/rterm dir\"\n"
        ));
    }

    #[test]
    fn plist_is_wellformed_enough() {
        let p = launchd_plist(
            Path::new("/Applications/RTerm & Co/rterm-cli"),
            &["--data-dir".into(), "/x".into()],
            &[("RTERM_API_URL".into(), "https://a.b".into())],
            Path::new("/tmp/rterm.log"),
        );
        assert!(p.contains("<key>Label</key>\n  <string>com.rterm.host</string>"));
        assert!(p.contains("<string>/Applications/RTerm &amp; Co/rterm-cli</string>"));
        assert!(p.contains("<string>host</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(p.contains("<key>RTERM_API_URL</key>"));
        assert!(p.trim_end().ends_with("</plist>"));
    }

    #[test]
    fn unit_paths_under_home() {
        let h = Path::new("/home/me");
        assert!(systemd_unit_path(h).ends_with(".config/systemd/user/rterm.service"));
        assert!(launchd_plist_path(h).ends_with("Library/LaunchAgents/com.rterm.host.plist"));
    }
}
