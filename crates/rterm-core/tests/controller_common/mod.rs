//! 主控端测试的公共设施：假被控端（进程内、说同一套 Frame 协议）、可编排的连接器、事件收集器。
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use rterm_core::controller::{
    ConnectError, ConnectOptions, ConnectSpec, Connected, Connector, Controller, ControllerTiming,
};
use rterm_core::events::CoreEvent;
use rterm_core::link::{loopback_pair, FrameTx, Link, PeerInfo};
use rterm_core::relay::PasswordInput;
use rterm_proto::pb::{self, frame::Body as B};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const HOST_CODE: &str = "123456789";
pub const PW_KEY: [u8; 32] = [1u8; 32];

/// 缩短后的时间参数。
pub fn fast_timing() -> ControllerTiming {
    ControllerTiming {
        backoff_base: Duration::from_millis(30),
        backoff_max: Duration::from_millis(200),
        request_timeout: Duration::from_secs(3),
        hello_timeout: Duration::from_secs(2),
        resync_timeout: Duration::from_secs(3),
        ping_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(60),
        send_timeout: Duration::from_secs(3),
        upload_stall: Duration::from_secs(10),
        progress_interval: Duration::from_millis(10),
    }
}

pub fn derived_opts(host_code: &str) -> ConnectOptions {
    let mut o = ConnectOptions::new(host_code, "");
    o.password = PasswordInput::Derived {
        key: PW_KEY,
        kind: 0,
    };
    o.timing = fast_timing();
    o
}

// ---------------------------------------------------------------- 假被控端

pub struct TermRec {
    pub history: Vec<u8>,
    pub ring_start: u64,
    /// (会话序号, 通道号, 发送端)
    pub attached: Option<(u64, u32, FrameTx)>,
    pub exited: Option<i32>,
    pub acked: u64,
    pub size: (u32, u32),
}

impl TermRec {
    fn end(&self) -> u64 {
        self.ring_start + self.history.len() as u64
    }
}

pub struct FileRec {
    pub name: String,
    pub size: u64,
    pub data: Vec<u8>,
    pub last_ack: u64,
}

pub struct HostState {
    pub terms: HashMap<String, TermRec>,
    pub next_term: u32,
    pub next_session: u64,
    pub ring_cap: usize,
    /// 重连回放时故意从 last_seq 之前这么多字节开始（测试去重）
    pub replay_overlap: u64,
    pub answer_pings: bool,
    pub open_delay: Duration,
    pub max_file_size: u64,
    pub features: Vec<String>,
    // 文件
    pub ack_files: bool,
    pub reject_files: Option<&'static str>,
    pub files: HashMap<u64, FileRec>,
    pub finished: Vec<(String, Vec<u8>)>,
    pub done_ids: HashSet<u64>,
    pub file_bytes: u64,
    pub cancelled: Vec<u64>,
    // 记录
    pub hellos: Vec<pb::Hello>,
    pub inputs: Vec<(String, Vec<u8>)>,
    pub submits: Vec<pb::TermSubmit>,
    pub resizes: Vec<(String, u32, u32)>,
    pub attach_reqs: Vec<pb::TermAttach>,
    /// 这些终端的附着请求会被 TERM_BUSY 拒绝
    pub busy_terms: HashSet<String>,
    pub closed: Vec<String>,
    pub byes: Vec<String>,
    pub links: usize,
    pub actions: Vec<pb::TermAction>,
    /// 当前链路的控制通道发送端（手工发 FileAck 等）
    pub ctl_tx: Option<FrameTx>,
    serve: Vec<(u64, JoinHandle<()>)>,
}

#[derive(Clone)]
pub struct FakeHost {
    pub st: Arc<Mutex<HostState>>,
}

impl Default for FakeHost {
    fn default() -> Self {
        Self::new()
    }
}

fn fr(channel: u32, body: B) -> pb::Frame {
    pb::Frame {
        channel,
        body: Some(body),
    }
}

