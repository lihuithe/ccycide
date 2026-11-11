//! 被控端集成测试：用 `loopback_pair` 做一个测试用"控制端"，完整走一遍
//! Hello -> TermOpen -> TermSubmit -> 输出 -> Resize -> 断开重连 TermAttach 回放 -> 文件上传（含哈希错误）-> 动作执行。
//! Windows 用 cmd 做被测 shell，Unix 用 sh。
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use rterm_core::host::session::{HostConfig, HostCtx, HostSession, SessionEnd};
use rterm_core::host::status::BridgeMessage;
use rterm_core::link::{loopback_pair, FrameTx, Link, PeerInfo};
use rterm_proto::pb::{self, frame::Body};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;

const SHELL_ID: &str = if cfg!(windows) { "cmd" } else { "" };

fn frame(channel: u32, body: Body) -> pb::Frame {
    pb::Frame {
        channel,
        body: Some(body),
    }
}

/// 测试用控制端：把收到的帧缓存起来，按条件取。
struct Ctl {
    tx: FrameTx,
    rx: mpsc::Receiver<pb::Frame>,
    buf: VecDeque<pb::Frame>,
}

impl Ctl {
    fn new(link: Link) -> Ctl {
        Ctl {
            tx: link.tx,
            rx: link.rx,
            buf: VecDeque::new(),
        }
    }

    async fn send(&self, channel: u32, body: Body) {
        self.tx.send(frame(channel, body)).await.expect("send");
    }

    /// 取出第一个满足条件的帧（之前的帧留在缓存里）。
    async fn expect<T>(
        &mut self,
        secs: u64,
        what: &str,
        mut pick: impl FnMut(&pb::Frame) -> Option<T>,
    ) -> T {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            if let Some(i) = (0..self.buf.len()).find(|i| pick(&self.buf[*i]).is_some()) {
                let f = self.buf.remove(i).expect("exists");
                return pick(&f).expect("picked");
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                panic!(
                    "等待 {what} 超时；缓存里还有 {} 帧：{:?}",
                    self.buf.len(),
                    self.buf.iter().map(summary).collect::<Vec<_>>()
                );
            }
            match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Some(f)) => self.buf.push_back(f),
                Ok(None) => panic!("链路已关闭，仍在等待 {what}"),
                Err(_) => {}
            }
        }
    }

    /// 在某个终端通道上累积输出，直到文本里出现 needle。返回（累积的全部文本，是否包含 needle）。
    async fn output_until(&mut self, channel: u32, needle: &str, secs: u64) -> String {
        let mut text = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            // 先吃缓存里该通道的输出
            let mut rest = VecDeque::new();
            while let Some(f) = self.buf.pop_front() {
                match &f.body {
                    Some(Body::TermOutput(o)) if f.channel == channel => {
                        text.extend_from_slice(&o.data)
                    }
                    _ => rest.push_back(f),
                }
            }
            self.buf = rest;
            if String::from_utf8_lossy(&text).contains(needle) {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                panic!(
                    "等待输出 {needle:?} 超时，已收到：{:?}",
                    String::from_utf8_lossy(&text)
                );
            }
            if let Ok(Some(f)) = tokio::time::timeout(left, self.rx.recv()).await {
                self.buf.push_back(f);
            }
        }
        String::from_utf8_lossy(&text).into_owned()
    }

    async fn hello(&mut self, features: &[&str]) -> (pb::HelloAck, Option<pb::ActionCatalog>) {
        self.send(
            0,
            Body::Hello(pb::Hello {
                proto_ver: 1,
                min_proto_ver: 1,
                app_version: "test".into(),
                features: features.iter().map(|s| s.to_string()).collect(),
            }),
        )
        .await;
        let ack = self
            .expect(10, "HelloAck", |f| match &f.body {
                Some(Body::HelloAck(a)) => Some(a.clone()),
                _ => None,
            })
            .await;
        let cat = if features.contains(&"app.actions") {
            Some(
                self.expect(10, "ActionCatalog", |f| match &f.body {
                    Some(Body::ActionCatalog(c)) => Some(c.clone()),
                    _ => None,
                })
                .await,
            )
        } else {
            None
        };
        (ack, cat)
    }

    async fn open_term(&mut self, req_id: u64) -> pb::TermOpened {
        self.send(
            0,
            Body::TermOpen(pb::TermOpen {
                req_id,
                profile: pb::Profile::Shell as i32,
                shell_id: SHELL_ID.into(),
                cwd: String::new(),
                cols: 100,
                rows: 30,
                command: String::new(),
                launch: None,
            }),
        )
        .await;
        self.expect(10, "TermOpened", |f| match &f.body {
            Some(Body::TermOpened(o)) if o.req_id == req_id => Some(o.clone()),
            _ => None,
        })
        .await
    }

    async fn action(
        &mut self,
        channel: u32,
        req_id: u64,
        id: &str,
        args: &[(&str, &str)],
    ) -> pb::TermActionResult {
        self.send(
            channel,
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
        self.expect(10, "TermActionResult", |f| match &f.body {
            Some(Body::TermActionResult(r)) if r.req_id == req_id => Some(r.clone()),
            _ => None,
        })
        .await
    }

    async fn upload(
        &mut self,
        id: u64,
        name: &str,
        data: &[u8],
        sha: Vec<u8>,
    ) -> Result<pb::FileDone, pb::Error> {
        self.send(
            0,
            Body::FileBegin(pb::FileBegin {
                file_id: id,
                name: name.into(),
                size: data.len() as u64,
                mime: String::new(),
            }),
        )
        .await;
        // Accept 或 Error
        let first = self
            .expect(10, "FileAccept/Error", |f| match &f.body {
                Some(Body::FileAccept(a)) if a.file_id == id => Some(Ok(*a)),
                Some(Body::Error(e)) if e.ref_id == id => Some(Err(e.clone())),
                _ => None,
            })
            .await;
        first?;
        let mut off = 0u64;
        for part in data.chunks(32 * 1024) {
            self.tx
                .send_bulk(frame(
                    0,
                    Body::FileChunk(pb::FileChunk {
                        file_id: id,
                        offset: off,
                        data: part.to_vec(),
                    }),
                ))
                .await
                .expect("bulk");
            off += part.len() as u64;
        }
        self.send(
            0,
            Body::FileEnd(pb::FileEnd {
                file_id: id,
                sha256: sha,
            }),
        )
        .await;
        self.expect(10, "FileDone/Error", |f| match &f.body {
            Some(Body::FileDone(d)) if d.file_id == id => Some(Ok(d.clone())),
            Some(Body::Error(e)) if e.ref_id == id => Some(Err(e.clone())),
            _ => None,
        })
        .await
    }
}

