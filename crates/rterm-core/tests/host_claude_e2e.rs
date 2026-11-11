//! 真实 Claude Code 的端到端验证（默认忽略：需要本机装有 claude 并已登录）。
//!
//! 运行：`cargo test -p rterm-core --test host_claude_e2e -- --ignored --nocapture`
//! 可选环境变量：
//! - `RTERM_TEST_CLI`：hook 命令的可执行文件（需要带 `hook [--statusline]` 子命令，例如 tools/spike-s2 里的 hookprobe.exe）。
//!   设置后会验证状态回传（AppState / 状态栏）。
//! - `RTERM_TEST_CWD`：Claude Code 的工作目录（默认系统临时目录）。
//! - `RTERM_TEST_SHELL`：用哪个 shell（默认 Windows 用 powershell，其他平台用默认 shell）。
//!
//! 全程不会向模型发送任何提问：只执行本地斜杠命令（/context 等）、按键，以及 press_enter=false 的消息。
use std::sync::Arc;
use std::time::Duration;

use rterm_core::host::session::{HostConfig, HostCtx, HostSession};
use rterm_core::link::{loopback_pair, FrameTx, Link, PeerInfo};
use rterm_proto::pb::{self, frame::Body};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

struct Screen {
    parser: vt100::Parser,
}

impl Screen {
    fn text(&self) -> String {
        self.parser.screen().contents()
    }
}

struct Ctl {
    tx: FrameTx,
    rx: tokio::sync::mpsc::Receiver<pb::Frame>,
    screen: Screen,
    channel: u32,
    app_states: Vec<pb::AppState>,
    notices: Vec<pb::AppNotice>,
    results: Vec<pb::TermActionResult>,
    file_done: Vec<pb::FileDone>,
}

impl Ctl {
    fn new(link: Link) -> Ctl {
        Ctl {
            tx: link.tx,
            rx: link.rx,
            screen: Screen {
                parser: vt100::Parser::new(40, 120, 0),
            },
            channel: 0,
            app_states: Vec::new(),
            notices: Vec::new(),
            results: Vec::new(),
            file_done: Vec::new(),
        }
    }

    async fn send(&self, channel: u32, body: Body) {
        self.tx
            .send(pb::Frame {
                channel,
                body: Some(body),
            })
            .await
            .expect("send");
    }

    /// 处理收到的帧，直到 `cond` 成立或超时。返回是否成立。
    async fn pump_until(&mut self, secs: u64, mut cond: impl FnMut(&Ctl) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            if cond(self) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            if let Ok(Some(f)) =
                tokio::time::timeout(left.min(Duration::from_millis(200)), self.rx.recv()).await
            {
                self.on_frame(f);
            }
        }
    }

    fn on_frame(&mut self, f: pb::Frame) {
        match f.body {
            Some(Body::TermOpened(o)) => self.channel = o.channel,
            Some(Body::TermOutput(o)) if f.channel == self.channel => {
                self.screen.parser.process(&o.data)
            }
            Some(Body::AppState(s)) => self.app_states.push(s),
            Some(Body::AppNotice(n)) => self.notices.push(n),
            Some(Body::TermActionResult(r)) => self.results.push(r),
            Some(Body::FileDone(d)) => self.file_done.push(d),
            Some(Body::Error(e)) => println!("  [Error] {} {} ref={}", e.code, e.message, e.ref_id),
            _ => {}
        }
    }

    async fn action(
        &mut self,
        req_id: u64,
        id: &str,
        args: &[(&str, &str)],
    ) -> pb::TermActionResult {
        self.send(
            self.channel,
            Body::TermAction(pb::TermAction {
                req_id,
                action_id: id.into(),
                args: args
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            }),
        )
        .await;
        assert!(
            self.pump_until(15, |c| c.results.iter().any(|r| r.req_id == req_id))
                .await,
            "等待动作 {id} 的结果超时"
        );
        self.results
            .iter()
            .find(|r| r.req_id == req_id)
            .cloned()
            .expect("result")
    }

    fn show(&self, label: &str, last_lines: usize) {
        let t = self.screen.text();
        let lines: Vec<&str> = t.lines().filter(|l| !l.trim().is_empty()).collect();
        println!("----- {label} -----");
        for l in lines.iter().skip(lines.len().saturating_sub(last_lines)) {
            println!("| {}", l.trim_end());
        }
    }
}

