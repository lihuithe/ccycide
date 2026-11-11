//! `rterm-cli`：命令行版（没有桌面的机器做被控端），同时是 Claude Code 状态回传 hook 的可执行文件。
//!
//! 子命令见 `rterm-cli --help`（《实现方案.md》5.8）。后台进程是 `rterm-cli host`，
//! `status` / `passwd` / `config` / `accept` 等通过本机 IPC（见 `ipc.rs`）和它通信；后台进程没运行时，
//! `id`、`config`、`passwd --set` 直接读写本地配置和机密存储。
mod install;
mod ipc;

use std::ffi::OsString;
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use rterm_core::config::{ConfigStore, Paths};
use rterm_core::core::{format_device_code, Core, CoreKind, CoreOptions, LocalStore};
use rterm_core::events::CoreEvent;
use rterm_core::settings::Settings;
use tokio::sync::Notify;

use ipc::{Request, Response, StatusData};

#[derive(Parser)]
#[command(
    name = "rterm-cli",
    version,
    about = "RTerm 命令行版：在没有桌面的机器上做被控端",
    disable_help_subcommand = true
)]
struct Cli {
    /// 数据目录（默认平台标准位置；也可用环境变量 RTERM_DATA_DIR）
    #[arg(long, global = true, value_name = "DIR")]
    data_dir: Option<PathBuf>,
    /// 服务器地址（默认环境变量 RTERM_API_URL，再默认配置文件里的值）
    #[arg(long, global = true, value_name = "URL")]
    api_url: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 前台运行被控端，打印设备码和密码（Ctrl+C 退出）
    Host {
        /// 不打印设备码和密码（作为后台服务运行时用）
        #[arg(long)]
        quiet: bool,
        /// 同时把日志输出到 stderr
        #[arg(long)]
        verbose: bool,
    },
    /// 查看后台进程的运行状态和当前连接
    Status {
        #[arg(long)]
        json: bool,
    },
    /// 显示设备码
    Id {
        /// 只输出 9 位数字，不加空格
        #[arg(long)]
        raw: bool,
    },
    /// 密码管理：不带参数显示当前临时密码
    Passwd {
        /// 刷新临时密码
        #[arg(long, conflicts_with_all = ["set", "clear"])]
        random: bool,
        /// 设置固定密码（交互输入）
        #[arg(long, conflicts_with = "clear")]
        set: bool,
        /// 清除固定密码
        #[arg(long)]
        clear: bool,
        /// 与 --set 合用：从标准输入读取密码（脚本用）
        #[arg(long, requires = "set")]
        stdin: bool,
    },
    /// 读写配置（项用点分路径，如 host.requireConfirm）
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },
    /// 安装为用户级后台服务（Linux systemd user unit / macOS launchd agent）
    Install {
        /// 只写文件，不启动
        #[arg(long)]
        no_start: bool,
        /// 只打印将要写入的内容
        #[arg(long)]
        print: bool,
    },
    /// 卸载后台服务
    Uninstall,
    /// 查看日志
    Logs {
        /// 显示最后多少行
        #[arg(short = 'n', long, default_value_t = 100)]
        lines: usize,
        /// 持续输出新日志
        #[arg(short, long)]
        follow: bool,
    },
    /// 接受等待确认的来访连接（开启“连入需确认”时）
    Accept { session: Option<String> },
    /// 拒绝等待确认的来访连接
    Reject { session: Option<String> },
    /// 断开来访会话
    Disconnect {
        session: Option<String>,
        /// 断开全部
        #[arg(long)]
        all: bool,
    },
    /// 让后台进程优雅退出
    Stop,
    /// Claude Code 的 hook / 状态栏命令（内部使用，不启动异步运行时）
    #[command(hide = true)]
    Hook {
        #[arg(long)]
        statusline: bool,
    },
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// 读取（不带项时输出全部）
    Get { key: Option<String> },
    /// 设置，值按 JSON 解析，解析不了当作字符串
    Set { key: String, value: String },
}

