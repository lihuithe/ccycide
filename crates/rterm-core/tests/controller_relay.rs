//! 主控端经过真实的加密层：进程内假中继 + 真实的 SPAKE2 握手和 AEAD 记录层（不经过信令），
//! 被控端一侧是假被控端。验证主控端和网络层的接缝：密码派生值缓存复用、密码错误的判定、重连、文件块的顺序。
mod controller_common;

use std::sync::{Arc, Mutex};

use controller_common::*;
use futures_util::future::BoxFuture;
use rterm_core::controller::{
    ConnectError, ConnectOptions, ConnectSpec, Connected, Connector, Controller, TermOpenOptions,
    TermSize, UploadSource,
};
use rterm_core::crypto::derive_pw_key;
use rterm_core::events::{CoreEvent, SessionState};
use rterm_core::identity::Identity;
use rterm_core::link::HostPasswords;
use rterm_core::mux::MuxHandle;
use rterm_core::netutil::NetOptions;
use rterm_core::relay::testing::spawn_fake_relay;
use rterm_core::relay::{
    establish_controller_ex, establish_host, ControllerParams, EstablishError, HostParams,
};
use sha2::{Digest, Sha256};

const C_CODE: &str = "111111111";
const H_CODE: &str = "222222222";

struct Pw {
    temp: Mutex<[u8; 32]>,
}

impl HostPasswords for Pw {
    fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
        (kind == 0).then(|| *self.temp.lock().unwrap())
    }
}

struct RelayConnector {
    relay: String,
    c_id: Arc<Identity>,
    h_id: Arc<Identity>,
    pw: Arc<Pw>,
    host: FakeHost,
    host_muxes: Mutex<Vec<MuxHandle>>,
    attempts: std::sync::atomic::AtomicUsize,
}