fn summary(f: &pb::Frame) -> String {
    match &f.body {
        Some(Body::TermOutput(o)) => format!(
            "ch{} TermOutput(seq={},len={})",
            f.channel,
            o.seq,
            o.data.len()
        ),
        Some(b) => format!("ch{} {:?}", f.channel, std::mem::discriminant(b)),
        None => "empty".into(),
    }
}

async fn new_ctx(dir: &std::path::Path, tweak: impl FnOnce(&mut HostConfig)) -> Arc<HostCtx> {
    let mut cfg = HostConfig::new(dir.to_path_buf());
    cfg.probe_claude = false;
    if cfg!(windows) {
        cfg.default_shell = Some("cmd".into());
    }
    tweak(&mut cfg);
    HostCtx::new(cfg).await
}

/// 建立一条新的会话（主控设备码默认 "devA"）：返回控制端和宿主会话任务的句柄。
fn connect(ctx: &Arc<HostCtx>) -> (Ctl, tokio::task::JoinHandle<SessionEnd>, Arc<Notify>) {
    connect_as(ctx, "devA")
}

/// 以指定的主控设备码建立会话。宿主端从 `Link.peer.device_code` 取得主控设备标识。
fn connect_as(
    ctx: &Arc<HostCtx>,
    device: &str,
) -> (Ctl, tokio::task::JoinHandle<SessionEnd>, Arc<Notify>) {
    // loopback_pair(peer_a, peer_b)：a 端（宿主）看到的对端信息是 peer_b
    let (host_link, ctl_link) = loopback_pair(
        PeerInfo {
            device_code: "host".into(),
            ..Default::default()
        },
        PeerInfo {
            device_code: device.into(),
            ..Default::default()
        },
    );
    let kick = Arc::new(Notify::new());
    let h = tokio::spawn(HostSession::run_with_kick(
        host_link,
        ctx.clone(),
        kick.clone(),
    ));
    (Ctl::new(ctl_link), h, kick)
}