impl FakeHost {
    pub fn new() -> Self {
        FakeHost {
            st: Arc::new(Mutex::new(HostState {
                terms: HashMap::new(),
                next_term: 1,
                next_session: 1,
                ring_cap: usize::MAX,
                replay_overlap: 0,
                answer_pings: true,
                open_delay: Duration::ZERO,
                max_file_size: 200 * 1024 * 1024,
                features: vec![
                    "term.submit".into(),
                    "app.actions".into(),
                    "app.state".into(),
                    "app.commands".into(),
                    "file.upload".into(),
                ],
                ack_files: true,
                reject_files: None,
                files: HashMap::new(),
                finished: Vec::new(),
                done_ids: HashSet::new(),
                file_bytes: 0,
                cancelled: Vec::new(),
                hellos: Vec::new(),
                inputs: Vec::new(),
                submits: Vec::new(),
                resizes: Vec::new(),
                attach_reqs: Vec::new(),
                busy_terms: HashSet::new(),
                closed: Vec::new(),
                byes: Vec::new(),
                links: 0,
                actions: Vec::new(),
                ctl_tx: None,
                serve: Vec::new(),
            })),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, HostState> {
        self.st.lock().unwrap()
    }

    /// 接管一条新链路（连接器调用）。
    pub fn accept(&self, link: Link) {
        let sid = {
            let mut s = self.lock();
            s.links += 1;
            s.next_session += 1;
            s.next_session
        };
        let me = self.clone();
        let h = tokio::spawn(async move { me.serve(sid, link).await });
        self.lock().serve.push((sid, h));
    }

    /// 模拟网络断开：终止所有链路的服务任务，丢弃所有发送端。
    pub fn kill_link(&self) {
        let hs = {
            let mut s = self.lock();
            for t in s.terms.values_mut() {
                t.attached = None;
            }
            s.ctl_tx = None;
            std::mem::take(&mut s.serve)
        };
        for (_, h) in hs {
            h.abort();
        }
    }

    /// 只断开最早建立的那条链路。
    pub fn kill_first_link(&self) {
        let first = {
            let mut s = self.lock();
            if s.serve.is_empty() {
                return;
            }
            let (sid, h) = s.serve.remove(0);
            for t in s.terms.values_mut() {
                if t.attached.as_ref().is_some_and(|(x, _, _)| *x == sid) {
                    t.attached = None;
                }
            }
            h
        };
        first.abort();
    }

    /// 终端产生输出（写入历史；有人附着就发出去）。
    pub async fn emit(&self, term: &str, data: &[u8]) {
        let sink = {
            let mut s = self.lock();
            let cap = s.ring_cap;
            let Some(t) = s.terms.get_mut(term) else {
                return;
            };
            let seq = t.end();
            t.history.extend_from_slice(data);
            if t.history.len() > cap {
                let drop_n = t.history.len() - cap;
                t.history.drain(..drop_n);
                t.ring_start += drop_n as u64;
            }
            t.attached
                .as_ref()
                .map(|(_, ch, tx)| (*ch, tx.clone(), seq))
        };
        if let Some((ch, tx, seq)) = sink {
            let _ = tx
                .send(fr(
                    ch,
                    B::TermOutput(pb::TermOutput {
                        seq,
                        data: data.to_vec(),
                    }),
                ))
                .await;
        }
    }

    pub async fn exit_term(&self, term: &str, code: i32) {
        let sink = {
            let mut s = self.lock();
            let Some(t) = s.terms.get_mut(term) else {
                return;
            };
            t.exited = Some(code);
            t.attached.as_ref().map(|(_, ch, tx)| (*ch, tx.clone()))
        };
        if let Some((ch, tx)) = sink {
            let _ = tx.send(fr(ch, B::TermExit(pb::TermExit { code }))).await;
        }
    }

    /// 被控端重启：所有终端消失。
    pub fn forget_terms(&self) {
        self.lock().terms.clear();
    }

    pub fn term_end(&self, term: &str) -> u64 {
        self.lock().terms.get(term).map(|t| t.end()).unwrap_or(0)
    }

    pub async fn send_ctl(&self, body: B) {
        let tx = self.lock().ctl_tx.clone();
        if let Some(tx) = tx {
            let _ = tx.send(fr(0, body)).await;
        }
    }

    pub fn file_bytes(&self) -> u64 {
        self.lock().file_bytes
    }

    pub fn finished_file(&self, name: &str) -> Option<Vec<u8>> {
        self.lock()
            .finished
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, d)| d.clone())
    }