#[tokio::test]
#[ignore = "需要本机已安装并登录 Claude Code"]
async fn claude_end_to_end() {
    let tmp = tempfile::tempdir().expect("tmp");
    let mut cfg = HostConfig::new(tmp.path().to_path_buf());
    cfg.rterm_cli = std::env::var_os("RTERM_TEST_CLI").map(Into::into);
    let ctx: Arc<HostCtx> = HostCtx::new(cfg).await;
    let info = ctx.host_info();
    println!(
        "HostInfo: claude_available={} version={} shells={:?}",
        info.claude_available,
        info.claude_version,
        info.shells
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>()
    );
    assert!(info.claude_available, "本机没有可用的 claude");

    let (host_link, ctl_link) = loopback_pair(PeerInfo::default(), PeerInfo::default());
    let host_task = tokio::spawn(HostSession::run(host_link, ctx.clone()));
    let mut c = Ctl::new(ctl_link);
    c.send(
        0,
        Body::Hello(pb::Hello {
            proto_ver: 1,
            min_proto_ver: 1,
            app_version: "e2e".into(),
            features: vec![
                "app.actions".into(),
                "app.state".into(),
                "app.commands".into(),
            ],
        }),
    )
    .await;

    let shell_id = std::env::var("RTERM_TEST_SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell".into()
        } else {
            String::new()
        }
    });
    let cwd = std::env::var("RTERM_TEST_CWD")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    c.send(
        0,
        Body::TermOpen(pb::TermOpen {
            req_id: 1,
            profile: pb::Profile::Claude as i32,
            shell_id,
            cwd,
            cols: 120,
            rows: 40,
            command: String::new(),
            launch: Some(pb::LaunchOptions {
                permission_mode: "plan".into(),
                effort: "high".into(),
                ..Default::default()
            }),
        }),
    )
    .await;
    let started = c
        .pump_until(40, |c| {
            c.screen.text().contains("Claude Code") && c.screen.text().contains('❯')
        })
        .await;
    c.show("启动后", 8);
    assert!(started, "Claude Code 没有起来");
    assert!(
        c.screen.text().contains("plan mode on"),
        "启动参数 --permission-mode plan 应生效"
    );

    // 状态回传（需要 RTERM_TEST_CLI）
    if ctx.config.rterm_cli.is_some() {
        let ok = c
            .pump_until(15, |c| {
                c.app_states
                    .iter()
                    .any(|s| s.stateful && s.running && !s.model.is_empty())
            })
            .await;
        let last = c.app_states.last().cloned();
        println!("AppState: {last:?}");
        assert!(ok, "应收到带模型名的 AppState（SessionStart + 状态栏）");
        let st = c
            .app_states
            .iter()
            .rev()
            .find(|s| s.stateful)
            .cloned()
            .expect("state");
        assert_eq!(st.activity, "idle");
        assert_eq!(st.effort, "high");
    } else {
        println!("（未设置 RTERM_TEST_CLI，跳过状态回传验证）");
    }

    // 动作：/context（本地命令，不调用模型）
    let r = c.action(10, "context.show", &[]).await;
    assert!(r.ok, "{r:?}");
    assert!(
        c.pump_until(15, |c| c.screen.text().contains("Context Usage"))
            .await,
        "/context 应显示用量"
    );
    c.show("context.show 之后", 4);

    // 动作：切换权限模式（Shift+Tab）
    let before = c.screen.text().contains("plan mode on");
    let r = c.action(11, "mode.cycle", &[]).await;
    assert!(r.ok, "{r:?}");
    assert!(
        c.pump_until(10, |c| before && !c.screen.text().contains("plan mode on"))
            .await,
        "Shift+Tab 应切走计划模式"
    );
    c.show("mode.cycle 之后", 3);

    // 动作：交互菜单（/resume）-> 临时直通 -> Esc 返回
    let r = c.action(12, "session.resume", &[]).await;
    assert!(r.ok && r.passthrough, "{r:?}");
    c.pump_until(8, |_| false).await;
    c.show("session.resume 之后", 6);
    c.send(
        c.channel,
        Body::TermInput(pb::TermInput {
            data: b"\x1b".to_vec(),
        }),
    )
    .await;
    c.pump_until(3, |_| false).await;

    // 动作：权限按钮 notice_id 校验——没有待处理请求时必须拒绝
    let r = c
        .action(13, "permission.allow", &[("notice_id", "123456")])
        .await;
    assert_eq!(r.error, "BAD_REQUEST");

    // 多行消息（press_enter=false）：应在输入框里是多行，且没有被提交
    c.send(
        c.channel,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 20,
            text: "第一行 abc\n第二行 `code` \"q\"\n第三行 😀".into(),
            attachments: vec![],
            press_enter: false,
        }),
    )
    .await;
    let ok = c
        .pump_until(8, |c| c.screen.text().contains("第三行"))
        .await;
    c.show("多行消息", 6);
    assert!(ok, "多行消息应完整进入输入框");
    assert!(c.screen.text().contains("第一行 abc"));
    // 清空输入框
    for _ in 0..4 {
        c.send(
            c.channel,
            Body::TermInput(pb::TermInput { data: vec![0x15] }),
        )
        .await;
        c.pump_until(1, |_| false).await;
    }

    // 图片附件：上传，占位符换成路径，粘贴后应变成 [Image #n]（新版 ConPTY / Unix）或路径文本（系统 ConPTY）
    let png = tiny_png();
    c.send(
        0,
        Body::FileBegin(pb::FileBegin {
            file_id: 1,
            name: "e2e 图.png".into(),
            size: png.len() as u64,
            mime: "image/png".into(),
        }),
    )
    .await;
    c.send(
        0,
        Body::FileChunk(pb::FileChunk {
            file_id: 1,
            offset: 0,
            data: png.clone(),
        }),
    )
    .await;
    c.send(
        0,
        Body::FileEnd(pb::FileEnd {
            file_id: 1,
            sha256: Sha256::digest(&png).to_vec(),
        }),
    )
    .await;
    assert!(
        c.pump_until(10, |c| !c.file_done.is_empty()).await,
        "上传应完成"
    );
    let remote = c.file_done[0].remote_path.clone();
    println!("remote_path = {remote}");
    c.send(
        c.channel,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 21,
            text: "这张图里有什么？\u{FFFC} 谢谢".into(),
            attachments: vec![1],
            press_enter: false,
        }),
    )
    .await;
    let ok = c.pump_until(10, |c| c.screen.text().contains("谢谢")).await;
    c.pump_until(1, |_| false).await;
    c.show("带附件的消息", 4);
    assert!(ok);
    let t = c.screen.text();
    let chip = t.contains("[Image #1]");
    println!(
        "附件识别为 [Image #1] = {chip}（新版 ConPTY / Unix 预期为 true；系统 ConPTY 为路径文本）"
    );
    assert!(chip || t.contains("e2e"), "附件既不是图片标记也不是路径");
    for _ in 0..4 {
        c.send(
            c.channel,
            Body::TermInput(pb::TermInput { data: vec![0x15] }),
        )
        .await;
        c.pump_until(1, |_| false).await;
    }

    // 自定义命令清单
    c.send(c.channel, Body::CommandListReq(pb::CommandListReq {}))
        .await;
    c.pump_until(5, |_| false).await;

    // 退出：/exit 是本地命令；Claude 退出后回到 shell，终端仍在
    c.send(
        c.channel,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 22,
            text: "/exit".into(),
            attachments: vec![],
            press_enter: true,
        }),
    )
    .await;
    c.pump_until(8, |_| false).await;
    c.show("/exit 之后", 3);
    let snapshot = ctx.terms.list();
    assert_eq!(snapshot.len(), 1);
    c.send(
        0,
        Body::TermClose(pb::TermClose {
            term_id: snapshot[0].term_id.clone(),
            kill: true,
        }),
    )
    .await;
    c.pump_until(5, |_| false).await;
    c.send(
        0,
        Body::Bye(pb::Bye {
            reason: "done".into(),
        }),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(5), host_task).await;
    ctx.shutdown().await;
}

