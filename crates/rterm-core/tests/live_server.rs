//! 对真实开发服务器的联调测试（默认忽略）。
//!
//! ```text
//! cd server && npm run dev:all        # 8080 信令/HTTP，8081 中继
//! RTERM_TEST_API=http://127.0.0.1:8080 cargo test -p rterm-core --test live_server -- --ignored --nocapture
//! ```
use std::sync::Arc;
use std::time::Duration;

use rterm_core::api::{bootstrap_with, resolve_signal_url, ApiClient, Bootstrap, DeviceInfo};
use rterm_core::config::ConfigStore;
use rterm_core::crypto::derive_pw_key;
use rterm_core::link::HostPasswords;
use rterm_core::netutil::NetOptions;
use rterm_core::relay::{
    establish_controller_ex, establish_host, ControllerParams, EstablishError, HostParams,
    PasswordInput,
};
use rterm_core::secrets::MemoryStore;
use rterm_core::signal::{SignalClient, SignalConfig, SignalError, SignalEvent};
use rterm_proto::pb::{frame::Body, Frame, Ping, Pong};
use tokio::sync::mpsc::Receiver;

const TEMP_PW: &str = "abc23456";

struct Pw([u8; 32]);
impl HostPasswords for Pw {
    fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
        (kind == 0).then_some(self.0)
    }
}

fn api_url() -> String {
    std::env::var("RTERM_TEST_API").unwrap_or_else(|_| "http://127.0.0.1:8080".into())
}

struct Node {
    boot: Bootstrap,
    signal: SignalClient,
    events: Receiver<SignalEvent>,
    _dir: tempfile::TempDir,
}

async fn node() -> Node {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(ConfigStore::open(dir.path().join("config.json")).unwrap());
    let info = DeviceInfo::detect("0.1.0-test", "cli");
    let boot = bootstrap_with(
        cfg,
        Arc::new(MemoryStore::default()),
        &info,
        Some(&api_url()),
    )
    .await
    .expect("注册失败：开发服务器是否已启动？");
    assert_eq!(boot.device_code.len(), 9);
    let net = NetOptions {
        proxy: Some(String::new()),
        use_system_certs: false,
    };
    let api = ApiClient::new(&api_url(), &net).unwrap();
    let sc = api.get_config().await.ok();
    let mut c = SignalConfig::new(
        resolve_signal_url(&api_url(), sc.as_ref()),
        boot.device_id.clone(),
        boot.identity.clone(),
        "0.1.0-test",
        &info.platform,
    );
    c.net = net;
    let (signal, events) = SignalClient::start(c);
    assert!(
        signal.wait_online(Duration::from_secs(10)).await,
        "信令未上线"
    );
    Node {
        boot,
        signal,
        events,
        _dir: dir,
    }
}

/// 被控端后台任务：接受并建立会话，成功后回 Pong；返回每次建立的结果。
fn spawn_host(n: &mut Node) -> tokio::sync::mpsc::UnboundedReceiver<Result<(), EstablishError>> {
    let (res_tx, res_rx) = tokio::sync::mpsc::unbounded_channel();
    let (dummy_tx, dummy_rx) = tokio::sync::mpsc::channel(1);
    drop(dummy_tx);
    let mut events = std::mem::replace(&mut n.events, dummy_rx);
    let client = n.signal.clone();
    let boot = n.boot.clone();
    tokio::spawn(async move {
        let pw: Arc<dyn HostPasswords> =
            Arc::new(Pw(derive_pw_key(TEMP_PW, &boot.device_code).expect("kdf")));
        while let Some(ev) = events.recv().await {
            let SignalEvent::Incoming(inc) = ev else {
                continue;
            };
            let (client, pw, boot, res_tx) =
                (client.clone(), pw.clone(), boot.clone(), res_tx.clone());
            tokio::spawn(async move {
                let go = client.accept(&inc.session_id).await.unwrap();
                let r = establish_host(HostParams {
                    relay_url: go.relay_url,
                    ticket: go.ticket,
                    session_id: inc.session_id.clone(),
                    identity: boot.identity.clone(),
                    host_code: boot.device_code.clone(),
                    controller_code: inc.from.device_code,
                    controller_public_key: inc.from.public_key,
                    controller_platform: inc.from.platform,
                    passwords: pw,
                    net: NetOptions::default(),
                })
                .await;
                match r {
                    Ok((mut link, _h)) => {
                        let _ = res_tx.send(Ok(()));
                        while let Some(f) = link.rx.recv().await {
                            if let Some(Body::Ping(p)) = f.body {
                                let _ = link
                                    .tx
                                    .send(Frame {
                                        channel: 0,
                                        body: Some(Body::Pong(Pong { ts: p.ts })),
                                    })
                                    .await;
                            }
                        }
                    }
                    Err(e) => {
                        if matches!(e, EstablishError::BadPassword) {
                            let _ = client
                                .session_report(
                                    &inc.session_id,
                                    "auth_failed",
                                    Some(serde_json::json!({"reason":"bad_password"})),
                                )
                                .await;
                        }
                        let _ = res_tx.send(Err(e));
                    }
                }
            });
        }
    });
    res_rx
}

