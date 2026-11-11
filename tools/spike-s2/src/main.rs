//! S2 / S3 / S5 原型：脚本化地驱动一个 PTY（用 rterm-core 的 pty 模块），观察 Claude Code 的行为。
//!
//! 用法：spike-s2 <脚本文件>
//! 脚本一行一条命令（# 开头是注释）：
//!   cwd <目录>                  设置下一次 spawn 的工作目录
//!   env K=V                     设置下一次 spawn 的环境变量
//!   size <cols> <rows>          终端尺寸（默认 120x40）
//!   spawn <程序> [参数...]      启动（参数里的空格用 \s 表示）
//!   wait <ms>                   固定等待
//!   expect <文本> <超时ms>      等待原始输出里出现文本（在 mark 之后的部分里找）
//!   expectscreen <文本> <超时ms> 等待屏幕上出现文本
//!   quiet <静默ms> <超时ms>     等到输出静默
//!   send <转义串>               原样写入（支持 \e \r \n \t \xHH \s）
//!   paste <转义串>              写入 ESC[200~ 文本 ESC[201~
//!   mark                        记录当前原始输出长度，之后的 expect/has 只看这之后的内容
//!   screen [标签]               打印当前屏幕
//!   has <文本>                  检查屏幕是否包含文本，打印 PASS/FAIL
//!   rawhas <文本>               检查 mark 之后的原始输出是否包含文本
//!   dump <文件>                 把全部原始输出写到文件
//!   kill                        强杀
//!   echo <文字>                 打印一行
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use rterm_core::host::pty::{spawn_pty, PtyControl, PtyHandle, SpawnSpec};

type Msgs = Arc<Mutex<Vec<(u128, rterm_core::host::status::BridgeMessage)>>>;

struct Shared {
    raw: Vec<u8>,
    parser: vt100::Parser,
    last_output: Instant,
}