fn sha(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

const ALL_FEATURES: &[&str] = &[
    "term.submit",
    "file.upload",
    "app.actions",
    "app.state",
    "app.commands",
];

#[tokio::test]
async fn full_walkthrough() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c, h, _kick) = connect(&ctx);

    // ── Hello / HelloAck / ActionCatalog ──
    let (ack, cat) = c.hello(ALL_FEATURES).await;
    assert_eq!(ack.proto_ver, 1);
    let host = ack.host.expect("HostInfo");
    assert!(!host.shells.is_empty());
    assert_eq!(host.max_file_size, 200 * 1024 * 1024);
    assert!(ack.features.iter().any(|f| f == "file.upload"));
    let cat = cat.expect("目录");
    assert_eq!(cat.app, "claude");
    assert!(cat.actions.iter().any(|a| a.id == "model.set"));

    // ── TermOpen(shell) ──
    let opened = c.open_term(1).await;
    assert_eq!(opened.channel, 1);
    let ch = opened.channel;
    let first = c.output_until(ch, ">", 10).await;
    assert!(!first.is_empty());

    // ── TermSubmit：整条消息提交 ──
    c.send(
        ch,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 1,
            text: "echo hello_submit".into(),
            attachments: vec![],
            press_enter: true,
        }),
    )
    .await;
    let out = c.output_until(ch, "hello_submit", 10).await;
    assert!(out.contains("hello_submit"));

    // ── TermResize ──
    c.send(
        ch,
        Body::TermResize(pb::TermResize {
            cols: 120,
            rows: 40,
        }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    if cfg!(windows) {
        c.send(
            ch,
            Body::TermSubmit(pb::TermSubmit {
                msg_id: 2,
                text: "mode con".into(),
                attachments: vec![],
                press_enter: true,
            }),
        )
        .await;
        let out = c.output_until(ch, "Code page", 10).await;
        assert!(
            out.contains("120") && out.contains("40"),
            "尺寸没生效：{out:?}"
        );
    } else {
        c.send(
            ch,
            Body::TermSubmit(pb::TermSubmit {
                msg_id: 2,
                text: "stty size".into(),
                attachments: vec![],
                press_enter: true,
            }),
        )
        .await;
        let out = c.output_until(ch, "40 120", 10).await;
        assert!(out.contains("40 120"));
    }

    // 用 TermList 的 last_seq 作为断开点
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.send(0, Body::TermList(pb::TermList {})).await;
    let list = c
        .expect(10, "TermListResp", |f| match &f.body {
            Some(Body::TermListResp(l)) => Some(l.clone()),
            _ => None,
        })
        .await;
    assert_eq!(list.terms.len(), 1);
    let info = list.terms[0].clone();
    assert!(info.attached && !info.exited);
    assert_eq!(info.channel, ch);
    let term_id = info.term_id.clone();
    let last_seq = info.last_seq;
    let marker = "during_reattach_42";
    let echo = format!("echo {marker}{}", char::from(13u8));

    // ── 断开（终端继续运行）──
    drop(c);
    let end = tokio::time::timeout(Duration::from_secs(10), h)
        .await
        .expect("会话应结束")
        .expect("join");
    assert_eq!(end, SessionEnd::LinkClosed);
    assert_eq!(ctx.terms.live_count(), 1, "断开后终端应继续存在");
    assert!(!ctx.terms.get(&term_id).expect("term").info().attached);

    // ── 第二条会话：TermList + TermAttach(last_seq) ──
    let (mut c2, h2, _k2) = connect(&ctx);
    c2.hello(ALL_FEATURES).await;
    c2.send(0, Body::TermList(pb::TermList {})).await;
    let list = c2
        .expect(10, "TermListResp", |f| match &f.body {
            Some(Body::TermListResp(l)) => Some(l.clone()),
            _ => None,
        })
        .await;
    assert_eq!(list.terms.len(), 1);
    assert!(!list.terms[0].attached);
    c2.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 5,
            term_id: term_id.clone(),
            last_seq,
            cols: 100,
            rows: 30,
        }),
    )
    .await;
    let reopened = c2
        .expect(10, "TermOpened(attach)", |f| match &f.body {
            Some(Body::TermOpened(o)) if o.req_id == 5 => Some(o.clone()),
            _ => None,
        })
        .await;
    assert_eq!(reopened.term_id, term_id);
    let ch2 = reopened.channel;
    // 在新通道上写入，然后断开，下一次附着带上 last_seq 应无缝补全
    c2.send(
        ch2,
        Body::TermInput(pb::TermInput {
            data: echo.clone().into_bytes(),
        }),
    )
    .await;
    let out = c2.output_until(ch2, marker, 10).await;
    assert!(out.contains(marker));
    // 记下此刻 TermList 的 last_seq 之前的偏移：用一个干净的方法——统计这条会话收到的所有 seq
    // （output_until 已消费，这里再发一次 TermList 看 last_seq）
    tokio::time::sleep(Duration::from_millis(300)).await;
    c2.send(0, Body::TermList(pb::TermList {})).await;
    let l = c2
        .expect(10, "TermListResp", |f| match &f.body {
            Some(Body::TermListResp(l)) => Some(l.clone()),
            _ => None,
        })
        .await;
    let seq_after = l.terms[0].last_seq;
    assert!(seq_after > last_seq);

    // ── 文件上传 ──
    let data: Vec<u8> = (0..100_000u32).map(|i| (i % 253) as u8).collect();
    let done = c2
        .upload(7, "../evil/测试 file.bin", &data, sha(&data))
        .await
        .expect("上传应成功");
    let p = std::path::PathBuf::from(&done.remote_path);
    assert!(
        p.starts_with(tmp.path().join("inbox")),
        "文件必须落在 inbox 里：{p:?}"
    );
    assert_eq!(std::fs::read(&p).expect("read"), data);
    // 哈希错误
    let err = c2
        .upload(8, "bad.bin", b"hello", vec![0u8; 32])
        .await
        .expect_err("应失败");
    assert_eq!(err.code, "FILE_HASH_MISMATCH");
    let leftovers: Vec<_> = walk(&tmp.path().join("inbox"))
        .into_iter()
        .filter(|p| p.to_string_lossy().contains("bad.bin"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "哈希错误后不应残留文件：{leftovers:?}"
    );
    // 超过大小上限
    ctx.inbox.set_limits(10, 1 << 30);
    let err = c2
        .upload(9, "big.bin", &[1u8; 11], sha(&[1u8; 11]))
        .await
        .expect_err("应失败");
    assert_eq!(err.code, "FILE_TOO_LARGE");
    ctx.inbox
        .set_limits(200 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
    // 附件随 TermSubmit 提交：占位符换成路径
    let small = b"attachment_body_xyz";
    let done = c2
        .upload(10, "note.txt", small, sha(small))
        .await
        .expect("上传");
    let cmd = if cfg!(windows) {
        "type \u{FFFC}"
    } else {
        "cat \u{FFFC}"
    };
    c2.send(
        ch2,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 3,
            text: cmd.into(),
            attachments: vec![10],
            press_enter: true,
        }),
    )
    .await;
    let out = c2.output_until(ch2, "attachment_body_xyz", 10).await;
    assert!(
        out.contains("attachment_body_xyz"),
        "附件内容应被 shell 读出：{out:?}"
    );
    let _ = done;
    // 未完成的附件：BAD_REQUEST
    c2.send(
        ch2,
        Body::TermSubmit(pb::TermSubmit {
            msg_id: 4,
            text: "x".into(),
            attachments: vec![999],
            press_enter: true,
        }),
    )
    .await;
    let e = c2
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) if e.ref_id == 4 => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "BAD_REQUEST");

    // ── 断开后再附着：回放无缝、无重复 ──
    drop(c2);
    let _ = tokio::time::timeout(Duration::from_secs(10), h2).await;
    let t = ctx.terms.get(&term_id).expect("term");
    assert!(!t.info().attached);
    drop(t);

    let (mut c3, h3, _k3) = connect(&ctx);
    c3.hello(ALL_FEATURES).await;
    c3.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 6,
            term_id: term_id.clone(),
            last_seq: seq_after,
            cols: 0,
            rows: 0,
        }),
    )
    .await;
    let reopened = c3
        .expect(10, "TermOpened", |f| match &f.body {
            Some(Body::TermOpened(o)) if o.req_id == 6 => Some(o.clone()),
            _ => None,
        })
        .await;
    let ch3 = reopened.channel;
    // 从 seq_after 起的回放：第一帧的 seq 必须正好等于 seq_after（若有）；包含上传附件后的输出
    let out = c3.output_until(ch3, "attachment_body_xyz", 10).await;
    assert!(out.contains("attachment_body_xyz"));

    // ── 动作：普通 shell 里没有 Claude Code ──
    let r = c3.action(ch3, 100, "interrupt", &[]).await;
    assert!(!r.ok);
    assert_eq!(r.error, "APP_NOT_RUNNING");
    // 目录里没有的动作
    let r = c3.action(ch3, 101, "no.such.action", &[]).await;
    assert_eq!(r.error, "UNSUPPORTED");

    // 模拟状态回传：SessionStart -> UserPromptSubmit，终端变为"Claude 运行中、工作中"
    for ev in [
        serde_json::json!({"hook_event_name":"SessionStart","session_id":"S1"}),
        serde_json::json!({"hook_event_name":"UserPromptSubmit"}),
    ] {
        ctx.terms.dispatch_bridge(BridgeMessage {
            term_id: term_id.clone(),
            kind: "hook".into(),
            payload: ev,
        });
    }
    let st = c3
        .expect(10, "AppState busy", |f| match &f.body {
            Some(Body::AppState(s)) if s.activity == "busy" => Some(s.clone()),
            _ => None,
        })
        .await;
    assert!(st.running && st.stateful);
    // 参数不合法：BAD_REQUEST，终端里不写任何内容
    let r = c3
        .action(ch3, 102, "model.set", &[("model", "opus; rm -rf /")])
        .await;
    assert_eq!(r.error, "BAD_REQUEST");
    // 合法动作：执行成功
    let r = c3.action(ch3, 103, "model.set", &[("model", "opus")]).await;
    assert!(r.ok, "{r:?}");
    let out = c3.output_until(ch3, "model", 10).await;
    assert!(
        out.contains("/model opus") || out.contains("model opus"),
        "{out:?}"
    );
    // 停止（busy 时可用）
    let r = c3.action(ch3, 104, "interrupt", &[]).await;
    assert!(r.ok, "{r:?}");
    // 交互菜单：进入临时直通
    let r = c3.action(ch3, 105, "session.resume", &[]).await;
    assert!(r.ok && r.passthrough);
    assert_eq!(r.return_keys, vec!["enter", "esc"]);

    // ── 自定义命令清单 ──
    c3.send(ch3, Body::CommandListReq(pb::CommandListReq {}))
        .await;
    c3.expect(10, "CommandList", |f| match &f.body {
        Some(Body::CommandList(_)) => Some(()),
        _ => None,
    })
    .await;

    // ── 目录热更新：合法的会推送，非法的忽略 ──
    ctx.set_remote_catalog_json(Some(r#"{"catalog_ver":"remote-1","app":"claude","actions":[{"id":"only.one","title":"唯一","kind":"keys","steps":[{"keys":["esc"]}]}]}"#));
    let newcat = c3
        .expect(10, "新的 ActionCatalog", |f| match &f.body {
            Some(Body::ActionCatalog(c)) if c.catalog_ver == "remote-1" => Some(c.clone()),
            _ => None,
        })
        .await;
    assert_eq!(newcat.actions.len(), 1);
    ctx.set_remote_catalog_json(Some(r#"{"catalog_ver":"evil","app":"claude","actions":[{"id":"x","title":"t","kind":"keys","steps":[{"keys":["f13"]}]}]}"#));
    let fallback = c3
        .expect(10, "回退到内置目录", |f| match &f.body {
            Some(Body::ActionCatalog(c)) if c.catalog_ver != "remote-1" => Some(c.clone()),
            _ => None,
        })
        .await;
    assert!(fallback.actions.len() > 20, "非法目录整份丢弃，用内置的");

    // ── 关闭终端 ──
    c3.send(
        0,
        Body::TermClose(pb::TermClose {
            term_id: term_id.clone(),
            kill: true,
        }),
    )
    .await;
    c3.expect(10, "TermExit", |f| match &f.body {
        Some(Body::TermExit(_)) => Some(()),
        _ => None,
    })
    .await;
    for _ in 0..50 {
        if ctx.terms.get(&term_id).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ctx.terms.get(&term_id).is_none());
    c3.send(
        0,
        Body::Bye(pb::Bye {
            reason: "done".into(),
        }),
    )
    .await;
    let end = tokio::time::timeout(Duration::from_secs(10), h3)
        .await
        .expect("结束")
        .expect("join");
    assert_eq!(end, SessionEnd::Bye("done".into()));
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut st = vec![dir.to_path_buf()];
    while let Some(d) = st.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    st.push(e.path());
                } else {
                    out.push(e.path());
                }
            }
        }
    }
    out
}