async fn controller_params(
    c: &Node,
    host_code: &str,
    pw: &str,
) -> Result<ControllerParams, SignalError> {
    let ok = c.signal.connect_request(host_code).await?;
    Ok(ControllerParams {
        relay_url: ok.relay_url,
        ticket: ok.ticket,
        session_id: ok.session_id,
        identity: c.boot.identity.clone(),
        controller_code: c.boot.device_code.clone(),
        host_code: host_code.to_string(),
        host_public_key: ok.peer.public_key,
        host_platform: ok.peer.platform,
        password: PasswordInput::Plain(pw.to_string()),
        known_host_key: None,
        accept_key_change: false,
        net: NetOptions::default(),
    })
}

#[tokio::test]
#[ignore = "需要先启动开发服务器（server/ npm run dev:all）"]
async fn register_online_connect_handshake_and_data() {
    let mut host = node().await;
    let ctrl = node().await;
    let mut results = spawn_host(&mut host);

    // 第二次启动同一份配置不应再注册（设备码不变）在 api 单元测试里覆盖；这里验证端到端
    let p = controller_params(&ctrl, &host.boot.device_code, TEMP_PW)
        .await
        .unwrap();
    let (mut link, handle) = establish_controller_ex(p).await.expect("握手应成功");
    assert!(results.recv().await.unwrap().is_ok());
    assert_eq!(handle.peer_public_key, host.boot.identity.public_key());

    link.tx
        .send(Frame {
            channel: 0,
            body: Some(Body::Ping(Ping { ts: 7 })),
        })
        .await
        .unwrap();
    let f = tokio::time::timeout(Duration::from_secs(5), link.rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(f.body, Some(Body::Pong(p)) if p.ts == 7));

    // 批量块经真实中继往返（被控端不处理 FileChunk，这里只验证发送不阻塞、不断线）
    for i in 0..20 {
        link.tx
            .send_bulk(Frame {
                channel: 0,
                body: Some(Body::FileChunk(rterm_proto::pb::FileChunk {
                    file_id: 1,
                    offset: i,
                    data: vec![0u8; 32 * 1024],
                })),
            })
            .await
            .unwrap();
    }
    link.tx
        .send(Frame {
            channel: 0,
            body: Some(Body::Ping(Ping { ts: 8 })),
        })
        .await
        .unwrap();
    let f = tokio::time::timeout(Duration::from_secs(5), link.rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(f.body, Some(Body::Pong(p)) if p.ts == 8));
}

#[tokio::test]
#[ignore = "需要先启动开发服务器（server/ npm run dev:all）"]
async fn wrong_password_then_server_side_lock() {
    let mut host = node().await;
    let ctrl = node().await;
    let mut results = spawn_host(&mut host);

    for i in 0..5 {
        let p = controller_params(&ctrl, &host.boot.device_code, "abc23457")
            .await
            .unwrap();
        let c_err = establish_controller_ex(p).await.err().expect("应失败");
        assert!(
            matches!(c_err, EstablishError::BadPassword),
            "第 {i} 次主控端: {c_err:?}"
        );
        let h_err = results.recv().await.unwrap().err().unwrap();
        assert!(
            matches!(h_err, EstablishError::BadPassword),
            "被控端: {h_err:?}"
        );
    }
    // 5 次失败上报后，服务端对该被控端的新请求返回 LOCKED
    tokio::time::sleep(Duration::from_millis(300)).await;
    let e = controller_params(&ctrl, &host.boot.device_code, TEMP_PW)
        .await
        .err()
        .expect("应被锁定");
    assert_eq!(e, SignalError::Connect("LOCKED".into()), "{e:?}");
    assert_eq!(e.user_text(), "对方设备已临时锁定");
}