impl RelayConnector {
    async fn new(host: FakeHost) -> Arc<Self> {
        Arc::new(Self {
            relay: spawn_fake_relay().await,
            c_id: Arc::new(Identity::generate()),
            h_id: Arc::new(Identity::generate()),
            pw: Arc::new(Pw {
                temp: Mutex::new(derive_pw_key("abc23456", H_CODE).expect("kdf")),
            }),
            host,
            host_muxes: Mutex::new(Vec::new()),
            attempts: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// 模拟网络断开：被控端一侧主动中止中继连接。
    fn drop_network(&self) {
        for m in self.host_muxes.lock().unwrap().drain(..) {
            m.abort();
        }
    }
}

fn net() -> NetOptions {
    NetOptions {
        proxy: Some(String::new()),
        use_system_certs: false,
    }
}

impl Connector for RelayConnector {
    fn connect<'a>(
        &'a self,
        spec: &'a ConnectSpec,
    ) -> BoxFuture<'a, Result<Connected, ConnectError>> {
        Box::pin(async move {
            self.attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let sid = format!("S{}", rand::random::<u32>());
            let hp = HostParams {
                relay_url: self.relay.clone(),
                ticket: format!("{sid}:h"),
                session_id: sid.clone(),
                identity: self.h_id.clone(),
                host_code: H_CODE.into(),
                controller_code: C_CODE.into(),
                controller_public_key: self.c_id.public_key().to_vec(),
                controller_platform: "macos".into(),
                passwords: self.pw.clone(),
                net: net(),
            };
            let host_task = tokio::spawn(establish_host(hp));
            let cp = ControllerParams {
                relay_url: self.relay.clone(),
                ticket: format!("{sid}:c"),
                session_id: sid,
                identity: self.c_id.clone(),
                controller_code: C_CODE.into(),
                host_code: spec.host_code.clone(),
                host_public_key: self.h_id.public_key().to_vec(),
                host_platform: "windows".into(),
                password: spec.password(),
                known_host_key: spec.known_host_key.clone(),
                accept_key_change: spec.accept_key_change,
                net: net(),
            };
            let res = establish_controller_ex(cp).await;
            let host_res = host_task.await;
            let (link, handle) = res.map_err(ConnectError::Establish)?;
            if let Ok(Ok((h_link, h_handle))) = host_res {
                self.host_muxes.lock().unwrap().push(h_handle.mux);
                self.host.accept(h_link);
            }
            Ok(Connected {
                link,
                close: Some(handle.mux),
                peer_public_key: handle.peer_public_key.to_vec(),
            })
        })
    }
}

fn opts() -> ConnectOptions {
    let mut o = ConnectOptions::new(H_CODE, "abc23456");
    o.timing = fast_timing();
    o
}

#[tokio::test]
async fn real_handshake_connect_terminal_and_reconnect_with_cached_key() {
    let host = FakeHost::new();
    let conn = RelayConnector::new(host.clone()).await;
    let (tx, mut evs) = channel();
    let c = Controller::connect(conn.clone(), opts(), tx)
        .await
        .expect("连接");
    // 握手认证出的公钥交给调用方记住
    assert_eq!(c.peer_public_key(), conn.h_id.public_key().to_vec());

    let t = c
        .open_term(TermOpenOptions::shell(TermSize::new(100, 30)))
        .await
        .unwrap();
    let mut expect = Vec::new();
    for i in 0..50u8 {
        let chunk = vec![i; 3000];
        host.emit(&t, &chunk).await;
        expect.extend_from_slice(&chunk);
    }
    evs.wait_output_len(&t, expect.len()).await;

    // 网络断开，断开期间被控端继续产生输出
    conn.drop_network();
    host.kill_link();
    host.emit(&t, b"while-away").await;
    expect.extend_from_slice(b"while-away");
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    evs.wait_output_len(&t, expect.len()).await;
    assert_eq!(evs.contiguous_output(&t), expect);
    assert!(conn.attempts.load(std::sync::atomic::Ordering::SeqCst) >= 2);

    c.term_input(&t, b"hi".to_vec()).await.unwrap();
    eventually("输入经加密通道到达", || {
        host.lock().inputs.iter().any(|i| i.1 == b"hi")
    })
    .await;
}

#[tokio::test]
async fn real_handshake_wrong_password_is_bad_password() {
    let host = FakeHost::new();
    let conn = RelayConnector::new(host).await;
    let (tx, mut evs) = channel();
    let mut o = opts();
    o.password = rterm_core::relay::PasswordInput::Plain("zzzzzzzz".into());
    let err = Controller::connect(conn.clone(), o, tx)
        .await
        .expect_err("应当失败");
    assert!(
        matches!(err, ConnectError::Establish(EstablishError::BadPassword)),
        "{err:?}"
    );
    evs.wait_state(SessionState::Closed("密码错误".into()))
        .await;
    assert_eq!(conn.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn real_handshake_password_changed_while_away_stops_retrying() {
    let host = FakeHost::new();
    let conn = RelayConnector::new(host.clone()).await;
    let (tx, mut evs) = channel();
    let c = Controller::connect(conn.clone(), opts(), tx)
        .await
        .expect("连接");
    // 被控端改了密码
    *conn.pw.temp.lock().unwrap() = derive_pw_key("newpass9", H_CODE).expect("kdf");
    conn.drop_network();
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Closed("密码错误".into()))
        .await;
    let n = conn.attempts.load(std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        conn.attempts.load(std::sync::atomic::Ordering::SeqCst),
        n,
        "密码错误后不再重试"
    );
    assert!(matches!(
        c.close_reason(),
        Some(rterm_core::controller::CloseReason::BadPassword)
    ));
}

#[tokio::test]
async fn upload_through_real_mux_keeps_chunk_order_and_hash() {
    let host = FakeHost::new();
    let conn = RelayConnector::new(host.clone()).await;
    let (tx, mut evs) = channel();
    let c = Controller::connect(conn, opts(), tx).await.expect("连接");
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();

    // 上传的同时终端输出照常到达（文件块走批量队列，不压住交互队列）
    let data: Vec<u8> = (0..6 * 1024 * 1024u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
        .collect();
    let id = c
        .upload(UploadSource::Bytes {
            name: "mux.bin".into(),
            mime: String::new(),
            data: data.clone(),
        })
        .await
        .unwrap();
    for i in 0..20u8 {
        c.term_input(&t, vec![b'a' + i]).await.unwrap();
    }
    evs.wait(|e| match e {
        CoreEvent::UploadDone { file, .. } if *file == id => Some(()),
        CoreEvent::UploadFailed { file, reason, .. } if *file == id => panic!("上传失败: {reason}"),
        _ => None,
    })
    .await;
    let got = host.finished_file("mux.bin").unwrap();
    assert_eq!(Sha256::digest(&got), Sha256::digest(&data));
    evs.wait_output_len(&t, 20 * 6).await; // 20 次 "echo:x"
}