#[tokio::test]
async fn gap_free_replay_after_disconnect() {
    // 单独验证"断开期间的输出在重连后无缝补全，没有重复、没有缺失"
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c, h, _k) = connect(&ctx);
    c.hello(&[]).await;
    let opened = c.open_term(1).await;
    let ch = opened.channel;
    // 收集该通道的所有帧，记录 (seq, data)
    let mut chunks: Vec<(u64, Vec<u8>)> = Vec::new();
    let pump = |c: &mut Ctl, chunks: &mut Vec<(u64, Vec<u8>)>| {
        while let Some(f) = c.buf.pop_front() {
            if let (true, Some(Body::TermOutput(o))) = (f.channel == ch, &f.body) {
                chunks.push((o.seq, o.data.clone()));
            }
        }
    };
    // 等到提示符
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(&mut c, &mut chunks);
        if String::from_utf8_lossy(
            &chunks
                .iter()
                .flat_map(|(_, d)| d.clone())
                .collect::<Vec<u8>>(),
        )
        .contains('>')
            || Instant::now() > deadline
        {
            break;
        }
        if let Ok(Some(f)) = tokio::time::timeout(Duration::from_millis(100), c.rx.recv()).await {
            c.buf.push_back(f);
        }
    }
    // 让输出静止，再记录 last_seq
    tokio::time::sleep(Duration::from_millis(500)).await;
    while let Ok(Some(f)) = tokio::time::timeout(Duration::from_millis(50), c.rx.recv()).await {
        c.buf.push_back(f);
    }
    pump(&mut c, &mut chunks);
    let last_seq = chunks.last().map(|(s, d)| s + d.len() as u64).unwrap_or(0);
    assert!(last_seq > 0);
    // 在断开前让终端产生将在断开后继续输出的命令：用 ping/sleep 延迟输出
    let slow = if cfg!(windows) {
        "ping -n 3 127.0.0.1 > nul & echo late_output_marker\r"
    } else {
        "sleep 2; echo late_output_marker\r"
    };
    c.send(
        ch,
        Body::TermInput(pb::TermInput {
            data: slow.as_bytes().to_vec(),
        }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    while let Ok(Some(f)) = tokio::time::timeout(Duration::from_millis(50), c.rx.recv()).await {
        c.buf.push_back(f);
    }
    pump(&mut c, &mut chunks);
    let seen_end = chunks.last().map(|(s, d)| s + d.len() as u64).unwrap_or(0);
    drop(c);
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    // 断开期间，延迟输出到达
    tokio::time::sleep(Duration::from_secs(4)).await;

    let (mut c2, _h2, _k2) = connect(&ctx);
    c2.hello(&[]).await;
    let term_id = opened.term_id.clone();
    c2.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 2,
            term_id,
            last_seq: seen_end,
            cols: 0,
            rows: 0,
        }),
    )
    .await;
    let o2 = c2
        .expect(10, "TermOpened", |f| match &f.body {
            Some(Body::TermOpened(o)) if o.req_id == 2 => Some(o.clone()),
            _ => None,
        })
        .await;
    let out = c2.output_until(o2.channel, "late_output_marker", 10).await;
    assert!(out.contains("late_output_marker"));
    // 重放帧的 seq 从 seen_end 开始、连续
    let replay: Vec<(u64, usize)> = c2
        .buf
        .iter()
        .filter_map(|f| match &f.body {
            Some(Body::TermOutput(o)) => Some((o.seq, o.data.len())),
            _ => None,
        })
        .collect();
    let _ = replay;
    // 总字节：断开前收到的 + 回放的 = 终端环形缓冲的全部内容（无缺失无重复）
    let mut all: Vec<u8> = Vec::new();
    let mut expect_seq = 0u64;
    chunks.sort_by_key(|(s, _)| *s);
    for (s, d) in &chunks {
        assert_eq!(*s, expect_seq, "断开前的输出 seq 应连续");
        expect_seq += d.len() as u64;
        all.extend_from_slice(d);
    }
    assert_eq!(expect_seq, seen_end);
}