#[tokio::test]
#[ignore = "需要先启动开发服务器（server/ npm run dev:all）"]
async fn unknown_target_and_replaced_kick() {
    let ctrl = node().await;
    let e = ctrl.signal.connect_request("999999998").await.unwrap_err();
    assert_eq!(e, SignalError::Connect("UNAVAILABLE".into()));

    // 同一设备再开一条信令连接：旧连接收到 kick:replaced 且不会自动重连
    let mut first = node().await;
    let api = ApiClient::new(
        &api_url(),
        &NetOptions {
            proxy: Some(String::new()),
            use_system_certs: false,
        },
    )
    .unwrap();
    let mut c = SignalConfig::new(
        resolve_signal_url(&api_url(), api.get_config().await.ok().as_ref()),
        first.boot.device_id.clone(),
        first.boot.identity.clone(),
        "0.1.0-test",
        "windows",
    );
    c.net = NetOptions {
        proxy: Some(String::new()),
        use_system_certs: false,
    };
    let (second, _ev2) = SignalClient::start(c);
    assert!(second.wait_online(Duration::from_secs(10)).await);
    let mut got_kick = false;
    for _ in 0..5 {
        match tokio::time::timeout(Duration::from_secs(5), first.events.recv()).await {
            Ok(Some(SignalEvent::Kick { reason })) => {
                assert_eq!(reason, "replaced");
                got_kick = true;
                break;
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    assert!(got_kick, "旧连接应收到 kick:replaced");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!first.signal.is_online(), "被 replaced 后不应抢回连接");
    assert!(second.is_online());
}

#[tokio::test]
#[ignore = "需要先启动开发服务器；耗时约 75 秒，验证空闲会话能回应中继的 WebSocket ping"]
async fn idle_session_survives_relay_pings() {
    let mut host = node().await;
    let ctrl = node().await;
    let mut results = spawn_host(&mut host);
    let p = controller_params(&ctrl, &host.boot.device_code, TEMP_PW)
        .await
        .unwrap();
    let (mut link, _h) = establish_controller_ex(p).await.expect("握手应成功");
    assert!(results.recv().await.unwrap().is_ok());
    // 中继每 30 秒对连接发 ping，没回 pong 的会被终止；空闲 75 秒后会话必须还在
    tokio::time::sleep(Duration::from_secs(75)).await;
    link.tx
        .send(Frame {
            channel: 0,
            body: Some(Body::Ping(Ping { ts: 99 })),
        })
        .await
        .unwrap();
    let f = tokio::time::timeout(Duration::from_secs(5), link.rx.recv())
        .await
        .expect("空闲后会话应仍然可用")
        .expect("会话不应被关闭");
    assert!(matches!(f.body, Some(Body::Pong(p)) if p.ts == 99));
}

#[tokio::test]
#[ignore = "需要先启动开发服务器；被控端延迟 20 秒才确认，耗时约 25 秒"]
async fn host_accepts_after_20_seconds_still_connects() {
    let mut host = node().await;
    let ctrl = node().await;
    let host_code = host.boot.device_code.clone();
    let host_events = std::mem::replace(&mut host.events, tokio::sync::mpsc::channel(1).1);

    // 主控端：发起请求后一直等（没有请求超时）
    let handle = ctrl.signal.connect_request_ex(&host_code).await.unwrap();
    let ctrl_task = tokio::spawn({
        let ident = ctrl.boot.identity.clone();
        let code = ctrl.boot.device_code.clone();
        let hc = host_code.clone();
        async move {
            let ok = handle.result().await?;
            Ok::<_, SignalError>((establish_controller_ex(ControllerParams {
                relay_url: ok.relay_url,
                ticket: ok.ticket,
                session_id: ok.session_id,
                identity: ident,
                controller_code: code,
                host_code: hc,
                host_public_key: ok.peer.public_key,
                host_platform: ok.peer.platform,
                password: PasswordInput::Plain(TEMP_PW.into()),
                known_host_key: None,
                accept_key_change: false,
                net: NetOptions::default(),
            })
            .await,))
        }
    });

    // 被控端：收到请求后等 20 秒再确认
    let mut events = host_events;
    let inc = loop {
        match tokio::time::timeout(Duration::from_secs(10), events.recv()).await {
            Ok(Some(SignalEvent::Incoming(i))) => break i,
            Ok(Some(_)) => {}
            other => panic!("没有收到 Incoming: {other:?}"),
        }
    };
    tokio::time::sleep(Duration::from_secs(20)).await;
    let go = host
        .signal
        .accept(&inc.session_id)
        .await
        .expect("迟到的 accept 应换到 connect.go");
    let pw: Arc<dyn HostPasswords> = Arc::new(Pw(derive_pw_key(TEMP_PW, &host_code).expect("kdf")));
    let host_est = tokio::spawn(establish_host(HostParams {
        relay_url: go.relay_url,
        ticket: go.ticket,
        session_id: inc.session_id.clone(),
        identity: host.boot.identity.clone(),
        host_code: host_code.clone(),
        controller_code: inc.from.device_code,
        controller_public_key: inc.from.public_key,
        controller_platform: inc.from.platform,
        passwords: pw,
        net: NetOptions::default(),
    }));
    let (_link, _h) = ctrl_task
        .await
        .unwrap()
        .unwrap()
        .0
        .expect("主控端握手应成功");
    assert!(host_est.await.unwrap().is_ok());
}

#[tokio::test]
#[ignore = "需要先启动开发服务器"]
async fn controller_cancel_notifies_host() {
    let mut host = node().await;
    let ctrl = node().await;
    let mut events = std::mem::replace(&mut host.events, tokio::sync::mpsc::channel(1).1);

    let mut handle = ctrl
        .signal
        .connect_request_ex(&host.boot.device_code)
        .await
        .unwrap();
    let sid = tokio::time::timeout(Duration::from_secs(5), handle.wait_pending())
        .await
        .unwrap()
        .expect("服务端应回 connect.pending");
    let inc = loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(SignalEvent::Incoming(i))) => break i,
            Ok(Some(_)) => {}
            other => panic!("没有收到 Incoming: {other:?}"),
        }
    };
    assert_eq!(inc.session_id, sid);

    handle.cancel();
    assert_eq!(handle.result().await.unwrap_err(), SignalError::Cancelled);
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(SignalEvent::IncomingCancelled { session_id })) => {
                assert_eq!(session_id, sid);
                break;
            }
            Ok(Some(_)) => {}
            other => panic!("没有收到 IncomingCancelled: {other:?}"),
        }
    }
}

/// 审查 H1：服务端下发的 `/v1/config` 带签名，客户端用公钥验签通过。
/// 公钥取内置的；对本机 `dev:all`（每次启动生成临时密钥）需要设置 `RTERM_CONFIG_PUBKEY=<启动日志里的 config_pubkey>`。
#[tokio::test]
#[ignore = "需要运行中的服务端（RTERM_TEST_API）"]
async fn live_config_is_signed_and_verifies() {
    let net = NetOptions {
        proxy: Some(String::new()),
        use_system_certs: false,
    };
    let api = ApiClient::new(&api_url(), &net).expect("api");
    let sc = api.get_config().await.expect("config");
    let keys = rterm_core::config_sig::trusted_keys();
    assert!(!keys.is_empty());
    assert!(sc.config_sig.is_some(), "服务端没有下发 config_sig");
    rterm_core::config_sig::verify_server_config(&sc, &keys).expect("验签失败");
    // 篡改任何一项都应验签失败
    let mut evil = sc.clone();
    if let Some(a) = evil.adapters.first_mut() {
        a["submit_key"] = serde_json::json!("\r;calc\r");
    }
    assert!(rterm_core::config_sig::verify_server_config(&evil, &keys).is_err());
}
