//! 门面（`Core`）端到端联调（默认全部 `#[ignore]`，需要手动运行，会真的起 shell、开网络连接）。
//!
//! ```text
//! # 需要先 cargo build 出 rterm-cli（hook 用），再：
//! cargo test -p rterm-core --test e2e_local -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 测试用例：
//! - `full_local`：自己拉起一个开发服务端子进程（`node --import tsx src/main-dev.ts`，端口 18080/18081，
//!   中继地址指向本测试里的 TCP 代理 18082，用来模拟断网）。覆盖连接、终端、echo、resize、断线重连续传、
//!   上传（含 3MB）、终端隔离、TERM_BUSY、需确认流程、错误密码锁定。
//! - `smoke_with_server`：对 `RTERM_API_URL`（默认 http://127.0.0.1:8080）指向的**已运行**服务端做冒烟：
//!   进程内起被控端和主控端，连接、echo、resize、3MB 上传、关闭。对测试服务器也用它。
//! - `smoke_external_host`：被控端是外部进程（例如 `rterm-cli host`），用环境变量
//!   `RTERM_E2E_HOST_CODE` / `RTERM_E2E_HOST_PASSWORD` 指定；`RTERM_E2E_HOST_LOCAL=1` 表示被控端和本测试在同一台机器上，
//!   此时还会校验上传文件的内容。
//! - `claude_observe`：用真实 `claude` 做只读观察（不发提问），看 ActionCatalog / AppState。
//!
//! 环境变量：`RTERM_E2E_SERVER_DIR`（server 目录，默认 `<仓库>/server`）、`RTERM_E2E_PORT`（默认 18080）、
//! `RTERM_NO_KEYRING` 不需要设置（测试用内存机密存储，不碰钥匙串）。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rterm_core::controller::{ControllerTiming, TermOpenOptions, TermSize};
use rterm_core::core::{Core, CoreKind, CoreOptions};
use rterm_core::events::{CoreEvent, SessionState};
use rterm_core::secrets::MemoryStore;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

// ---------------------------------------------------------------- 事件收集

#[derive(Default)]
struct Events {
    log: Mutex<Vec<CoreEvent>>,
    out: Mutex<HashMap<(String, String), Vec<u8>>>,
}

struct Node {
    name: &'static str,
    core: Core,
    ev: Arc<Events>,
    dir: PathBuf,
    secrets: Arc<MemoryStore>,
    api: String,
    tmp: tempfile::TempDir,
}

fn fast_timing() -> ControllerTiming {
    ControllerTiming {
        backoff_base: Duration::from_millis(500),
        backoff_max: Duration::from_secs(2),
        ping_interval: Duration::from_secs(5),
        ..ControllerTiming::default()
    }
}

fn find_rterm_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "rterm-cli.exe"
    } else {
        "rterm-cli"
    };
    // target/debug/deps/<test>.exe -> target/debug/rterm-cli
    let p = exe.parent()?.parent()?.join(name);
    p.is_file().then_some(p)
}

impl Node {
    async fn start(name: &'static str, api_url: &str, probe_claude: bool) -> Node {
        let tmp = tempfile::tempdir().expect("临时目录");
        Self::start_in(
            name,
            api_url,
            probe_claude,
            tmp,
            Arc::new(MemoryStore::default()),
        )
        .await
    }

    /// 关闭后用同一个数据目录和机密存储重新启动（设备身份不变）。
    async fn restart(self) -> Node {
        self.core.shutdown().await;
        let (name, api) = (self.name, self.api.clone());
        Self::start_in(name, &api, false, self.tmp, self.secrets).await
    }

    async fn start_in(
        name: &'static str,
        api_url: &str,
        probe_claude: bool,
        tmp: tempfile::TempDir,
        secrets: Arc<MemoryStore>,
    ) -> Node {
        let dir = tmp.path().to_path_buf();
        let mut o = CoreOptions::new(CoreKind::Cli, "0.1.0");
        o.data_dir = Some(dir.clone());
        o.api_url = Some(api_url.to_string());
        o.proxy = Some(String::new());
        o.secrets = Some(secrets.clone());
        o.probe_claude = probe_claude;
        o.rterm_cli = find_rterm_cli();
        o.controller_timing = Some(fast_timing());
        let (core, mut rx) = Core::start(o).await.expect("Core::start");
        let ev = Arc::new(Events::default());
        let (ev2, core2) = (ev.clone(), core.clone());
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                if let CoreEvent::TermOutput {
                    session,
                    term,
                    seq,
                    data,
                } = &e
                {
                    let end = seq + data.len() as u64;
                    ev2.out
                        .lock()
                        .unwrap()
                        .entry((session.clone(), term.clone()))
                        .or_default()
                        .extend_from_slice(data);
                    core2.term_ack(session, term, end);
                }
                ev2.log.lock().unwrap().push(e);
            }
        });
        let info = core.local_info();
        assert!(info.registered, "{name}: 注册失败 {:?}", info.last_error);
        println!(
            "[{name}] 设备码 {} 密码 {}",
            info.device_code, info.temp_password
        );
        Node {
            name,
            core,
            ev,
            dir,
            secrets,
            api: api_url.to_string(),
            tmp,
        }
    }

    fn code(&self) -> String {
        self.core.local_info().device_code
    }

    fn password(&self) -> String {
        self.core.local_info().temp_password
    }

    fn text(&self, session: &str, term: &str) -> String {
        let g = self.ev.out.lock().unwrap();
        g.get(&(session.to_string(), term.to_string()))
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default()
    }

    fn events<T>(&self, f: impl Fn(&CoreEvent) -> Option<T>) -> Vec<T> {
        self.ev.log.lock().unwrap().iter().filter_map(f).collect()
    }

    fn count_ready(&self, session: &str) -> usize {
        self.events(|e| match e {
            CoreEvent::SessionState {
                session: s,
                state: SessionState::Ready,
            } if s == session => Some(()),
            _ => None,
        })
        .len()
    }

    async fn wait_text(&self, session: &str, term: &str, needle: &str, secs: u64) {
        let ok = wait_until(secs, || self.text(session, term).contains(needle)).await;
        assert!(
            ok,
            "[{}] {secs} 秒内没有在终端输出里看到 {needle:?}。当前输出尾部：\n{}",
            self.name,
            tail(&self.text(session, term), 600)
        );
    }
}

fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(n)..].iter().collect()
}

async fn wait_until(secs: u64, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn count(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

// ---------------------------------------------------------------- 服务端子进程 + 可断开的 TCP 代理

struct ServerProc {
    child: std::process::Child,
}

impl Drop for ServerProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn server_dir() -> PathBuf {
    if let Ok(d) = std::env::var("RTERM_E2E_SERVER_DIR") {
        return PathBuf::from(d);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server")
}

fn base_port() -> u16 {
    std::env::var("RTERM_E2E_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(18080)
}

async fn spawn_server(port: u16, relay_port: u16, public_relay_port: u16) -> ServerProc {
    let dir = server_dir();
    assert!(
        dir.join("src/main-dev.ts").exists(),
        "找不到服务端目录 {}（用 RTERM_E2E_SERVER_DIR 指定）",
        dir.display()
    );
    let child = std::process::Command::new("node")
        .args(["--import", "tsx", "src/main-dev.ts"])
        .current_dir(&dir)
        .env("PORT", port.to_string())
        .env("RELAY_PORT", relay_port.to_string())
        .env(
            "RELAY_PUBLIC_URL",
            format!("ws://127.0.0.1:{public_relay_port}"),
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("无法启动 node");
    let sp = ServerProc { child };
    let url = format!("http://127.0.0.1:{port}/v1/healthz");
    let ok = wait_until(30, || {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
    })
    .await;
    assert!(ok, "服务端 30 秒内没有起来：{url}");
    sp
}

/// 本地 TCP 代理：`cut()` 掐断所有已有连接并拒绝新连接，`resume()` 恢复，用来模拟断网。
struct Proxy {
    epoch: watch::Sender<u64>,
    blocked: Arc<AtomicBool>,
}

impl Proxy {
    async fn start(listen: u16, target: u16) -> Proxy {
        let l = TcpListener::bind(("127.0.0.1", listen))
            .await
            .expect("代理端口被占用");
        let (epoch, _) = watch::channel(0u64);
        let blocked = Arc::new(AtomicBool::new(false));
        let (ep, bl) = (epoch.clone(), blocked.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut c, _)) = l.accept().await else {
                    break;
                };
                if bl.load(Ordering::SeqCst) {
                    continue; // 直接丢弃
                }
                let mut rx = ep.subscribe();
                tokio::spawn(async move {
                    let Ok(mut s) = TcpStream::connect(("127.0.0.1", target)).await else {
                        return;
                    };
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut c, &mut s) => {}
                        _ = rx.changed() => {}
                    }
                    let _ = c.shutdown().await;
                    let _ = s.shutdown().await;
                });
            }
        });
        Proxy { epoch, blocked }
    }

    fn cut(&self) {
        self.blocked.store(true, Ordering::SeqCst);
        self.epoch.send_modify(|e| *e += 1);
    }

    fn resume(&self) {
        self.blocked.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- 公共步骤

fn is_powershell(shell: &str) -> bool {
    let s = shell.to_lowercase();
    s.contains("powershell") || s.contains("pwsh")
}

/// 等一会儿再打印标记的命令；标记在命令文本里是被拆开的，所以只有真正执行后才会出现完整标记。
fn delayed_marker_cmd(shell: &str, secs: u32, a: &str, b: &str) -> String {
    let s = shell.to_lowercase();
    if is_powershell(&s) {
        format!("Start-Sleep -Seconds {secs}; echo ('{a}'+'{b}')")
    } else if s.contains("cmd") {
        format!("ping -n {} 127.0.0.1 >nul & echo {a}^{b}", secs + 1)
    } else {
        format!("sleep {secs}; echo {a}\"\"{b}")
    }
}

async fn default_shell_of(ctl: &Node, sid: &str) -> String {
    let snap = ctl.core.host_snapshot(sid).expect("HostInfo");
    let sh = snap
        .info
        .shells
        .iter()
        .find(|s| s.is_default)
        .or(snap.info.shells.first())
        .map(|s| format!("{} ({})", s.name, s.path))
        .unwrap_or_default();
    println!("  被控端默认 shell：{sh}");
    sh
}

/// 连接并等 Ready + HostInfo。
async fn connect_ready(ctl: &Node, host: &Node) -> String {
    let sid = ctl
        .core
        .connect(&host.code(), &host.password())
        .await
        .unwrap_or_else(|e| panic!("[{}] 连接失败：{e}", ctl.name));
    assert!(
        wait_until(10, || ctl.count_ready(&sid) >= 1).await,
        "应收到 Ready"
    );
    assert!(
        wait_until(5, || !ctl
            .events(|e| match e {
                CoreEvent::HostInfo { session, info } if *session == sid => Some(info.clone()),
                _ => None,
            })
            .is_empty())
        .await,
        "应收到 HostInfo"
    );
    sid
}

async fn open_shell(ctl: &Node, sid: &str) -> String {
    let term = ctl
        .core
        .open_term(sid, TermOpenOptions::shell(TermSize::new(100, 30)))
        .await
        .expect("open_term");
    // 等 shell 起来（有任何输出即可）
    assert!(
        wait_until(15, || !ctl.text(sid, &term).is_empty()).await,
        "shell 15 秒内没有任何输出"
    );
    tokio::time::sleep(Duration::from_millis(800)).await;
    term
}

fn make_data(len: usize) -> Vec<u8> {
    // 确定性伪随机，避免被压缩/稀疏文件优化掉
    let mut x: u64 = 0x9E3779B97F4A7C15;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn sha(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

/// 上传一个文件并等完成；`verify_local` 为真时校验被控端落盘的内容（被控端与本测试同机）。
async fn upload_and_wait(ctl: &Node, sid: &str, path: &Path, verify_local: bool) -> String {
    let data = std::fs::read(path).unwrap();
    let started = Instant::now();
    let r = ctl
        .core
        .upload_path(sid, path)
        .await
        .unwrap_or_else(|e| panic!("上传失败：{e}"));
    assert_eq!(r.size as usize, data.len());
    let fid = r.file_id;
    let mut last_report = Instant::now();
    assert!(
        wait_until(240, || {
            if last_report.elapsed() >= Duration::from_secs(10) {
                last_report = Instant::now();
                let p = ctl.events(|e| match e {
                    CoreEvent::UploadProgress {
                        file, sent, total, ..
                    } if *file == fid => Some((*sent, *total)),
                    _ => None,
                });
                println!("    上传进度 {:?}（{:?}）", p.last(), started.elapsed());
            }
            !ctl.events(|e| match e {
                CoreEvent::UploadDone { file, .. } if *file == fid => Some(()),
                CoreEvent::UploadFailed { file, reason, .. } if *file == fid => {
                    panic!("上传失败：{reason}")
                }
                _ => None,
            })
            .is_empty()
        })
        .await,
        "上传没有完成"
    );
    let remote = ctl
        .events(|e| match e {
            CoreEvent::UploadDone {
                file, remote_path, ..
            } if *file == fid => Some(remote_path.clone()),
            _ => None,
        })
        .remove(0);
    println!(
        "  上传 {} 字节完成，用时 {:?}，远端路径 {remote}",
        data.len(),
        started.elapsed()
    );
    if verify_local {
        let got = std::fs::read(&remote).expect("被控端落盘的文件应存在");
        assert_eq!(got.len(), data.len(), "落盘大小不一致");
        assert_eq!(sha(&got), sha(&data), "落盘内容校验和不一致");
        println!("  落盘校验通过（sha256 一致）");
    }
    remote
}

/// 连接 -> echo -> resize -> 上传（小文件 + 3MB）。`full_local` 与两个冒烟用例共用。
async fn basic_flow(ctl: &Node, host: Option<&Node>, sid: &str, verify_upload: bool) -> String {
    let shell = default_shell_of(ctl, sid).await;
    let term = open_shell(ctl, sid).await;

    // echo：命令回显一次，执行结果一次
    ctl.core
        .term_submit(sid, &term, "echo RTERM_E2E_OK".into(), vec![])
        .await
        .expect("term_submit");
    ctl.wait_text(sid, &term, "RTERM_E2E_OK", 15).await;
    assert!(
        wait_until(10, || count(&ctl.text(sid, &term), "RTERM_E2E_OK") >= 2).await,
        "应同时看到回显和执行结果，输出尾部：\n{}",
        tail(&ctl.text(sid, &term), 400)
    );
    println!(
        "  echo 通过（RTERM_E2E_OK 出现 {} 次）",
        count(&ctl.text(sid, &term), "RTERM_E2E_OK")
    );

    // resize：PowerShell 里读窗口宽度验证
    ctl.core
        .term_resize(sid, &term, TermSize::new(120, 32))
        .await
        .expect("resize");
    if is_powershell(&shell) {
        // 被控端对 resize 有 50ms 防抖
        tokio::time::sleep(Duration::from_millis(500)).await;
        ctl.core
            .term_submit(
                sid,
                &term,
                "echo (\"W=\"+[Console]::WindowWidth+\"x\"+[Console]::WindowHeight)".into(),
                vec![],
            )
            .await
            .unwrap();
        ctl.wait_text(sid, &term, "W=120x32", 10).await;
        println!("  resize 通过（被控端看到 120x32）");
    } else {
        println!("  resize 已发送（非 PowerShell，未校验窗口大小）");
    }

    // 上传：小文件、3MB
    let tmp = tempfile::tempdir().unwrap();
    let small = tmp.path().join("小文件 e2e.txt");
    std::fs::write(&small, "hello e2e").unwrap();
    upload_and_wait(ctl, sid, &small, verify_upload).await;
    let big = tmp.path().join("big-3mb.bin");
    std::fs::write(&big, make_data(3 * 1024 * 1024)).unwrap();
    upload_and_wait(ctl, sid, &big, verify_upload).await;
    let _ = host;
    term
}

// ================================================================ 用例

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要 node 与 server 依赖；手动运行"]
async fn full_local() {
    let port = base_port();
    let (relay, proxy_port) = (port + 1, port + 2);
    let mut server = spawn_server(port, relay, proxy_port).await;
    let proxy = Proxy::start(proxy_port, relay).await;
    let api = format!("http://127.0.0.1:{port}");

    let host = Node::start("H", &api, false).await;
    let a = Node::start("A", &api, false).await;
    let b = Node::start("B", &api, false).await;
    assert!(host.core.get_settings().host.isolate_terminals);

    println!("== 1. A 连接 H：HostInfo / 终端 / echo / resize / 上传 ==");
    let sid_a = connect_ready(&a, &host).await;
    let term_a = basic_flow(&a, Some(&host), &sid_a, true).await;
    assert_eq!(
        host.core.list_incoming().len(),
        1,
        "被控端应看到 1 个来访会话"
    );
    let shell = default_shell_of(&a, &sid_a).await;

    println!("== 2. 断网 -> 自动重连 -> 续传 ==");
    let marker_cmd = delayed_marker_cmd(&shell, 4, "MARK_DUR", "ING_CUT");
    a.core
        .term_submit(&sid_a, &term_a, marker_cmd, vec![])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ready_before = a.count_ready(&sid_a);
    let before_ok = count(&a.text(&sid_a, &term_a), "RTERM_E2E_OK");
    proxy.cut();
    println!("  已断开中继连接");
    assert!(
        wait_until(15, || !a
            .events(|e| match e {
                CoreEvent::SessionState {
                    session,
                    state: SessionState::Reconnecting,
                } if *session == sid_a => Some(()),
                _ => None,
            })
            .is_empty())
        .await,
        "应进入 Reconnecting"
    );
    // 重连中输入不能悄悄排队
    let err = a
        .core
        .term_submit(&sid_a, &term_a, "echo SHOULD_NOT_SEND".into(), vec![])
        .await
        .expect_err("重连中 term_submit 应报错");
    assert_eq!(err.code, "NOT_READY", "{err}");
    println!("  重连中提交返回 NOT_READY：{}", err.message);
    // 断网时间长于命令的 sleep：标记在断网期间产生
    tokio::time::sleep(Duration::from_secs(5)).await;
    proxy.resume();
    assert!(
        wait_until(30, || a.count_ready(&sid_a) > ready_before).await,
        "应自动重连并回到 Ready"
    );
    println!("  已自动重连");
    a.wait_text(&sid_a, &term_a, "MARK_DURING_CUT", 15).await;
    assert_eq!(
        count(&a.text(&sid_a, &term_a), "MARK_DURING_CUT"),
        1,
        "断网期间产生的输出应恰好续传一次（不丢、不重复）"
    );
    assert_eq!(
        count(&a.text(&sid_a, &term_a), "RTERM_E2E_OK"),
        before_ok,
        "已收到的输出不应被重放"
    );
    println!("  断网期间的输出已续传（恰好一次）");
    a.core
        .term_submit(&sid_a, &term_a, "echo AFTER_RECONNECT_OK".into(), vec![])
        .await
        .unwrap();
    a.wait_text(&sid_a, &term_a, "AFTER_RECONNECT_OK", 15).await;
    assert!(
        wait_until(10, || count(&a.text(&sid_a, &term_a), "AFTER_RECONNECT_OK")
            >= 2)
        .await
    );
    println!("  重连后输入输出正常");
    // 重连后上传
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("after-reconnect.bin");
    std::fs::write(&f, make_data(256 * 1024)).unwrap();
    upload_and_wait(&a, &sid_a, &f, true).await;

    println!("== 3. 终端隔离（默认开）==");
    let sid_b = connect_ready(&b, &host).await;
    let b_view = b.core.list_terms(&sid_b).await.unwrap();
    assert!(
        b_view.is_empty(),
        "隔离开启时 B 看不到 A 的终端，实际：{b_view:?}"
    );
    let term_b = b
        .core
        .open_term(&sid_b, TermOpenOptions::shell(TermSize::new(80, 24)))
        .await
        .unwrap();
    let a_view = a.core.list_terms(&sid_a).await.unwrap();
    assert!(
        a_view.iter().all(|t| t.term_id != term_b),
        "A 不应看到 B 的终端"
    );
    assert!(a_view.iter().any(|t| t.term_id == term_a));
    println!("  默认隔离：B 看不到 A 的终端，A 看不到 B 的终端");

    println!("== 4. 关闭隔离后可见，但不能抢占仍在附着的终端（TERM_BUSY）==");
    let mut s = host.core.get_settings();
    s.host.isolate_terminals = false;
    host.core.set_settings(s).await.unwrap();
    let b_view = b.core.list_terms(&sid_b).await.unwrap();
    let seen = b_view
        .iter()
        .find(|t| t.term_id == term_a)
        .expect("关闭隔离后 B 应能看到 A 的终端");
    assert!(seen.attached_by_other, "A 仍在附着，应标记为被其他设备占用");
    let err = b
        .core
        .attach_term(&sid_b, &term_a, TermSize::new(80, 24))
        .await
        .expect_err("B 不能抢 A 仍在附着的终端");
    assert_eq!(err.code, "TERM_BUSY", "{err}");
    println!("  B 附着 A 的终端被拒绝：{}", err);
    // A 断开后终端脱离，B 可以接管
    a.core.disconnect(&sid_a).await.unwrap();
    assert!(
        wait_until(10, || host.core.list_incoming().len() == 1).await,
        "A 断开后被控端只剩 B 一个来访会话"
    );
    b.core
        .attach_term(&sid_b, &term_a, TermSize::new(100, 30))
        .await
        .expect("A 断开后 B 应能附着");
    b.wait_text(&sid_b, &term_a, "AFTER_RECONNECT_OK", 10).await;
    println!("  A 断开后 B 附着成功并回放了历史输出");
    // from_seq：界面重建后从偏移 0 重新续传，历史输出应再交付一遍
    let before = count(&b.text(&sid_b, &term_a), "AFTER_RECONNECT_OK");
    b.core
        .attach_term_from(&sid_b, &term_a, TermSize::new(100, 30), Some(0))
        .await
        .expect("带 from_seq 的附着");
    assert!(
        wait_until(10, || count(&b.text(&sid_b, &term_a), "AFTER_RECONNECT_OK")
            > before)
        .await,
        "from_seq=0 应从头重放历史输出"
    );
    println!("  attach_term_from(0)：从头重放了历史输出");
    // 恢复隔离
    let mut s = host.core.get_settings();
    s.host.isolate_terminals = true;
    host.core.set_settings(s).await.unwrap();
    let again = b.core.list_terms(&sid_b).await.unwrap();
    assert!(
        again.iter().all(|t| t.term_id != term_a),
        "恢复隔离后，A 创建的终端对 B 不再可见（列表里）"
    );
    // 已附着的不强制踢：B 仍能向它输入并收到输出
    b.core
        .term_submit(&sid_b, &term_a, "echo STILL_ATTACHED_OK".into(), vec![])
        .await
        .expect("已附着的终端恢复隔离后仍可用");
    b.wait_text(&sid_b, &term_a, "STILL_ATTACHED_OK", 10).await;
    println!("  恢复隔离后：列表里不可见，但已附着的终端仍可用（不强制踢）");
    b.core.close_term(&sid_b, &term_a).await.unwrap();
    b.core.close_term(&sid_b, &term_b).await.unwrap();
    b.core.disconnect(&sid_b).await.unwrap();

    println!("== 5. 被控端“需确认”流程（挂起等待，不超时）==");
    // 服务端对单个主控设备限流（默认每分钟 10 次连接请求），前面 A 的重连已用掉不少额度，这里换几个主控
    let d = Node::start("D", &api, false).await;
    let f = Node::start("F", &api, false).await;
    let g = Node::start("G", &api, false).await;
    let mut s = host.core.get_settings();
    s.host.require_confirm = true;
    host.core.set_settings(s).await.unwrap();
    let pending_count = |h: &Node| {
        h.core
            .list_incoming()
            .iter()
            .filter(|i| i.pending_confirm)
            .count()
    };
    // 5a 等 20 秒之后同意，仍然连得上
    let (d2, hc, hp) = (d.core.clone(), host.code(), host.password());
    let t = tokio::spawn(async move { d2.connect(&hc, &hp).await });
    assert!(
        wait_until(10, || pending_count(&host) == 1).await,
        "被控端应出现等待确认的来访"
    );
    assert!(
        wait_until(10, || !d
            .events(|e| match e {
                CoreEvent::SessionState {
                    state: SessionState::AwaitingApproval,
                    ..
                } => Some(()),
                _ => None,
            })
            .is_empty())
        .await,
        "主控端应进入“等待对方确认”状态"
    );
    println!("  主控端状态：AwaitingApproval；被控端挂起 20 秒不处理…");
    tokio::time::sleep(Duration::from_secs(20)).await;
    assert!(!t.is_finished(), "20 秒内没人处理，连接应一直挂着");
    assert_eq!(pending_count(&host), 1, "20 秒后来访仍应挂着");
    let pend = host.core.list_incoming().remove(0);
    host.core.accept_incoming(&pend.session_id).unwrap();
    let sid = t.await.unwrap().expect("20 秒后同意仍应连接成功");
    println!("  等了 20 秒后同意 -> 连接成功");
    assert!(wait_until(10, || d.count_ready(&sid) >= 1).await);
    // 会话结束后短时间内重连不再重复确认（网络闪断后的自动重连不应再打扰被控端用户）
    d.core.disconnect(&sid).await.unwrap();
    assert!(wait_until(10, || host.core.list_incoming().is_empty()).await);
    let sid = tokio::time::timeout(
        Duration::from_secs(15),
        d.core.connect(&host.code(), &host.password()),
    )
    .await
    .expect("宽限期内重连不应再等确认")
    .expect("宽限期内重连应成功");
    println!("  断开后立即重连：宽限期内无需再确认 -> 连接成功");
    d.core.disconnect(&sid).await.unwrap();

    // 5b 拒绝
    let (f2, hc, hp) = (f.core.clone(), host.code(), host.password());
    let t = tokio::spawn(async move { f2.connect(&hc, &hp).await });
    assert!(wait_until(10, || pending_count(&host) == 1).await);
    let pend = host
        .core
        .list_incoming()
        .into_iter()
        .find(|i| i.pending_confirm)
        .unwrap();
    host.core.reject_incoming(&pend.session_id).unwrap();
    let err = t.await.unwrap().expect_err("拒绝后应连接失败");
    assert_eq!(err.code, "REJECTED", "{err}");
    println!("  拒绝 -> {}", err);

    // 5c 主控方在对方确认之前取消
    let (g2, hc, hp) = (g.core.clone(), host.code(), host.password());
    let t = tokio::spawn(async move { g2.connect(&hc, &hp).await });
    assert!(wait_until(10, || pending_count(&host) == 1).await);
    let mut waiting = None;
    assert!(
        wait_until(10, || {
            waiting = g
                .events(|e| match e {
                    CoreEvent::SessionState {
                        session,
                        state: SessionState::AwaitingApproval,
                    } => Some(session.clone()),
                    _ => None,
                })
                .pop();
            waiting.is_some()
        })
        .await
    );
    let cancelled = g.core.cancel_connect(&waiting.unwrap());
    assert!(cancelled, "cancel_connect 应找到这个连接");
    let err = t.await.unwrap().expect_err("取消后 connect 应失败");
    assert_eq!(err.code, "CANCELLED", "{err}");
    assert!(
        wait_until(10, || host.core.list_incoming().is_empty()).await,
        "主控方取消后被控端不应残留待确认项"
    );
    assert!(
        !host
            .events(|e| match e {
                CoreEvent::Notice { code, .. } if code == "INCOMING_CANCELLED" => Some(()),
                _ => None,
            })
            .is_empty(),
        "被控端应收到“对方已取消”通知"
    );
    println!(
        "  主控方取消 -> connect 返回 {}；被控端撤掉了待确认项",
        err.code
    );

    // 5d 挂着多个，被控端关闭“连接确认”后全部放行
    let (d2, hc, hp) = (f.core.clone(), host.code(), host.password());
    let t = tokio::spawn(async move { d2.connect(&hc, &hp).await });
    assert!(wait_until(10, || pending_count(&host) == 1).await);
    let mut s = host.core.get_settings();
    s.host.require_confirm = false;
    host.core.set_settings(s).await.unwrap();
    let sid = t
        .await
        .unwrap()
        .expect("关闭连接确认后，挂着的来访应被放行");
    println!("  关闭“连接确认”设置 -> 挂着的来访被放行并连接成功");
    f.core.disconnect(&sid).await.unwrap();
    let mut s = host.core.get_settings();
    s.host.require_confirm = false;
    host.core.set_settings(s).await.unwrap();

    println!("== 6. 已记住的被控端公钥变化（TOFU）==");
    let e = Node::start("E", &api, false).await;
    let sid = connect_ready(&e, &host).await;
    assert_eq!(e.core.list_known_hosts().len(), 1, "首次连接应记住对端公钥");
    e.core.disconnect(&sid).await.unwrap();
    // 篡改本地记住的公钥，模拟“对方重装了系统 / 被冒充”
    let cfg_path = e.dir.join("config.json");
    e.core.shutdown().await;
    let mut cfg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    cfg["controller"]["known_hosts"][0]["public_key"] =
        serde_json::Value::String("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into());
    std::fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    let e = e.restart().await;
    let err = e
        .core
        .connect(&host.code(), &host.password())
        .await
        .expect_err("公钥变化应拒绝");
    assert_eq!(err.code, "PEER_KEY_CHANGED", "{err}");
    println!("  公钥变化 -> {}（指纹 {:?}）", err.code, err.data);
    let sid = e
        .core
        .connect_with(rterm_core::core::ConnectParams {
            device_code: host.code(),
            password: host.password(),
            accept_key_change: true,
        })
        .await
        .expect("用户确认后应连接成功");
    assert!(wait_until(10, || e.count_ready(&sid) >= 1).await);
    e.core.disconnect(&sid).await.unwrap();
    let sid = connect_ready(&e, &host).await;
    println!("  用户确认后连接成功，新公钥已记住，之后正常连接");
    e.core.disconnect(&sid).await.unwrap();

    println!("== 7. 错误密码 5 次后锁定 ==");
    let c = Node::start("C", &api, false).await;
    let pw_before = host.password();
    for i in 1..=5 {
        let err = c
            .core
            .connect(&host.code(), "wrongpw1")
            .await
            .expect_err("错误密码应失败");
        assert_eq!(err.code, "PASSWORD_WRONG", "第 {i} 次：{err}");
        println!("  第 {i} 次错误密码 -> {}", err.code);
    }
    assert!(
        wait_until(10, || host
            .core
            .local_info()
            .locked_remaining_secs
            .is_some())
        .await,
        "5 次失败后被控端应锁定"
    );
    let err = c
        .core
        .connect(&host.code(), &host.password())
        .await
        .expect_err("锁定期间应拒绝");
    assert_eq!(err.code, "LOCKED", "{err}");
    println!(
        "  第 6 次（即使密码正确）-> {}（{}）",
        err.code, err.message
    );
    assert!(
        wait_until(5, || host.password() != pw_before).await,
        "锁定触发时临时密码应已刷新"
    );
    println!(
        "  被控端锁定剩余 {:?} 秒，临时密码已刷新",
        host.core.local_info().locked_remaining_secs
    );
    assert!(
        !host
            .events(|e| match e {
                CoreEvent::Notice { code, .. } if code == "HOST_LOCKED" => Some(()),
                _ => None,
            })
            .is_empty(),
        "应发出 HOST_LOCKED 通知事件"
    );

    println!("== 8. 服务端数据被重置（内存库重启）后自动重新注册 ==");
    let (old_host_code, old_a_code) = (host.code(), a.code());
    drop(server); // 杀掉服务端进程
    tokio::time::sleep(Duration::from_secs(1)).await;
    server = spawn_server(port, relay, proxy_port).await;
    let _ = &server;
    assert!(
        wait_until(90, || {
            let (h, c) = (host.core.local_info(), a.core.local_info());
            h.registered
                && c.registered
                && h.device_code != old_host_code
                && c.device_code != old_a_code
                && h.online
                && c.online
        })
        .await,
        "服务端重启后，被控端和主控端都应自动重新注册并上线；H={:?} A={:?}",
        host.core.local_info(),
        a.core.local_info()
    );
    println!(
        "  H 设备码 {} -> {}，A 设备码 {} -> {}",
        old_host_code,
        host.code(),
        old_a_code,
        a.code()
    );
    assert!(
        !host
            .events(|e| match e {
                CoreEvent::Notice { code, .. } if code == "RE_REGISTERED" => Some(()),
                _ => None,
            })
            .is_empty(),
        "应发出 RE_REGISTERED 通知"
    );
    let sid = connect_ready(&a, &host).await;
    let term = open_shell(&a, &sid).await;
    a.core
        .term_submit(&sid, &term, "echo AFTER_SERVER_RESET".into(), vec![])
        .await
        .unwrap();
    assert!(
        wait_until(15, || count(&a.text(&sid, &term), "AFTER_SERVER_RESET")
            >= 2)
        .await
    );
    println!("  重新注册后连接、终端、echo 正常");
    a.core.disconnect(&sid).await.unwrap();

    println!("== 收尾 ==");
    for n in [&a, &b, &c, &d, &e, &f, &g, &host] {
        n.core.shutdown().await;
    }
    println!("full_local 全部通过");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要已运行的服务端（RTERM_API_URL，默认 http://127.0.0.1:8080）"]
async fn smoke_with_server() {
    let api = std::env::var("RTERM_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    println!("服务端：{api}");
    let host = Node::start("H", &api, false).await;
    let ctl = Node::start("A", &api, false).await;
    let sid = connect_ready(&ctl, &host).await;
    let term = basic_flow(&ctl, Some(&host), &sid, true).await;
    ctl.core.close_term(&sid, &term).await.unwrap();
    ctl.core.disconnect(&sid).await.unwrap();
    // 延迟事件（每 5 秒）
    println!("smoke_with_server 通过");
    ctl.core.shutdown().await;
    host.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要外部被控端（RTERM_E2E_HOST_CODE / RTERM_E2E_HOST_PASSWORD）"]
async fn smoke_external_host() {
    let api = std::env::var("RTERM_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let code = std::env::var("RTERM_E2E_HOST_CODE").expect("需要 RTERM_E2E_HOST_CODE");
    let pw = std::env::var("RTERM_E2E_HOST_PASSWORD").expect("需要 RTERM_E2E_HOST_PASSWORD");
    let local = std::env::var("RTERM_E2E_HOST_LOCAL").is_ok_and(|v| v == "1");
    let ctl = Node::start("A", &api, false).await;
    let sid = ctl
        .core
        .connect(&code, &pw)
        .await
        .unwrap_or_else(|e| panic!("连接外部被控端失败：{e}"));
    assert!(wait_until(10, || ctl.count_ready(&sid) >= 1).await);
    assert!(
        wait_until(5, || ctl.core.host_snapshot(&sid).is_some()).await,
        "应收到 HelloAck"
    );
    let term = basic_flow(&ctl, None, &sid, local).await;
    // 延迟上报
    let lat = wait_until(12, || {
        !ctl.events(|e| match e {
            CoreEvent::Latency { ms, .. } => Some(*ms),
            _ => None,
        })
        .is_empty()
    })
    .await;
    println!(
        "  延迟事件：{:?}",
        ctl.events(|e| match e {
            CoreEvent::Latency { ms, .. } => Some(*ms),
            _ => None,
        })
    );
    assert!(lat, "5 秒一次的 Latency 事件应出现");
    ctl.core.close_term(&sid, &term).await.unwrap();
    ctl.core.disconnect(&sid).await.unwrap();
    ctl.core.shutdown().await;
    println!("smoke_external_host 通过");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要已运行的服务端、本机已装 claude（只读观察，不发提问）"]
async fn claude_observe() {
    let api = std::env::var("RTERM_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let host = Node::start("H", &api, true).await;
    let ctl = Node::start("A", &api, false).await;
    let sid = connect_ready(&ctl, &host).await;
    let snap = ctl.core.host_snapshot(&sid).unwrap();
    println!(
        "被控端 claude_available={} version={:?}",
        snap.info.claude_available, snap.info.claude_version
    );
    if !snap.info.claude_available {
        println!("本机没有可用的 claude，跳过");
        return;
    }
    // ActionCatalog 在 Hello 之后下发
    assert!(
        wait_until(10, || !ctl
            .events(|e| match e {
                CoreEvent::ActionCatalog { catalog, .. } => Some(catalog.actions.len()),
                _ => None,
            })
            .is_empty())
        .await,
        "应收到 ActionCatalog"
    );
    let n = ctl.events(|e| match e {
        CoreEvent::ActionCatalog { catalog, .. } => {
            Some((catalog.catalog_ver.clone(), catalog.actions.len()))
        }
        _ => None,
    });
    println!("ActionCatalog：{n:?}");

    // 工作目录：RTERM_E2E_CLAUDE_CWD（用已信任的目录可以跳过信任提示，看到 hooks 状态回传），默认临时目录
    let tmp_cwd = tempfile::tempdir().unwrap();
    let cwd: PathBuf = std::env::var("RTERM_E2E_CLAUDE_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| tmp_cwd.path().to_path_buf());
    let launch = rterm_proto::pb::LaunchOptions::default();
    let term = ctl
        .core
        .open_term(
            &sid,
            TermOpenOptions::claude(
                TermSize::new(120, 40),
                cwd.to_string_lossy().to_string(),
                launch,
            ),
        )
        .await
        .expect("打开 Claude 终端");
    // 等 AppState：running + 有状态回传
    let got = wait_until(60, || {
        !ctl.events(|e| match e {
            CoreEvent::AppState { state, .. } if state.running && state.app == "claude" => Some(()),
            _ => None,
        })
        .is_empty()
    })
    .await;
    // 再等状态回传（SessionStart hook / 状态栏）最多 30 秒；需要 claude 已信任该目录且已登录
    let stateful = wait_until(30, || {
        !ctl.events(|e| match e {
            CoreEvent::AppState { state, .. } if state.stateful => Some(()),
            _ => None,
        })
        .is_empty()
    })
    .await;
    println!("状态回传（stateful）= {stateful}");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let states = ctl.events(|e| match e {
        CoreEvent::AppState { state, .. } => Some((
            state.app.clone(),
            state.running,
            state.stateful,
            state.activity.clone(),
            state.version.clone(),
            state.model.clone(),
        )),
        _ => None,
    });
    println!("AppState 序列（app, running, stateful, activity, version, model）：");
    for s in &states {
        println!("  {s:?}");
    }
    let mut parser = vt100::Parser::new(40, 120, 0);
    parser.process(
        ctl.ev
            .out
            .lock()
            .unwrap()
            .get(&(sid.clone(), term.clone()))
            .map(|v| v.as_slice())
            .unwrap_or(&[]),
    );
    let screen = parser.screen().contents();
    println!("--- 终端画面（前 12 行）---");
    for l in screen.lines().take(12) {
        println!("| {l}");
    }
    ctl.core.close_term(&sid, &term).await.unwrap();
    ctl.core.disconnect(&sid).await.unwrap();
    ctl.core.shutdown().await;
    host.core.shutdown().await;
    assert!(got, "60 秒内应收到 claude 的 AppState（running）");
    println!("claude_observe 通过");
}