    async fn serve(&self, sid: u64, link: Link) {
        let Link { tx, mut rx, .. } = link;
        self.lock().ctl_tx = Some(tx.clone());
        let mut channels: HashMap<u32, String> = HashMap::new();
        let mut next_channel = 1u32;
        while let Some(f) = rx.recv().await {
            let ch = f.channel;
            let Some(body) = f.body else { continue };
            match body {
                B::Hello(h) => {
                    let (features, max) = {
                        let mut s = self.lock();
                        s.hellos.push(h);
                        (s.features.clone(), s.max_file_size)
                    };
                    let ack = pb::HelloAck {
                        proto_ver: 1,
                        app_version: "fake".into(),
                        features,
                        host: Some(pb::HostInfo {
                            platform: "windows".into(),
                            arch: "x86_64".into(),
                            hostname: "fake-host".into(),
                            username: "tester".into(),
                            home_dir: "C:/Users/tester".into(),
                            shells: vec![pb::ShellInfo {
                                id: "pwsh".into(),
                                name: "PowerShell".into(),
                                path: "pwsh".into(),
                                is_default: true,
                            }],
                            claude_available: true,
                            claude_version: "2.1.0".into(),
                            max_file_size: max,
                        }),
                    };
                    let _ = tx.send(fr(0, B::HelloAck(ack))).await;
                    let cat = pb::ActionCatalog {
                        catalog_ver: "t1".into(),
                        app: "claude".into(),
                        actions: vec![pb::ActionDef {
                            id: "model.set".into(),
                            title: "切换模型".into(),
                            ..Default::default()
                        }],
                        options: HashMap::new(),
                    };
                    let _ = tx.send(fr(0, B::ActionCatalog(cat))).await;
                }
                B::Ping(p) => {
                    if self.lock().answer_pings {
                        let _ = tx.send(fr(0, B::Pong(pb::Pong { ts: p.ts }))).await;
                    }
                }
                B::Bye(b) => {
                    self.lock().byes.push(b.reason);
                }
                B::TermOpen(o) => {
                    let delay = self.lock().open_delay;
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let (id, channel) = {
                        let mut s = self.lock();
                        let id = format!("t{}", s.next_term);
                        s.next_term += 1;
                        s.terms.insert(
                            id.clone(),
                            TermRec {
                                history: Vec::new(),
                                ring_start: 0,
                                attached: None,
                                exited: None,
                                acked: 0,
                                size: (o.cols, o.rows),
                            },
                        );
                        (id, next_channel)
                    };
                    next_channel += 1;
                    channels.insert(channel, id.clone());
                    self.attach_to(sid, &tx, &id, channel, o.req_id, 0).await;
                }
                B::TermList(_) => {
                    let terms = {
                        let s = self.lock();
                        let mut v: Vec<pb::TermInfo> = s
                            .terms
                            .iter()
                            .map(|(id, t)| pb::TermInfo {
                                term_id: id.clone(),
                                title: "fake".into(),
                                last_seq: t.end(),
                                exited: t.exited.is_some(),
                                attached: t.attached.is_some(),
                                ..Default::default()
                            })
                            .collect();
                        v.sort_by(|a, b| a.term_id.cmp(&b.term_id));
                        v
                    };
                    let _ = tx
                        .send(fr(0, B::TermListResp(pb::TermListResp { terms })))
                        .await;
                }
                B::TermAttach(a) => {
                    self.lock().attach_reqs.push(a.clone());
                    if self.lock().busy_terms.contains(&a.term_id) {
                        let e = pb::Error {
                            code: "TERM_BUSY".into(),
                            message: "busy".into(),
                            ref_id: a.req_id,
                        };
                        let _ = tx.send(fr(0, B::Error(e))).await;
                        continue;
                    }
                    let exists = self.lock().terms.contains_key(&a.term_id);
                    if !exists {
                        let e = pb::Error {
                            code: "TERM_NOT_FOUND".into(),
                            message: "no".into(),
                            ref_id: a.req_id,
                        };
                        let _ = tx.send(fr(0, B::Error(e))).await;
                        continue;
                    }
                    channels.retain(|_, t| t != &a.term_id);
                    let channel = next_channel;
                    next_channel += 1;
                    channels.insert(channel, a.term_id.clone());
                    if a.cols > 0 {
                        if let Some(t) = self.lock().terms.get_mut(&a.term_id) {
                            t.size = (a.cols, a.rows);
                        }
                    }
                    self.attach_to(sid, &tx, &a.term_id, channel, a.req_id, a.last_seq)
                        .await;
                }
                B::TermClose(c) => {
                    let mut s = self.lock();
                    s.closed.push(c.term_id.clone());
                    s.terms.remove(&c.term_id);
                }
                B::TermInput(i) => {
                    let Some(id) = channels.get(&ch).cloned() else {
                        continue;
                    };
                    self.lock().inputs.push((id.clone(), i.data.clone()));
                    // 回显
                    let mut echo = b"echo:".to_vec();
                    echo.extend_from_slice(&i.data);
                    self.emit(&id, &echo).await;
                }
                B::TermSubmit(m) => {
                    let Some(id) = channels.get(&ch).cloned() else {
                        continue;
                    };
                    let bad = {
                        let s = self.lock();
                        m.attachments.iter().any(|a| !s.done_ids.contains(a))
                    };
                    if bad {
                        let e = pb::Error {
                            code: "BAD_REQUEST".into(),
                            message: "附件未就绪".into(),
                            ref_id: m.msg_id,
                        };
                        let _ = tx.send(fr(ch, B::Error(e))).await;
                    } else {
                        let _ = id;
                        self.lock().submits.push(m);
                    }
                }
                B::TermResize(r) => {
                    if let Some(id) = channels.get(&ch).cloned() {
                        self.lock().resizes.push((id, r.cols, r.rows));
                    }
                }
                B::TermAck(a) => {
                    if let Some(id) = channels.get(&ch).cloned() {
                        if let Some(t) = self.lock().terms.get_mut(&id) {
                            t.acked = a.consumed;
                        }
                    }
                }
                B::TermAction(a) => {
                    let r = pb::TermActionResult {
                        req_id: a.req_id,
                        ok: true,
                        ..Default::default()
                    };
                    self.lock().actions.push(a);
                    let _ = tx.send(fr(ch, B::TermActionResult(r))).await;
                }
                B::CommandListReq(_) => {
                    let l = pb::CommandList {
                        commands: vec![pb::CustomCommand {
                            name: "review".into(),
                            ..Default::default()
                        }],
                    };
                    let _ = tx.send(fr(ch, B::CommandList(l))).await;
                }
                B::FileBegin(b) => {
                    let reject = self.lock().reject_files;
                    if let Some(code) = reject {
                        let e = pb::Error {
                            code: code.into(),
                            message: "rejected".into(),
                            ref_id: b.file_id,
                        };
                        let _ = tx.send(fr(0, B::Error(e))).await;
                        continue;
                    }
                    self.lock().files.insert(
                        b.file_id,
                        FileRec {
                            name: b.name,
                            size: b.size,
                            data: Vec::new(),
                            last_ack: 0,
                        },
                    );
                    let _ = tx
                        .send(fr(0, B::FileAccept(pb::FileAccept { file_id: b.file_id })))
                        .await;
                }
                B::FileChunk(c) => {
                    let (ack, err) = {
                        let mut s = self.lock();
                        let ack_files = s.ack_files;
                        let n = c.data.len() as u64;
                        let mut ack = None;
                        let mut err = None;
                        if let Some(f) = s.files.get_mut(&c.file_id) {
                            if f.data.len() as u64 != c.offset {
                                err = Some("FILE_IO");
                            } else {
                                f.data.extend_from_slice(&c.data);
                                let got = f.data.len() as u64;
                                if ack_files && got - f.last_ack >= 256 * 1024 {
                                    f.last_ack = got;
                                    ack = Some(got);
                                }
                            }
                        }
                        s.file_bytes += n;
                        (ack, err)
                    };
                    if let Some(code) = err {
                        let e = pb::Error {
                            code: code.into(),
                            message: "offset".into(),
                            ref_id: c.file_id,
                        };
                        let _ = tx.send(fr(0, B::Error(e))).await;
                    } else if let Some(got) = ack {
                        let _ = tx
                            .send(fr(
                                0,
                                B::FileAck(pb::FileAck {
                                    file_id: c.file_id,
                                    received: got,
                                }),
                            ))
                            .await;
                    }
                }
                B::FileEnd(e) => {
                    let rec = self.lock().files.remove(&e.file_id);
                    let Some(rec) = rec else { continue };
                    let digest = Sha256::digest(&rec.data).to_vec();
                    if digest != e.sha256 || rec.data.len() as u64 != rec.size {
                        let er = pb::Error {
                            code: "FILE_HASH_MISMATCH".into(),
                            message: "sha".into(),
                            ref_id: e.file_id,
                        };
                        let _ = tx.send(fr(0, B::Error(er))).await;
                    } else {
                        let path = format!("/inbox/{}", rec.name);
                        {
                            let mut s = self.lock();
                            s.done_ids.insert(e.file_id);
                            s.finished.push((rec.name, rec.data));
                        }
                        let _ = tx
                            .send(fr(
                                0,
                                B::FileDone(pb::FileDone {
                                    file_id: e.file_id,
                                    remote_path: path,
                                }),
                            ))
                            .await;
                    }
                }
                B::FileCancel(c) => {
                    let mut s = self.lock();
                    s.cancelled.push(c.file_id);
                    s.files.remove(&c.file_id);
                }
                _ => {}
            }
        }
        // 链路结束：不再向这条链路发送
        let mut s = self.lock();
        for t in s.terms.values_mut() {
            if t.attached.as_ref().is_some_and(|(x, _, _)| *x == sid) {
                t.attached = None;
            }
        }
        s.ctl_tx = None;
    }