fn main() -> ExitCode {
    // hook：同步代码，不解析完整命令行，不启动 tokio，越快越好
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "hook") {
        let statusline = args.iter().skip(2).any(|a| a == "--statusline");
        rterm_core::host::status::hook_main(statusline);
    }

    let cli = Cli::parse();
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("错误: 无法启动运行时：{e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run(cli)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("错误: {e:#}");
            ExitCode::FAILURE
        }
    }
}

struct Global {
    data_dir: Option<PathBuf>,
    api_url: Option<String>,
}

impl Global {
    fn paths(&self) -> Result<Paths> {
        match &self.data_dir {
            Some(d) => Ok(Paths::from_root(d)),
            None => Paths::standard().ok_or_else(|| anyhow!("无法确定数据目录")),
        }
    }

    /// 命令行 `--data-dir` / `--api-url` 原样传给安装出来的服务。
    fn passthrough_args(&self) -> Vec<String> {
        let mut v = Vec::new();
        if let Some(d) = &self.data_dir {
            v.push("--data-dir".into());
            v.push(d.to_string_lossy().into_owned());
        }
        if let Some(u) = &self.api_url {
            v.push("--api-url".into());
            v.push(u.clone());
        }
        v
    }
}

async fn run(cli: Cli) -> Result<ExitCode> {
    let g = Global {
        data_dir: cli.data_dir,
        api_url: cli.api_url,
    };
    match cli.cmd {
        Cmd::Host { quiet, verbose } => cmd_host(&g, quiet, verbose).await,
        Cmd::Status { json } => cmd_status(&g, json).await,
        Cmd::Id { raw } => cmd_id(&g, raw),
        Cmd::Passwd {
            random,
            set,
            clear,
            stdin,
        } => cmd_passwd(&g, random, set, clear, stdin).await,
        Cmd::Config { action } => cmd_config(&g, action).await,
        Cmd::Install { no_start, print } => {
            let paths = g.paths()?;
            install::install(&install::InstallOptions {
                exe: std::env::current_exe().context("无法确定自身路径")?,
                extra_args: g.passthrough_args(),
                log_path: paths.logs_dir().join("service.log"),
                no_start,
                print_only: print,
            })?;
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Uninstall => {
            install::uninstall()?;
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Logs { lines, follow } => cmd_logs(&g, lines, follow).await,
        Cmd::Accept { session } => simple_ipc(&g, Request::Accept { session }, "已接受").await,
        Cmd::Reject { session } => simple_ipc(&g, Request::Reject { session }, "已拒绝").await,
        Cmd::Disconnect { session, all } => {
            if session.is_none() && !all {
                bail!("请指定会话 id，或加 --all 断开全部");
            }
            simple_ipc(&g, Request::Disconnect { session, all }, "已断开").await
        }
        Cmd::Stop => simple_ipc(&g, Request::Stop, "已通知后台进程退出").await,
        Cmd::Hook { statusline } => rterm_core::host::status::hook_main(statusline),
    }
}

/// 向后台进程发请求；没运行时给出明确提示。
async fn ipc_call(g: &Global, req: &Request) -> Result<Response> {
    let paths = g.paths()?;
    match ipc::request(&paths.config_dir, req).await {
        Ok(r) => Ok(r),
        Err(e) if is_not_running(&e) => bail!(
            "后台进程没有运行（数据目录 {}）。先运行 `rterm-cli host`，或安装为服务 `rterm-cli install`",
            paths.config_dir.display()
        ),
        Err(e) => Err(anyhow!("无法与后台进程通信：{e}")),
    }
}

fn is_not_running(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        NotFound | ConnectionRefused | ConnectionReset | BrokenPipe
    ) || e.raw_os_error() == Some(2)
}

async fn simple_ipc(g: &Global, req: Request, ok_text: &str) -> Result<ExitCode> {
    let r = ipc_call(g, &req).await?;
    if r.ok {
        println!("{ok_text}");
        Ok(ExitCode::SUCCESS)
    } else {
        bail!("{}", r.error.unwrap_or_else(|| "失败".into()))
    }
}

// ------------------------------------------------------------------ host

async fn cmd_host(g: &Global, quiet: bool, verbose: bool) -> Result<ExitCode> {
    let paths = g.paths()?;
    std::fs::create_dir_all(&paths.config_dir).ok();
    std::fs::create_dir_all(paths.logs_dir()).ok();
    let _log = rterm_core::logging::init(&paths.logs_dir(), verbose);

    // 先占住 IPC 端点：同一个数据目录只允许一个实例
    let listener = ipc::bind(&paths.config_dir)
        .await
        .map_err(|e| anyhow!("{e}"))?;

    let mut opts = CoreOptions::new(CoreKind::Cli, env!("CARGO_PKG_VERSION"));
    opts.data_dir = g.data_dir.clone();
    opts.api_url = g.api_url.clone();
    let (core, mut events) = Core::start(opts).await.map_err(|e| anyhow!("{e}"))?;
    tracing::info!("rterm-cli host 启动");

    let stop = Arc::new(Notify::new());
    let started = Instant::now();
    tokio::spawn(ipc::serve(listener, core.clone(), stop.clone(), started));

    let mut shown_code = false;
    let mut last_error: Option<String> = None;
    let mut last_temp = String::new();
    let announce = |core: &Core, quiet: bool| {
        let info = core.local_info();
        if !quiet {
            println!("设备码: {}", format_device_code(&info.device_code));
            println!("密码:   {}", info.temp_password);
            if info.fixed_password_set {
                println!("        （另有固定密码，用 `rterm-cli passwd --set` 修改）");
            }
        }
        info
    };
    let info = core.local_info();
    if info.registered {
        let i = announce(&core, quiet);
        last_temp = i.temp_password;
        shown_code = true;
        if !quiet {
            println!("按 Ctrl+C 退出");
        }
    } else if let Some(e) = info.last_error {
        println!("[错误] {e}");
        println!("       将每隔几秒自动重试，Ctrl+C 退出");
        last_error = Some(e);
    }

    #[cfg(unix)]
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        #[cfg(unix)]
        let term = sigterm.recv();
        #[cfg(not(unix))]
        let term = std::future::pending::<Option<()>>();
        tokio::select! {
            ev = events.recv() => {
                let Some(ev) = ev else { break };
                match ev {
                    CoreEvent::IncomingSession { session, from_code, platform, pending_confirm, .. } => {
                        let who = ipc::mask(&from_code);
                        if pending_confirm {
                            println!("[待确认] {who}（{platform}）请求连入，运行 `rterm-cli accept` 或 `reject` 处理（会话 {session}）");
                        } else {
                            println!("[连入] {who}（{platform}）会话 {session}");
                        }
                    }
                    CoreEvent::IncomingClosed { session } => println!("[断开] 会话 {session}"),
                    CoreEvent::SignalState { online } => {
                        println!("[信令] {}", if online { "在线" } else { "离线，重连中" });
                    }
                    CoreEvent::Notice { level, text, .. } => println!("[{level}] {text}"),
                    CoreEvent::UpgradeRequired { min_version, current_version, .. } => {
                        println!("[升级] 当前版本 {current_version} 低于服务器要求的最低版本 {min_version}，请升级后再使用");
                    }
                    CoreEvent::LocalInfoChanged { info } => {
                        if info.registered && !shown_code {
                            shown_code = true;
                            last_temp = info.temp_password.clone();
                            if !quiet {
                                println!("[已注册]");
                                println!("设备码: {}", format_device_code(&info.device_code));
                                println!("密码:   {}", info.temp_password);
                                println!("按 Ctrl+C 退出");
                            }
                        } else if info.registered && info.temp_password != last_temp {
                            last_temp = info.temp_password.clone();
                            if !quiet {
                                println!("[密码] 临时密码已刷新: {}", info.temp_password);
                            }
                        } else if !info.registered && info.last_error != last_error {
                            if let Some(e) = &info.last_error {
                                println!("[错误] {e}");
                            }
                            last_error = info.last_error.clone();
                        }
                    }
                    _ => {}
                }
            }
            _ = tokio::signal::ctrl_c() => {
                println!("正在退出…");
                break;
            }
            _ = term => {
                tracing::info!("收到 SIGTERM");
                break;
            }
            _ = stop.notified() => {
                println!("收到停止请求，正在退出…");
                break;
            }
        }
    }
    core.shutdown().await;
    ipc::cleanup(&paths.config_dir);
    tracing::info!("rterm-cli host 已退出");
    println!("已退出");
    Ok(ExitCode::SUCCESS)
}