/// 一张 64x64 的纯色 PNG。
fn tiny_png() -> Vec<u8> {
    fn crc32(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        let mut c = 0xFFFF_FFFFu32;
        for b in data {
            c = table[((c ^ *b as u32) & 0xFF) as usize] ^ (c >> 8);
        }
        c ^ 0xFFFF_FFFF
    }
    fn adler32(data: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for d in data {
            a = (a + *d as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }
    let (w, h) = (64usize, 64usize);
    let mut raw = Vec::new();
    for _ in 0..h {
        raw.extend_from_slice(&[0u8]);
        for _ in 0..w {
            raw.extend_from_slice(&[200, 60, 60]);
        }
    }
    // zlib 存储块（不压缩）
    let mut z = vec![0x78, 0x01];
    let mut rest = &raw[..];
    while !rest.is_empty() {
        let n = rest.len().min(65535);
        let last = n == rest.len();
        z.push(if last { 1 } else { 0 });
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes());
        z.extend_from_slice(&rest[..n]);
        rest = &rest[n..];
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let chunk = |t: &[u8; 4], d: &[u8]| {
        let mut v = (d.len() as u32).to_be_bytes().to_vec();
        let mut body = t.to_vec();
        body.extend_from_slice(d);
        v.extend_from_slice(&body);
        v.extend_from_slice(&crc32(&body).to_be_bytes());
        v
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &z));
    png.extend(chunk(b"IEND", &[]));
    png
}