    /// 附着：TermOpened + 回放 + TermState。与真实被控端同样的衔接规则。
    async fn attach_to(
        &self,
        sid: u64,
        tx: &FrameTx,
        term: &str,
        channel: u32,
        req_id: u64,
        last_seq: u64,
    ) {
        let (old, replay_start, data, continuous, exited) = {
            let mut s = self.lock();
            let overlap = s.replay_overlap;
            let Some(t) = s.terms.get_mut(term) else {
                return;
            };
            let old = t.attached.replace((sid, channel, tx.clone()));
            let (start, cont) = if last_seq >= t.ring_start && last_seq <= t.end() {
                (last_seq.saturating_sub(overlap).max(t.ring_start), true)
            } else {
                (t.ring_start, false)
            };
            let data = t.history[(start - t.ring_start) as usize..].to_vec();
            (old, start, data, cont, t.exited)
        };
        if let Some((osid, och, otx)) = old {
            if osid != sid {
                let e = pb::Error {
                    code: "TERM_DETACHED".into(),
                    message: term.into(),
                    ref_id: 0,
                };
                let _ = otx.send(fr(och, B::Error(e))).await;
            }
        }
        let _ = tx
            .send(fr(
                channel,
                B::TermOpened(pb::TermOpened {
                    req_id,
                    term_id: term.into(),
                    channel,
                    title: "fake".into(),
                    shell: String::new(),
                }),
            ))
            .await;
        if !continuous {
            let _ = tx
                .send(fr(
                    channel,
                    B::TermOutput(pb::TermOutput {
                        seq: replay_start.saturating_sub(2),
                        data: b"\x1bc".to_vec(),
                    }),
                ))
                .await;
        }
        let mut cursor = replay_start;
        for part in data.chunks(64 * 1024) {
            let _ = tx
                .send(fr(
                    channel,
                    B::TermOutput(pb::TermOutput {
                        seq: cursor,
                        data: part.to_vec(),
                    }),
                ))
                .await;
            cursor += part.len() as u64;
        }
        let st = pb::TermState {
            bracketed_paste: true,
            title: "fake".into(),
            ..Default::default()
        };
        let _ = tx.send(fr(channel, B::TermState(st))).await;
        if let Some(code) = exited {
            let _ = tx
                .send(fr(channel, B::TermExit(pb::TermExit { code })))
                .await;
        }
    }
}