#[tokio::test]
async fn terminal_limit_error_code() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |c| c.term.max_terminals = 2).await;
    let (mut c, _h, _k) = connect(&ctx);
    c.hello(&[]).await;
    let a = c.open_term(1).await;
    let b = c.open_term(2).await;
    assert_ne!(a.channel, b.channel);
    c.send(
        0,
        Body::TermOpen(pb::TermOpen {
            req_id: 3,
            profile: 0,
            shell_id: SHELL_ID.into(),
            cols: 80,
            rows: 24,
            ..Default::default()
        }),
    )
    .await;
    let e = c
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) if e.ref_id == 3 => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "TERM_LIMIT");
    // 未知终端
    c.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 4,
            term_id: "nope".into(),
            ..Default::default()
        }),
    )
    .await;
    let e = c
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) if e.ref_id == 4 => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "TERM_NOT_FOUND");
    ctx.shutdown().await;
}

#[tokio::test]
async fn takeover_notifies_old_session() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c1, _h1, _k1) = connect(&ctx);
    c1.hello(&[]).await;
    let o = c1.open_term(1).await;
    c1.output_until(o.channel, ">", 10).await;
    let (mut c2, _h2, _k2) = connect(&ctx);
    c2.hello(&[]).await;
    c2.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 2,
            term_id: o.term_id.clone(),
            last_seq: 0,
            cols: 0,
            rows: 0,
        }),
    )
    .await;
    // 旧会话收到 TERM_DETACHED
    let e = c1
        .expect(10, "TERM_DETACHED", |f| match &f.body {
            Some(Body::Error(e)) if e.code == "TERM_DETACHED" => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.message, o.term_id);
    // 旧会话再写入：被拒绝
    c1.send(
        o.channel,
        Body::TermInput(pb::TermInput {
            data: b"echo hijack\r".to_vec(),
        }),
    )
    .await;
    let e = c1
        .expect(10, "写入被拒绝", |f| match &f.body {
            Some(Body::Error(e)) if e.code == "TERM_DETACHED" && f.channel == o.channel => {
                Some(e.clone())
            }
            _ => None,
        })
        .await;
    assert_eq!(e.code, "TERM_DETACHED");
    ctx.shutdown().await;
}