// ------------------------------------------------------------------ status / id / passwd / config

async fn cmd_status(g: &Global, json: bool) -> Result<ExitCode> {
    let paths = g.paths()?;
    let resp = match ipc::request(&paths.config_dir, &Request::Status).await {
        Ok(r) => r,
        Err(e) if is_not_running(&e) => {
            if json {
                println!("{}", serde_json::json!({ "running": false }));
            } else {
                println!("后台进程   未运行");
                if let Some(code) = read_device_code(&paths) {
                    println!("设备码     {}（上次运行时注册）", format_device_code(&code));
                }
                println!(
                    "提示       用 `rterm-cli host` 前台运行，或 `rterm-cli install` 安装为服务"
                );
            }
            return Ok(ExitCode::from(3));
        }
        Err(e) => bail!("无法与后台进程通信：{e}"),
    };
    if !resp.ok {
        bail!("{}", resp.error.unwrap_or_default());
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&resp.data)?);
    } else {
        let s: StatusData = serde_json::from_value(resp.data)?;
        print!("{}", ipc::render_status(&s));
    }
    Ok(ExitCode::SUCCESS)
}

fn read_device_code(paths: &Paths) -> Option<String> {
    ConfigStore::open(paths.config_file())
        .ok()
        .and_then(|c| c.get().device.device_code)
}