// ---------------------------------------------------------------- 连接器

pub struct TestConnector {
    pub hosts: Mutex<HashMap<String, FakeHost>>,
    /// 逐次连接的编排：Some(Err) 返回错误，None/空 = 成功
    pub plan: Mutex<VecDeque<Option<ConnectError>>>,
    /// 设置后每次连接都返回这个错误
    pub fail_all: Mutex<Option<ConnectError>>,
    pub expected_key: Mutex<[u8; 32]>,
    pub attempts: AtomicUsize,
}

impl TestConnector {
    pub fn new(host: FakeHost) -> Arc<Self> {
        let mut m = HashMap::new();
        m.insert(HOST_CODE.to_string(), host);
        Arc::new(Self {
            hosts: Mutex::new(m),
            plan: Mutex::new(VecDeque::new()),
            fail_all: Mutex::new(None),
            expected_key: Mutex::new(PW_KEY),
            attempts: AtomicUsize::new(0),
        })
    }

    pub fn add_host(&self, code: &str, host: FakeHost) {
        self.hosts.lock().unwrap().insert(code.to_string(), host);
    }

    pub fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    pub fn plan(&self, v: Vec<Option<ConnectError>>) {
        *self.plan.lock().unwrap() = v.into();
    }
}

impl Connector for TestConnector {
    fn connect<'a>(
        &'a self,
        spec: &'a ConnectSpec,
    ) -> BoxFuture<'a, Result<Connected, ConnectError>> {
        Box::pin(async move {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            if let Some(e) = self.fail_all.lock().unwrap().clone() {
                return Err(e);
            }
            if let Some(Some(e)) = self.plan.lock().unwrap().pop_front() {
                return Err(e);
            }
            if *spec.pw_key != *self.expected_key.lock().unwrap() {
                return Err(ConnectError::Establish(
                    rterm_core::relay::EstablishError::BadPassword,
                ));
            }
            let host = self
                .hosts
                .lock()
                .unwrap()
                .get(&spec.host_code)
                .cloned()
                .ok_or(ConnectError::Signal(
                    rterm_core::signal::SignalError::Connect("UNAVAILABLE".into()),
                ))?;
            let (c, h) = loopback_pair(PeerInfo::default(), PeerInfo::default());
            host.accept(h);
            Ok(Connected {
                link: c,
                close: None,
                peer_public_key: vec![7u8; 32],
            })
        })
    }
}