#[tokio::test]
async fn incompatible_version_and_missing_hello() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    // 版本不兼容
    let (mut c, h, _k) = connect(&ctx);
    c.send(
        0,
        Body::Hello(pb::Hello {
            proto_ver: 9,
            min_proto_ver: 9,
            ..Default::default()
        }),
    )
    .await;
    let e = c
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "UNSUPPORTED");
    let end = tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .expect("结束")
        .expect("join");
    assert!(matches!(end, SessionEnd::Handshake(_)));
    // 第一条不是 Hello
    let (mut c, h, _k) = connect(&ctx);
    c.send(0, Body::TermList(pb::TermList {})).await;
    let e = c
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "BAD_REQUEST");
    let end = tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .expect("结束")
        .expect("join");
    assert!(matches!(end, SessionEnd::Handshake(_)));
}

#[tokio::test]
async fn kick_ends_session_and_ping_pong() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c, h, kick) = connect(&ctx);
    c.hello(&[]).await;
    c.send(0, Body::Ping(pb::Ping { ts: 77 })).await;
    let p = c
        .expect(10, "Pong", |f| match &f.body {
            Some(Body::Pong(p)) => Some(p.ts),
            _ => None,
        })
        .await;
    assert_eq!(p, 77);
    kick.notify_one();
    let end = tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .expect("结束")
        .expect("join");
    assert_eq!(end, SessionEnd::Kicked);
}

#[tokio::test]
async fn file_receive_can_be_disabled() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |c| c.file_receive = false).await;
    let (mut c, _h, _k) = connect(&ctx);
    let (ack, _) = c.hello(ALL_FEATURES).await;
    assert!(!ack.features.iter().any(|f| f == "file.upload"));
    let err = c
        .upload(1, "a.txt", b"x", sha(b"x"))
        .await
        .expect_err("应被拒绝");
    assert_eq!(err.code, "FILE_DISABLED");
}