fn cmd_id(g: &Global, raw: bool) -> Result<ExitCode> {
    let paths = g.paths()?;
    match read_device_code(&paths) {
        Some(c) if raw => println!("{c}"),
        Some(c) => println!("{}", format_device_code(&c)),
        None => bail!("本机还没有设备码，请先运行一次 `rterm-cli host`（需要能连上服务器）"),
    }
    Ok(ExitCode::SUCCESS)
}

fn read_password(from_stdin: bool) -> Result<String> {
    if from_stdin {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        return Ok(s.trim_end_matches(['\r', '\n']).to_string());
    }
    if !std::io::stdin().is_terminal() {
        bail!("标准输入不是终端；脚本里请加 --stdin");
    }
    let a = rpassword::prompt_password(
        "新的固定密码（至少 10 位，含大小写字母、数字、符号中的至少 3 类）: ",
    )?;
    let b = rpassword::prompt_password("再输入一次: ")?;
    if a != b {
        bail!("两次输入不一致");
    }
    Ok(a)
}

async fn cmd_passwd(
    g: &Global,
    random: bool,
    set: bool,
    clear: bool,
    stdin: bool,
) -> Result<ExitCode> {
    if set || clear {
        let pw = if set {
            Some(read_password(stdin)?)
        } else {
            None
        };
        let paths = g.paths()?;
        let req = Request::PasswdSet {
            password: pw.clone(),
        };
        match ipc::request(&paths.config_dir, &req).await {
            Ok(r) if r.ok => {}
            Ok(r) => bail!("{}", r.error.unwrap_or_else(|| "失败".into())),
            Err(e) if is_not_running(&e) => {
                // 后台进程没运行：直接写机密存储，下次启动生效
                let store =
                    LocalStore::open(g.data_dir.as_deref(), None).map_err(|e| anyhow!("{e}"))?;
                store
                    .set_fixed_password_offline(pw.as_deref())
                    .await
                    .map_err(|e| anyhow!("{}", e.message))?;
            }
            Err(e) => bail!("无法与后台进程通信：{e}"),
        }
        println!(
            "{}",
            if set {
                "固定密码已设置"
            } else {
                "固定密码已清除"
            }
        );
        return Ok(ExitCode::SUCCESS);
    }
    let req = if random {
        Request::PasswdRandom
    } else {
        Request::PasswdShow
    };
    let r = ipc_call(g, &req).await?;
    if !r.ok {
        bail!("{}", r.error.unwrap_or_default());
    }
    println!("{}", r.data["temp_password"].as_str().unwrap_or_default());
    Ok(ExitCode::SUCCESS)
}

fn print_value(v: &serde_json::Value) {
    match v {
        serde_json::Value::String(s) => println!("{s}"),
        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
            println!("{}", serde_json::to_string_pretty(v).unwrap_or_default())
        }
        other => println!("{other}"),
    }
}