// ---------------------------------------------------------------- 事件收集

pub struct Evs {
    rx: mpsc::Receiver<CoreEvent>,
    pub seen: Vec<CoreEvent>,
    pos: usize,
}

pub fn channel() -> (mpsc::Sender<CoreEvent>, Evs) {
    let (tx, rx) = mpsc::channel(4096);
    (
        tx,
        Evs {
            rx,
            seen: Vec::new(),
            pos: 0,
        },
    )
}

impl Evs {
    /// 从当前游标起等第一个满足条件的事件；游标移到它之后。5 秒超时即失败。
    pub async fn wait<T>(&mut self, mut f: impl FnMut(&CoreEvent) -> Option<T>) -> T {
        self.wait_for(Duration::from_secs(8), &mut f)
            .await
            .expect("等待事件超时")
    }

    pub async fn wait_for<T>(
        &mut self,
        within: Duration,
        f: &mut impl FnMut(&CoreEvent) -> Option<T>,
    ) -> Option<T> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            while self.pos < self.seen.len() {
                let ev = &self.seen[self.pos];
                self.pos += 1;
                if let Some(t) = f(ev) {
                    return Some(t);
                }
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Some(ev)) => self.seen.push(ev),
                _ => return None,
            }
        }
    }

    pub async fn wait_state(&mut self, want: rterm_core::events::SessionState) {
        self.wait(|e| match e {
            CoreEvent::SessionState { state, .. } if *state == want => Some(()),
            _ => None,
        })
        .await
    }

    /// 在已收到的全部事件里（不看游标）找第一个满足条件的。
    pub fn find<T>(&mut self, f: impl FnMut(&CoreEvent) -> Option<T>) -> Option<T> {
        self.pump();
        self.seen.iter().find_map(f)
    }

    /// 在已收到的全部事件里（不看游标）收集所有满足条件的。
    pub fn find_all<T>(&mut self, f: impl FnMut(&CoreEvent) -> Option<T>) -> Vec<T> {
        self.pump();
        self.seen.iter().filter_map(f).collect()
    }

    /// 取走已到达的全部事件到 `seen`（不移动游标）。
    pub fn pump(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            self.seen.push(ev);
        }
    }

    /// 等到某终端累计收到至少 `n` 字节输出，返回按到达顺序的 (seq, data)。
    pub async fn wait_output_len(&mut self, term: &str, n: usize) -> Vec<(u64, Vec<u8>)> {
        loop {
            self.pump();
            let v = self.outputs(term);
            if v.iter().map(|x| x.1.len()).sum::<usize>() >= n {
                return v;
            }
            let t = term.to_string();
            let got = self
                .wait_for(Duration::from_secs(8), &mut |e| match e {
                    CoreEvent::TermOutput { term, .. } if *term == t => Some(()),
                    _ => None,
                })
                .await;
            assert!(
                got.is_some(),
                "等待终端输出超时（已收 {} 字节，需要 {n}）",
                self.outputs(term).iter().map(|x| x.1.len()).sum::<usize>()
            );
        }
    }

    pub fn outputs(&self, term: &str) -> Vec<(u64, Vec<u8>)> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                CoreEvent::TermOutput {
                    term: t, seq, data, ..
                } if t == term => Some((*seq, data.clone())),
                _ => None,
            })
            .collect()
    }

    /// 断言输出完全连续（每段 seq 等于上一段末尾）并返回拼接结果。
    pub fn contiguous_output(&self, term: &str) -> Vec<u8> {
        let mut next = 0u64;
        let mut all = Vec::new();
        for (seq, d) in self.outputs(term) {
            assert_eq!(seq, next, "输出不连续：期望 seq={next}，实际 {seq}");
            next = seq + d.len() as u64;
            all.extend_from_slice(&d);
        }
        all
    }

    pub fn states(&self) -> Vec<rterm_core::events::SessionState> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                CoreEvent::SessionState { state, .. } => Some(state.clone()),
                _ => None,
            })
            .collect()
    }
}

/// 建立一个已连接的控制器。
pub async fn connect_one() -> (Controller, FakeHost, Arc<TestConnector>, Evs) {
    let host = FakeHost::new();
    let conn = TestConnector::new(host.clone());
    let (tx, evs) = channel();
    let c = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx)
        .await
        .expect("连接");
    (c, host, conn, evs)
}

/// 等条件成立（轮询），超时失败。
pub async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("等待条件超时: {what}");
}