#[tokio::test]
async fn disconnect_mid_upload_removes_part_file() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c, h, _k) = connect(&ctx);
    c.hello(&[]).await;
    c.send(
        0,
        Body::FileBegin(pb::FileBegin {
            file_id: 1,
            name: "half.bin".into(),
            size: 100_000,
            mime: String::new(),
        }),
    )
    .await;
    c.expect(10, "FileAccept", |f| match &f.body {
        Some(Body::FileAccept(_)) => Some(()),
        _ => None,
    })
    .await;
    c.tx.send_bulk(frame(
        0,
        Body::FileChunk(pb::FileChunk {
            file_id: 1,
            offset: 0,
            data: vec![9u8; 32 * 1024],
        }),
    ))
    .await
    .expect("bulk");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        walk(&tmp.path().join("inbox"))
            .iter()
            .any(|p| p.to_string_lossy().ends_with(".part")),
        "上传中应有 .part"
    );
    drop(c);
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        walk(&tmp.path().join("inbox")).is_empty(),
        "会话中断后 .part 应被删除"
    );
}

fn term_list(c: &Ctl) -> Body {
    let _ = c;
    Body::TermList(pb::TermList {})
}

async fn list_ids(c: &mut Ctl) -> Vec<pb::TermInfo> {
    c.send(0, term_list(c)).await;
    c.expect(10, "TermListResp", |f| match &f.body {
        Some(Body::TermListResp(l)) => Some(l.terms.clone()),
        _ => None,
    })
    .await
}

async fn expect_error(c: &mut Ctl, ref_id: u64) -> pb::Error {
    c.expect(10, "Error", |f| match &f.body {
        Some(Body::Error(e)) if e.ref_id == ref_id => Some(e.clone()),
        _ => None,
    })
    .await
}

#[tokio::test]
async fn isolation_between_devices_and_no_preemption() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    assert!(ctx.terms.isolate_terminals(), "默认开启隔离");

    // A 创建终端
    let (mut a, ha, _ka) = connect_as(&ctx, "devA");
    a.hello(&[]).await;
    let opened = a.open_term(1).await;
    a.output_until(opened.channel, ">", 10).await;
    let term_id = opened.term_id.clone();

    // ── 隔离开启：B 看不到、附着和关闭都是 TERM_NOT_FOUND ──
    let (mut b, hb, _kb) = connect_as(&ctx, "devB");
    b.hello(&[]).await;
    assert!(list_ids(&mut b).await.is_empty());
    b.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 10,
            term_id: term_id.clone(),
            ..Default::default()
        }),
    )
    .await;
    assert_eq!(expect_error(&mut b, 10).await.code, "TERM_NOT_FOUND");
    b.send(
        0,
        Body::TermClose(pb::TermClose {
            term_id: term_id.clone(),
            kill: true,
        }),
    )
    .await;
    assert_eq!(
        b.expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) if e.code == "TERM_NOT_FOUND" => Some(e.clone()),
            _ => None,
        })
        .await
        .code,
        "TERM_NOT_FOUND"
    );
    assert_eq!(ctx.terms.live_count(), 1, "别人的 TermClose 不能关掉终端");
    // A 自己看得到
    let mine = list_ids(&mut a).await;
    assert_eq!(mine.len(), 1);
    assert!(mine[0].attached && !mine[0].attached_by_other);

    // ── 热切换：关闭隔离，B 立即可见，但 A 还附着着 -> TERM_BUSY ──
    ctx.set_isolate_terminals(false);
    let seen = list_ids(&mut b).await;
    assert_eq!(seen.len(), 1);
    assert!(seen[0].attached && seen[0].attached_by_other && seen[0].channel == 0);
    b.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 11,
            term_id: term_id.clone(),
            ..Default::default()
        }),
    )
    .await;
    assert_eq!(expect_error(&mut b, 11).await.code, "TERM_BUSY");
    // A 的附着没受影响，仍能操作
    a.send(
        opened.channel,
        Body::TermInput(pb::TermInput {
            data: b"echo still_mine\r".to_vec(),
        }),
    )
    .await;
    a.output_until(opened.channel, "still_mine", 10).await;

    // ── A 断线（会话死亡）后，B 可以接管 ──
    drop(a);
    let _ = tokio::time::timeout(Duration::from_secs(10), ha).await;
    let seen = list_ids(&mut b).await;
    assert!(!seen[0].attached && !seen[0].attached_by_other);
    b.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 12,
            term_id: term_id.clone(),
            last_seq: 0,
            cols: 0,
            rows: 0,
        }),
    )
    .await;
    let ob = b
        .expect(10, "TermOpened", |f| match &f.body {
            Some(Body::TermOpened(o)) if o.req_id == 12 => Some(o.clone()),
            _ => None,
        })
        .await;
    b.output_until(ob.channel, "still_mine", 10).await;

    // ── 再次打开隔离：已附着的不被踢，但新请求按隔离处理 ──
    ctx.set_isolate_terminals(true);
    b.send(
        ob.channel,
        Body::TermInput(pb::TermInput {
            data: b"echo after_toggle\r".to_vec(),
        }),
    )
    .await;
    b.output_until(ob.channel, "after_toggle", 10).await;
    assert!(
        list_ids(&mut b).await.is_empty(),
        "隔离重新开启后 B 不拥有该终端，列表为空"
    );
    // A 重连：隔离开着，终端属于 A，但被 B 占用 -> TERM_BUSY
    let (mut a2, _ha2, _ka2) = connect_as(&ctx, "devA");
    a2.hello(&[]).await;
    let l = list_ids(&mut a2).await;
    assert_eq!(l.len(), 1);
    assert!(l[0].attached_by_other);
    a2.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 13,
            term_id: term_id.clone(),
            ..Default::default()
        }),
    )
    .await;
    assert_eq!(expect_error(&mut a2, 13).await.code, "TERM_BUSY");
    drop(b);
    let _ = tokio::time::timeout(Duration::from_secs(10), hb).await;
    ctx.shutdown().await;
}