async fn cmd_config(g: &Global, action: ConfigCmd) -> Result<ExitCode> {
    let paths = g.paths()?;
    let req = match &action {
        ConfigCmd::Get { key } => Request::ConfigGet {
            key: key.clone().unwrap_or_default(),
        },
        ConfigCmd::Set { key, value } => Request::ConfigSet {
            key: key.clone(),
            value: value.clone(),
        },
    };
    match ipc::request(&paths.config_dir, &req).await {
        Ok(r) if r.ok => print_value(&r.data),
        Ok(r) => bail!("{}", r.error.unwrap_or_else(|| "失败".into())),
        Err(e) if is_not_running(&e) => {
            // 后台进程没运行：直接读写配置文件（下次启动生效）
            let store = ConfigStore::open(paths.config_file()).map_err(|e| anyhow!("{e}"))?;
            let cur = Settings::from_config(&store.get());
            match action {
                ConfigCmd::Get { key } => print_value(
                    &cur.get_path(&key.unwrap_or_default())
                        .map_err(|e| anyhow!("{e}"))?,
                ),
                ConfigCmd::Set { key, value } => {
                    let next = cur.with_path(&key, &value).map_err(|e| anyhow!("{e}"))?;
                    store
                        .update(|c| next.apply_to(c))
                        .map_err(|e| anyhow!("{e}"))?;
                    print_value(&next.get_path(&key).map_err(|e| anyhow!("{e}"))?);
                }
            }
        }
        Err(e) => bail!("无法与后台进程通信：{e}"),
    }
    Ok(ExitCode::SUCCESS)
}

// ------------------------------------------------------------------ logs

fn tail_lines(text: &str, n: usize) -> Vec<&str> {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

async fn cmd_logs(g: &Global, lines: usize, follow: bool) -> Result<ExitCode> {
    let dir = g.paths()?.logs_dir();
    let Some(mut path) = rterm_core::logging::latest_log_file(&dir) else {
        bail!("还没有日志（{}）", dir.display());
    };
    let bytes = std::fs::read(&path)?;
    let text = String::from_utf8_lossy(&bytes);
    for l in tail_lines(&text, lines) {
        println!("{l}");
    }
    if !follow {
        return Ok(ExitCode::SUCCESS);
    }
    let mut pos = bytes.len() as u64;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        // 跨天滚动后换到新文件
        if let Some(latest) = rterm_core::logging::latest_log_file(&dir) {
            if latest != path {
                path = latest;
                pos = 0;
            }
        }
        let Ok(mut f) = std::fs::File::open(&path) else {
            continue;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < pos {
            pos = 0;
        }
        if len > pos {
            use std::io::Seek;
            f.seek(std::io::SeekFrom::Start(pos))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            pos += buf.len() as u64;
            let mut out = std::io::stdout();
            out.write_all(String::from_utf8_lossy(&buf).as_bytes())?;
            out.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_subcommands() {
        let c = Cli::try_parse_from(["rterm-cli", "passwd", "--set", "--stdin"]).unwrap();
        assert!(matches!(
            c.cmd,
            Cmd::Passwd {
                set: true,
                stdin: true,
                ..
            }
        ));
        assert!(Cli::try_parse_from(["rterm-cli", "passwd", "--random", "--set"]).is_err());
        assert!(Cli::try_parse_from(["rterm-cli", "passwd", "--stdin"]).is_err());
        let c = Cli::try_parse_from([
            "rterm-cli",
            "--data-dir",
            "/x",
            "config",
            "set",
            "host.enabled",
            "false",
        ])
        .unwrap();
        assert_eq!(c.data_dir.as_deref(), Some(std::path::Path::new("/x")));
        assert!(matches!(
            c.cmd,
            Cmd::Config {
                action: ConfigCmd::Set { .. }
            }
        ));
        assert!(Cli::try_parse_from(["rterm-cli", "hook", "--statusline"]).is_ok());
    }

    #[test]
    fn tail_picks_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\n", 2), vec!["b", "c"]);
        assert_eq!(tail_lines("a\n", 5), vec!["a"]);
    }
}