fn unescape(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            match b[i + 1] {
                b'e' => out.push(0x1b),
                b'r' => out.push(b'\r'),
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b's' => out.push(b' '),
                b'\\' => out.push(b'\\'),
                b'x' if i + 3 < b.len() => {
                    let h = std::str::from_utf8(&b[i + 2..i + 4]).unwrap_or("00");
                    out.push(u8::from_str_radix(h, 16).unwrap_or(0));
                    i += 2;
                }
                other => {
                    out.push(b'\\');
                    out.push(other);
                }
            }
            i += 2;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

fn show(bytes: &[u8]) -> String {
    let mut s = String::new();
    for &b in bytes {
        match b {
            0x1b => s.push_str("\\e"),
            b'\r' => s.push_str("\\r"),
            b'\n' => s.push_str("\\n"),
            0x20..=0x7e => s.push(b as char),
            _ => s.push_str(&format!("\\x{b:02x}")),
        }
    }
    s
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

#[tokio::main]
async fn main() -> Result<()> {
    let script_path = std::env::args().nth(1).ok_or_else(|| anyhow!("用法：spike-s2 <脚本>"))?;
    let script = std::fs::read_to_string(&script_path)?;
    let (mut cols, mut rows) = (120u16, 40u16);
    let mut cwd: Option<String> = None;
    let mut envs: Vec<(String, String)> = vec![("TERM".into(), "xterm-256color".into()), ("COLORTERM".into(), "truecolor".into())];
    let mut shared = Arc::new(Mutex::new(Shared { raw: Vec::new(), parser: vt100::Parser::new(rows, cols, 0), last_output: Instant::now() }));
    let mut control: Option<PtyControl> = None;
    let mut noreply = false;
    let msgs: Msgs = Arc::new(Mutex::new(Vec::new()));
    let mut bridge_keep: Option<rterm_core::host::status::BridgeServer> = None;
    let mut mark = 0usize;
    let t0 = Instant::now();
    let mut exit_rx: Option<tokio::sync::oneshot::Receiver<i32>> = None;

    for (ln, line) in script.lines().enumerate() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (cmd, rest) = line.split_once(' ').unwrap_or((line, ""));
        // 路径占位符：{REPO}=仓库根目录（当前目录，或环境变量 SPIKE_REPO）、{REPO_FS}=正斜杠写法、
        // {CLAUDE_EXE}=环境变量 CLAUDE_EXE（默认 claude）。send/paste 行里的反斜杠转成 \x5c。
        let rest_owned = {
            let repo = std::env::var("SPIKE_REPO")
                .ok()
                .or_else(|| std::env::current_dir().ok().map(|p| p.display().to_string()))
                .unwrap_or_default();
            let claude = std::env::var("CLAUDE_EXE").unwrap_or_else(|_| "claude".into());
            let esc = matches!(cmd, "send" | "paste");
            let fix = |v: &str| if esc { v.replace('\\', "\\x5c") } else { v.to_string() };
            rest.replace("{REPO_FS}", &repo.replace('\\', "/")).replace("{REPO}", &fix(&repo)).replace("{CLAUDE_EXE}", &fix(&claude))
        };
        let rest = rest_owned.as_str();
        println!("[{:>6}ms] > {line}", t0.elapsed().as_millis());
        match cmd {
            "cwd" => cwd = Some(rest.to_string()),
            "env" => {
                if let Some((k, v)) = rest.split_once('=') {
                    envs.push((k.to_string(), v.to_string()));
                }
            }
            "size" => {
                let mut it = rest.split_whitespace();
                cols = it.next().and_then(|x| x.parse().ok()).unwrap_or(120);
                rows = it.next().and_then(|x| x.parse().ok()).unwrap_or(40);
                shared = Arc::new(Mutex::new(Shared { raw: Vec::new(), parser: vt100::Parser::new(rows, cols, 0), last_output: Instant::now() }));
            }
            "spawn" => {
                let mut parts = rest.split_whitespace().map(|p| p.replace("\\s", " "));
                let program = parts.next().ok_or_else(|| anyhow!("第 {} 行：spawn 缺少程序", ln + 1))?;
                let args: Vec<String> = parts.collect();
                let h: PtyHandle = spawn_pty(SpawnSpec {
                    program,
                    args,
                    cwd: cwd.clone().map(Into::into),
                    env: envs.clone(),
                    cols,
                    rows,
                })?;
                let PtyHandle { mut output, exit, control: ctl } = h;
                control = Some(ctl.clone());
                exit_rx = Some(exit);
                let sh = shared.clone();
                let ctl2 = ctl.clone();
                let noreply = noreply;
                tokio::spawn(async move {
                    while let Some(chunk) = output.recv().await {
                        // 像 xterm.js 一样回答 DSR 和 DA1（Claude Code 启动时可能会问）
                        let mut replies: Vec<Vec<u8>> = Vec::new();
                        {
                            let mut g = sh.lock().unwrap_or_else(|e| e.into_inner());
                            g.raw.extend_from_slice(&chunk);
                            g.parser.process(&chunk);
                            g.last_output = Instant::now();
                            if !noreply && contains(&chunk, b"\x1b[6n") {
                                let (r, c) = g.parser.screen().cursor_position();
                                replies.push(format!("\x1b[{};{}R", r + 1, c + 1).into_bytes());
                            }
                            if !noreply && (contains(&chunk, b"\x1b[c") || contains(&chunk, b"\x1b[0c")) {
                                replies.push(b"\x1b[?1;2c".to_vec());
                            }
                        }
                        for r in replies {
                            let _ = ctl2.write(r).await;
                        }
                    }
                });
            }
            "noreply" => noreply = true,
            "bridge" => {
                // bridge <数据目录> <rterm-cli 替身 exe> [nostatusline]
                let mut it = rest.split_whitespace();
                let dir = std::path::PathBuf::from(it.next().unwrap_or(".").replace("%20", " "));
                let cli = std::path::PathBuf::from(it.next().unwrap_or("hookprobe.exe").replace("%20", " "));
                let inject = it.next() != Some("nostatusline");
                let args = rterm_core::host::status::write_plugin_dir(&dir, &cli, inject)?;
                let (server, mut rx) = rterm_core::host::status::BridgeServer::start(&dir)?;
                envs.push((rterm_core::host::status::ENV_ENDPOINT.into(), server.endpoint().to_string()));
                envs.push((rterm_core::host::status::ENV_TERM_ID.into(), "T-SPIKE".into()));
                println!("    plugin_dir={} settings={:?} endpoint={}", args.plugin_dir, args.settings_file, server.endpoint());
                let m = msgs.clone();
                let start = Instant::now();
                tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        let ms = start.elapsed().as_millis();
                        println!("    [bridge {ms:>6}ms] kind={} payload={}", msg.kind, msg.payload);
                        m.lock().unwrap_or_else(|e| e.into_inner()).push((ms, msg));
                    }
                });
                bridge_keep = Some(server);
            }
            "msgcount" => {
                let n = msgs.lock().unwrap_or_else(|e| e.into_inner()).len();
                println!("    bridge messages so far: {n}");
            }
            "msgnames" => {
                let g = msgs.lock().unwrap_or_else(|e| e.into_inner());
                let names: Vec<String> = g
                    .iter()
                    .map(|(ms, m)| format!("{}@{}ms:{}", m.kind, ms, m.payload.get("hook_event_name").and_then(|v| v.as_str()).unwrap_or("-")))
                    .collect();
                println!("    events: {}", names.join(", "));
            }
            "wait" => tokio::time::sleep(Duration::from_millis(rest.trim().parse().unwrap_or(0))).await,
            "expect" | "expectscreen" => {
                let (needle, ms) = rest.rsplit_once(' ').unwrap_or((rest, "10000"));
                let needle = unescape(needle);
                let deadline = Instant::now() + Duration::from_millis(ms.parse().unwrap_or(10000));
                let mut ok = false;
                while Instant::now() < deadline {
                    {
                        let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                        ok = if cmd == "expect" {
                            contains(&g.raw[mark.min(g.raw.len())..], &needle)
                        } else {
                            g.parser.screen().contents().contains(&String::from_utf8_lossy(&needle).into_owned())
                        };
                    }
                    if ok {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                println!("    {} {} {:?}", cmd, if ok { "FOUND" } else { "TIMEOUT" }, show(&needle));
            }
            "quiet" => {
                let mut it = rest.split_whitespace();
                let q: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(500);
                let to: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(8000);
                let deadline = Instant::now() + Duration::from_millis(to);
                while Instant::now() < deadline {
                    let last = shared.lock().unwrap_or_else(|e| e.into_inner()).last_output;
                    if last.elapsed() >= Duration::from_millis(q) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            }
            "send" | "paste" | "pastefile" => {
                let mut data = if cmd == "pastefile" { std::fs::read(rest.trim())? } else { unescape(rest) };
                if cmd != "send" {
                    let mut d = b"\x1b[200~".to_vec();
                    d.extend(data);
                    d.extend(b"\x1b[201~");
                    data = d;
                }
                if let Some(c) = &control {
                    for chunk in data.chunks(2048) {
                        c.write(chunk.to_vec()).await?;
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
            }
            "mark" => mark = shared.lock().unwrap_or_else(|e| e.into_inner()).raw.len(),
            "screen" => {
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                println!("----- screen {rest} -----");
                for l in g.parser.screen().contents().lines() {
                    if !l.trim().is_empty() {
                        println!("| {}", l.trim_end());
                    }
                }
                println!("-------------------------");
            }
            "screentail" => {
                let mut it = rest.splitn(2, ' ');
                let n: usize = it.next().and_then(|x| x.parse().ok()).unwrap_or(8);
                let label = it.next().unwrap_or("");
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                let lines: Vec<String> = g.parser.screen().contents().lines().filter(|l| !l.trim().is_empty()).map(|l| l.trim_end().to_string()).collect();
                println!("----- screen tail {label} -----");
                for l in lines.iter().skip(lines.len().saturating_sub(n)) {
                    println!("| {l}");
                }
            }
            "has" => {
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                let ok = g.parser.screen().contents().contains(rest);
                println!("    {} screen has {:?}", if ok { "PASS" } else { "FAIL" }, rest);
            }
            "rawhas" => {
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                let ok = contains(&g.raw[mark.min(g.raw.len())..], &unescape(rest));
                println!("    {} raw has {:?}", if ok { "PASS" } else { "FAIL" }, rest);
            }
            "rawshow" => {
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                let s = &g.raw[mark.min(g.raw.len())..];
                let n: usize = rest.trim().parse().unwrap_or(400);
                println!("    raw[{}..]: {}", mark, show(&s[..s.len().min(n)]));
            }
            "dump" => {
                let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                std::fs::write(rest.trim(), &g.raw)?;
            }
            "resize" => {
                let mut it = rest.split_whitespace();
                let c: u16 = it.next().and_then(|x| x.parse().ok()).unwrap_or(cols);
                let r: u16 = it.next().and_then(|x| x.parse().ok()).unwrap_or(rows);
                if let Some(ctl) = &control {
                    ctl.resize(c, r);
                }
                shared.lock().unwrap_or_else(|e| e.into_inner()).parser.set_size(r, c);
            }
            "kill" => {
                if let Some(c) = &control {
                    c.kill();
                }
            }
            "waitexit" => {
                if let Some(rx) = exit_rx.take() {
                    let to: u64 = rest.trim().parse().unwrap_or(10000);
                    match tokio::time::timeout(Duration::from_millis(to), rx).await {
                        Ok(Ok(code)) => println!("    exited code={code}"),
                        _ => println!("    NOT EXITED within {to}ms"),
                    }
                }
            }
            "echo" => println!("    {rest}"),
            other => println!("    未知命令 {other}"),
        }
    }
    if let Some(c) = &control {
        c.kill();
    }
    drop(bridge_keep);
    Ok(())
}