#[tokio::test]
async fn same_device_reconnect_takes_over_before_old_link_dies() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let (mut c1, _h1, _k1) = connect_as(&ctx, "devA");
    c1.hello(&[]).await;
    let o = c1.open_term(1).await;
    c1.output_until(o.channel, ">", 10).await;
    // 同一台主控重连，旧连接还没被检测到断开
    let (mut c2, _h2, _k2) = connect_as(&ctx, "devA");
    c2.hello(&[]).await;
    assert_eq!(list_ids(&mut c2).await.len(), 1, "重连后仍是自己的终端");
    c2.send(
        0,
        Body::TermAttach(pb::TermAttach {
            req_id: 5,
            term_id: o.term_id.clone(),
            ..Default::default()
        }),
    )
    .await;
    c2.expect(10, "TermOpened", |f| match &f.body {
        Some(Body::TermOpened(x)) if x.req_id == 5 => Some(()),
        _ => None,
    })
    .await;
    // 旧会话收到 TERM_DETACHED
    let e = c1
        .expect(10, "TERM_DETACHED", |f| match &f.body {
            Some(Body::Error(e)) if e.code == "TERM_DETACHED" => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.message, o.term_id);
    ctx.shutdown().await;
}

#[tokio::test]
async fn isolation_follows_guard_settings() {
    use rterm_core::host::guard::{AccessSettings, Guard};
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    let guard = Guard::with_kdf(
        "123456789",
        AccessSettings::default(),
        Arc::new(|_, _| Ok([0u8; 32])),
    );
    ctx.bind_guard(&guard);
    assert!(ctx.terms.isolate_terminals());
    guard.update_settings(AccessSettings {
        isolate_terminals: false,
        ..AccessSettings::default()
    });
    for _ in 0..50 {
        if !ctx.terms.isolate_terminals() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!ctx.terms.isolate_terminals(), "设置变化应同步到 HostCtx");
    guard.update_settings(AccessSettings::default());
    for _ in 0..50 {
        if ctx.terms.isolate_terminals() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ctx.terms.isolate_terminals());
}

/// 审查 L3：隔离关闭（所有设备互相可见）时，`TermClose` 不能关掉正被另一个存活会话附着的终端，
/// 与 `TermAttach` 的 `TERM_BUSY` 一致。
#[tokio::test]
async fn term_close_does_not_kill_a_terminal_busy_with_another_device() {
    let tmp = tempfile::tempdir().expect("tmp");
    let ctx = new_ctx(tmp.path(), |_| {}).await;
    ctx.set_isolate_terminals(false);

    let (mut a, ha, _ka) = connect_as(&ctx, "devA");
    a.hello(&[]).await;
    let opened = a.open_term(1).await;
    a.output_until(opened.channel, ">", 10).await;
    let term_id = opened.term_id.clone();

    let (mut b, hb, _kb) = connect_as(&ctx, "devB");
    b.hello(&[]).await;
    assert_eq!(list_ids(&mut b).await.len(), 1, "隔离关闭：B 看得见");
    b.send(
        0,
        Body::TermClose(pb::TermClose {
            term_id: term_id.clone(),
            kill: true,
        }),
    )
    .await;
    let e = b
        .expect(10, "Error", |f| match &f.body {
            Some(Body::Error(e)) if e.code == "TERM_BUSY" => Some(e.clone()),
            _ => None,
        })
        .await;
    assert_eq!(e.code, "TERM_BUSY");
    assert_eq!(ctx.terms.live_count(), 1, "被 A 占用的终端不能被 B 关掉");
    // A 的终端照常工作
    a.send(
        opened.channel,
        Body::TermInput(pb::TermInput {
            data: b"echo still_alive\r".to_vec(),
        }),
    )
    .await;
    a.output_until(opened.channel, "still_alive", 10).await;

    // A 自己可以关
    a.send(
        0,
        Body::TermClose(pb::TermClose {
            term_id: term_id.clone(),
            kill: true,
        }),
    )
    .await;
    for _ in 0..100 {
        if ctx.terms.live_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(ctx.terms.live_count(), 0, "所有者自己关闭应当成功");
    drop(a);
    let _ = tokio::time::timeout(Duration::from_secs(10), ha).await;
    drop(b);
    let _ = tokio::time::timeout(Duration::from_secs(10), hb).await;
    ctx.shutdown().await;
}
