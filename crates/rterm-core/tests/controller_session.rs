//! 主控端会话：连接、终端代理、重连续传、密码错误、多会话路由。用进程内假被控端，不经过网络。
mod controller_common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use controller_common::*;
use rterm_core::controller::{
    CloseReason, ConnectError, ConnectOptions, Controller, ControllerManager, CtlError,
    TermOpenOptions, TermSize,
};
use rterm_core::crypto::derive_pw_key;
use rterm_core::events::{CoreEvent, SessionState};
use rterm_core::relay::{EstablishError, PasswordInput};
use rterm_core::signal::SignalError;

#[tokio::test]
async fn connect_emits_state_hostinfo_catalog() {
    let (c, _host, conn, mut evs) = connect_one().await;
    assert_eq!(c.state(), SessionState::Ready);
    assert_eq!(conn.attempts(), 1);

    evs.wait_state(SessionState::Connecting).await;
    let info = evs
        .wait(|e| match e {
            CoreEvent::HostInfo { info, .. } => Some(info.clone()),
            _ => None,
        })
        .await;
    assert_eq!(info.hostname, "fake-host");
    evs.wait_state(SessionState::Ready).await;
    let cat = evs
        .wait(|e| match e {
            CoreEvent::ActionCatalog { catalog, .. } => Some(catalog.clone()),
            _ => None,
        })
        .await;
    assert_eq!(cat.actions.len(), 1);
    assert_eq!(cat.actions[0].id, "model.set");

    let h = c.host().expect("host snapshot");
    assert!(h.features.contains("file.upload"));
    assert_eq!(c.peer_public_key(), vec![7u8; 32]);
}

#[tokio::test]
async fn hello_advertises_features() {
    let (_c, host, _conn, _evs) = connect_one().await;
    let h = host.lock().hellos[0].clone();
    for f in [
        "file.upload",
        "term.submit",
        "app.actions",
        "app.state",
        "app.commands",
    ] {
        assert!(h.features.iter().any(|x| x == f), "缺少 {f}");
    }
    assert_eq!(h.proto_ver, 1);
}

#[tokio::test]
async fn plain_password_is_derived_once_and_checked() {
    let host = FakeHost::new();
    let conn = TestConnector::new(host);
    *conn.expected_key.lock().unwrap() = derive_pw_key("abc23456", HOST_CODE).expect("kdf");
    let (tx, _evs) = channel();
    let mut o = ConnectOptions::new(HOST_CODE, "abc23456");
    o.timing = fast_timing();
    let c = Controller::connect(conn.clone(), o, tx)
        .await
        .expect("正确的明文密码应当连上");
    assert_eq!(c.state(), SessionState::Ready);

    // 错误的明文密码：首次连接直接失败，不重试
    let (tx2, mut evs2) = channel();
    let mut o2 = ConnectOptions::new(HOST_CODE, "zzzzzzzz");
    o2.timing = fast_timing();
    let before = conn.attempts();
    let err = Controller::connect(conn.clone(), o2, tx2)
        .await
        .expect_err("应当失败");
    assert!(err.is_bad_password());
    assert_eq!(conn.attempts(), before + 1);
    let last = evs2
        .wait(|e| match e {
            CoreEvent::SessionState {
                state: SessionState::Closed(r),
                ..
            } => Some(r.clone()),
            _ => None,
        })
        .await;
    assert_eq!(last, "密码错误");
}

#[tokio::test]
async fn initial_failure_is_not_retried() {
    let host = FakeHost::new();
    let conn = TestConnector::new(host);
    *conn.fail_all.lock().unwrap() = Some(ConnectError::Signal(SignalError::Connect(
        "UNAVAILABLE".into(),
    )));
    let (tx, mut evs) = channel();
    let err = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx)
        .await
        .expect_err("应当失败");
    assert!(err.is_retryable());
    assert_eq!(conn.attempts(), 1);
    assert_eq!(err.user_text(), "设备不在线或设备码有误");
    evs.wait_state(SessionState::Connecting).await;
    evs.wait_state(SessionState::Closed("设备不在线或设备码有误".into()))
        .await;
}

#[tokio::test]
async fn open_term_receives_output_and_input_roundtrip() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::new(100, 30)))
        .await
        .expect("open");
    assert_eq!(t, "t1");
    host.emit(&t, b"hello ").await;
    host.emit(&t, b"world").await;
    evs.wait_output_len(&t, 11).await;
    assert_eq!(evs.contiguous_output(&t), b"hello world");

    // 模式事件
    let modes = evs
        .find(|e| match e {
            CoreEvent::TermState { state, .. } => Some(state.clone()),
            _ => None,
        })
        .expect("TermState");
    assert!(modes.bracketed_paste);
    assert_eq!(modes.title, "fake");

    c.term_input(&t, b"ls\r".to_vec()).await.expect("input");
    evs.wait_output_len(&t, 11 + 5 + 3).await;
    assert_eq!(evs.contiguous_output(&t), b"hello worldecho:ls\r");
    assert_eq!(host.lock().inputs[0].1, b"ls\r");

    c.term_resize(&t, TermSize::new(120, 40))
        .await
        .expect("resize");
    eventually("resize 到达", || {
        host.lock().resizes.iter().any(|r| r.1 == 120 && r.2 == 40)
    })
    .await;

    host.exit_term(&t, 3).await;
    let code = evs
        .wait(|e| match e {
            CoreEvent::TermExit { code, .. } => Some(*code),
            _ => None,
        })
        .await;
    assert_eq!(code, 3);

    c.close_term(&t).await.expect("close");
    eventually("TermClose 到达", || host.lock().closed == vec![t.clone()]).await;
    assert!(matches!(
        c.term_input(&t, vec![1]).await,
        Err(CtlError::NoSuchTerm(_))
    ));
}

#[tokio::test]
async fn open_term_carries_launch_options_and_profile() {
    let (c, host, _conn, _evs) = connect_one().await;
    let launch = rterm_proto::pb::LaunchOptions {
        model: "opus".into(),
        resume: "continue".into(),
        ..Default::default()
    };
    // 假被控端不保留 TermOpen，这里只验证调用成功、携带路径不会出错
    let t = c
        .open_term(TermOpenOptions::claude(
            TermSize::default(),
            "C:/work",
            launch,
        ))
        .await
        .expect("open claude");
    assert!(host.lock().terms.contains_key(&t));
}

#[tokio::test]
async fn submit_action_and_command_list() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    let id = c
        .term_submit(&t, "你好 \u{fffc}".into(), vec![])
        .await
        .expect("submit");
    assert_eq!(id, 1);
    eventually("submit 到达", || host.lock().submits.len() == 1).await;
    let s = host.lock().submits[0].clone();
    assert_eq!(s.text, "你好 \u{fffc}");
    assert!(s.press_enter);

    // 附件没有上传过：本地直接拒绝
    assert!(matches!(
        c.term_submit(&t, "x".into(), vec![42]).await,
        Err(CtlError::AttachmentNotReady(42))
    ));

    let mut args = HashMap::new();
    args.insert("model".to_string(), "opus".to_string());
    let req = c.term_action(&t, "model.set", args).await.expect("action");
    let res = evs
        .wait(|e| match e {
            CoreEvent::ActionResult { result, .. } => Some(result.clone()),
            _ => None,
        })
        .await;
    assert_eq!(res.req_id, req);
    assert!(res.ok);
    assert_eq!(
        host.lock().actions[0].args.get("model").map(|s| s.as_str()),
        Some("opus")
    );

    c.command_list_req(&t).await.unwrap();
    let list = evs
        .wait(|e| match e {
            CoreEvent::CommandList { list, .. } => Some(list.clone()),
            _ => None,
        })
        .await;
    assert_eq!(list.commands[0].name, "review");
}

#[tokio::test]
async fn term_ack_is_clamped_monotonic_and_forwarded() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    host.emit(&t, &[b'x'; 1000]).await;
    evs.wait_output_len(&t, 1000).await;

    c.term_ack(&t, 400);
    eventually("ack 400", || host.lock().terms[&t].acked == 400).await;
    // 回退的确认不会发出
    c.term_ack(&t, 300);
    // 超出已收到的偏移被截到 1000
    c.term_ack(&t, 5000);
    eventually("ack 1000", || host.lock().terms[&t].acked == 1000).await;
}

#[tokio::test]
async fn reconnect_resumes_without_duplicates_or_gaps() {
    let (c, host, conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::new(90, 25)))
        .await
        .unwrap();

    // 连着时的输出
    let mut expect = Vec::new();
    for i in 0..20u8 {
        let chunk = vec![b'a' + (i % 26); 1000];
        host.emit(&t, &chunk).await;
        expect.extend_from_slice(&chunk);
    }
    evs.wait_output_len(&t, expect.len()).await;

    // 断线；被控端在断开期间继续产生输出
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;
    assert_eq!(c.state(), SessionState::Reconnecting);
    for i in 0..30u8 {
        let chunk = vec![b'A' + (i % 26); 777];
        host.emit(&t, &chunk).await;
        expect.extend_from_slice(&chunk);
    }
    // 重连成功
    evs.wait_state(SessionState::Ready).await;
    assert!(conn.attempts() >= 2);

    // 续传：总输出等于被控端的全部历史，无重复无缺失
    evs.wait_output_len(&t, expect.len()).await;
    assert_eq!(evs.contiguous_output(&t), expect);

    // 附着请求带着 last_seq 和尺寸
    let req = host.lock().attach_reqs.last().cloned().unwrap();
    assert_eq!(req.term_id, t);
    assert_eq!(req.last_seq, 20 * 1000);
    assert_eq!((req.cols, req.rows), (90, 25));
    // 重连后再来的实时输出继续接上
    host.emit(&t, b"LIVE").await;
    evs.wait_output_len(&t, expect.len() + 4).await;
    expect.extend_from_slice(b"LIVE");
    assert_eq!(evs.contiguous_output(&t), expect);

    // 重连后输入可用
    c.term_input(&t, b"x".to_vec())
        .await
        .expect("input after reconnect");
    // 状态序列
    let st = evs.states();
    assert_eq!(
        st,
        vec![
            SessionState::Connecting,
            SessionState::Ready,
            SessionState::Reconnecting,
            SessionState::Ready
        ]
    );
}

#[tokio::test]
async fn reconnect_overlapping_replay_is_trimmed() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    let mut expect = Vec::new();
    for i in 0..10u8 {
        let chunk = vec![b'0' + i; 500];
        host.emit(&t, &chunk).await;
        expect.extend_from_slice(&chunk);
    }
    evs.wait_output_len(&t, expect.len()).await;
    // 被控端回放时从 last_seq 之前 1234 字节开始，控制端必须按 seq 裁掉重叠
    host.lock().replay_overlap = 1234;
    host.kill_link();
    host.emit(&t, b"tail").await;
    expect.extend_from_slice(b"tail");
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    evs.wait_output_len(&t, expect.len()).await;
    assert_eq!(evs.contiguous_output(&t), expect);
}

#[tokio::test]
async fn reconnect_with_overwritten_ring_gets_reset_then_continues() {
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().ring_cap = 1000;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    host.emit(&t, &[b'a'; 500]).await;
    evs.wait_output_len(&t, 500).await;
    host.kill_link();
    // 断开期间输出 3000 字节，环形缓冲只留最近 1000 字节
    host.emit(&t, &[b'b'; 3000]).await;
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    // 先是复位序列，再是最近 1000 字节；之后偏移继续对齐
    evs.wait_output_len(&t, 500 + 2 + 1000).await;
    let outs = evs.outputs(&t);
    assert_eq!(outs[1].1, b"\x1bc");
    assert_eq!(outs[1].0, 2500 - 2, "复位帧的 seq 为回放起点减 2");
    assert_eq!(outs[2].0, 2500);
    host.emit(&t, b"Z").await;
    evs.wait_output_len(&t, 500 + 2 + 1000 + 1).await;
    let last = evs.outputs(&t).pop().unwrap();
    assert_eq!(last.0, 3500);
}

#[tokio::test]
async fn reconnect_edge_reset_frame_straddling_received_is_not_corrupted() {
    // received = ring_start - 1：复位帧 seq = ring_start - 2 < received，不能被裁成 "c"
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().ring_cap = 100;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    host.emit(&t, &[b'a'; 50]).await;
    evs.wait_output_len(&t, 50).await;
    host.kill_link();
    host.emit(&t, &[b'b'; 101]).await; // 总 151，ring_start = 51
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    evs.wait_output_len(&t, 50 + 2 + 100).await;
    let outs = evs.outputs(&t);
    assert_eq!(outs[1].1, b"\x1bc", "复位序列必须完整");
}

#[tokio::test]
async fn input_while_reconnecting_returns_not_connected() {
    let (c, host, conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    // 重连一直失败（可重试），固定在 Reconnecting
    *conn.fail_all.lock().unwrap() = Some(ConnectError::Signal(SignalError::Offline));
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;

    assert!(matches!(
        c.term_input(&t, b"x".to_vec()).await,
        Err(CtlError::NotConnected)
    ));
    assert!(matches!(
        c.term_submit(&t, "hi".into(), vec![]).await,
        Err(CtlError::NotConnected)
    ));
    assert!(matches!(
        c.open_term(TermOpenOptions::default()).await,
        Err(CtlError::NotConnected)
    ));
    assert!(matches!(c.list_terms().await, Err(CtlError::NotConnected)));
    // 尺寸只记录
    c.term_resize(&t, TermSize::new(77, 33))
        .await
        .expect("离线 resize 只记录");

    // 多次重试（退避 30,60,120,200,200…ms）
    eventually("至少重试 4 次", || conn.attempts() >= 5).await;
    assert_eq!(c.state(), SessionState::Reconnecting);

    // 恢复后自动回到 Ready，附着带着离线时记录的尺寸
    *conn.fail_all.lock().unwrap() = None;
    evs.wait_state(SessionState::Ready).await;
    let req = host.lock().attach_reqs.last().cloned().unwrap();
    assert_eq!((req.cols, req.rows), (77, 33));
    c.term_input(&t, b"y".to_vec()).await.expect("恢复后可输入");
}

#[tokio::test]
async fn retryable_errors_keep_retrying_then_succeed() {
    let (c, host, conn, mut evs) = connect_one().await;
    conn.plan(vec![
        Some(ConnectError::Signal(SignalError::Connect(
            "UNAVAILABLE".into(),
        ))),
        Some(ConnectError::Establish(EstablishError::Connect(
            "net".into(),
        ))),
        Some(ConnectError::Establish(EstablishError::RelayClosed {
            code: Some(4003),
        })),
        Some(ConnectError::HelloTimeout),
        None,
    ]);
    let before = conn.attempts();
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    assert_eq!(conn.attempts() - before, 5);
    assert_eq!(c.state(), SessionState::Ready);
}

#[tokio::test]
async fn reconnect_bad_password_stops_and_closes() {
    let (c, host, conn, mut evs) = connect_one().await;
    // 被控端换了密码
    *conn.expected_key.lock().unwrap() = [9u8; 32];
    let before = conn.attempts();
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Closed("密码错误".into()))
        .await;
    assert_eq!(c.close_reason(), Some(CloseReason::BadPassword));
    // 只尝试了一次，不会无限重试
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(conn.attempts() - before, 1);
    assert!(matches!(
        c.term_input("t1", vec![]).await,
        Err(CtlError::Closed)
    ));
}

#[tokio::test]
async fn reconnect_fatal_signal_errors_stop() {
    for code in ["REJECTED", "LOCKED", "VERSION", "BANNED"] {
        let (c, host, conn, mut evs) = connect_one().await;
        *conn.fail_all.lock().unwrap() =
            Some(ConnectError::Signal(SignalError::Connect(code.into())));
        let before = conn.attempts();
        host.kill_link();
        let reason = evs
            .wait(|e| match e {
                CoreEvent::SessionState {
                    state: SessionState::Closed(r),
                    ..
                } => Some(r.clone()),
                _ => None,
            })
            .await;
        assert!(!reason.is_empty(), "{code}");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(conn.attempts() - before, 1, "{code} 不应重试");
        assert!(matches!(c.close_reason(), Some(CloseReason::Refused(_))));
    }
}

#[tokio::test]
async fn host_bye_closes_without_reconnect() {
    let (c, host, conn, mut evs) = connect_one().await;
    host.send_ctl(rterm_proto::pb::frame::Body::Bye(rterm_proto::pb::Bye {
        reason: "kicked".into(),
    }))
    .await;
    let r = evs
        .wait(|e| match e {
            CoreEvent::SessionState {
                state: SessionState::Closed(r),
                ..
            } => Some(r.clone()),
            _ => None,
        })
        .await;
    assert!(r.contains("kicked"), "{r}");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(conn.attempts(), 1);
    assert!(matches!(c.close_reason(), Some(CloseReason::HostBye(_))));
}

#[tokio::test]
async fn user_disconnect_sends_bye_and_closes() {
    let (c, host, conn, mut evs) = connect_one().await;
    c.disconnect().await;
    assert_eq!(c.state(), SessionState::Closed("用户断开".into()));
    evs.wait_state(SessionState::Closed("用户断开".into()))
        .await;
    eventually("被控端收到 Bye", || {
        host.lock().byes == vec!["user".to_string()]
    })
    .await;
    assert_eq!(conn.attempts(), 1);
    assert!(matches!(
        c.open_term(TermOpenOptions::default()).await,
        Err(CtlError::Closed)
    ));
}

#[tokio::test]
async fn disconnect_while_reconnecting() {
    let (c, host, conn, mut evs) = connect_one().await;
    *conn.fail_all.lock().unwrap() = Some(ConnectError::Signal(SignalError::Offline));
    host.kill_link();
    evs.wait_state(SessionState::Reconnecting).await;
    c.disconnect().await;
    assert_eq!(c.state(), SessionState::Closed("用户断开".into()));
    let a = conn.attempts();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(conn.attempts(), a, "断开后不再重试");
}

#[tokio::test]
async fn dropping_all_handles_closes_session() {
    let (c, host, _conn, mut evs) = connect_one().await;
    drop(c);
    evs.wait(|e| match e {
        CoreEvent::SessionState {
            state: SessionState::Closed(_),
            ..
        } => Some(()),
        _ => None,
    })
    .await;
    eventually("被控端收到 Bye", || !host.lock().byes.is_empty()).await;
}

#[tokio::test]
async fn idle_timeout_triggers_reconnect() {
    let host = FakeHost::new();
    host.lock().answer_pings = false;
    let conn = TestConnector::new(host.clone());
    let (tx, mut evs) = channel();
    let mut o = derived_opts(HOST_CODE);
    o.timing.ping_interval = Duration::from_millis(60);
    o.timing.idle_timeout = Duration::from_millis(250);
    let _c = Controller::connect(conn.clone(), o, tx).await.unwrap();
    // 被控端不回 Pong：判定超时 -> 重连
    evs.wait_state(SessionState::Reconnecting).await;
    host.lock().answer_pings = true;
    evs.wait_state(SessionState::Ready).await;
    assert!(conn.attempts() >= 2);
}

#[tokio::test]
async fn resync_reports_terminals_that_vanished() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t1 = c.open_term(TermOpenOptions::default()).await.unwrap();
    let t2 = c.open_term(TermOpenOptions::default()).await.unwrap();
    host.emit(&t1, b"one").await;
    evs.wait_output_len(&t1, 3).await;
    host.kill_link();
    // 被控端重启，只剩一个新终端；t1 t2 都没了
    host.forget_terms();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    let mut exited = evs.find_all(|e| match e {
        CoreEvent::TermExit { term, code, .. } => Some((term.clone(), *code)),
        _ => None,
    });
    exited.sort();
    assert_eq!(exited, vec![(t1.clone(), -1), (t2.clone(), -1)]);
    let n = evs
        .find(|e| match e {
            CoreEvent::AppNotice { notice, .. } if notice.kind == "error" => {
                Some(notice.title.clone())
            }
            _ => None,
        })
        .expect("error notice");
    assert_eq!(n, "TERM_NOT_FOUND");
    assert!(matches!(
        c.term_input(&t1, vec![1]).await,
        Err(CtlError::NoSuchTerm(_))
    ));
}

#[tokio::test]
async fn list_and_attach_existing_terminal() {
    let (c, host, conn, _evs) = connect_one().await;
    // 另一个控制器先打开终端并产生输出
    let (tx_a, mut evs_a) = channel();
    let a = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx_a)
        .await
        .unwrap();
    let t = a.open_term(TermOpenOptions::default()).await.unwrap();
    host.emit(&t, b"history-data").await;
    evs_a.wait_output_len(&t, 12).await;

    // c 列出并附着：从 0 回放全部历史
    let (tx_b, mut evs_b) = channel();
    let b = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx_b)
        .await
        .unwrap();
    let list = b.list_terms().await.unwrap();
    assert!(list.iter().any(|x| x.term_id == t));
    b.attach_term(&t, TermSize::new(80, 24)).await.unwrap();
    evs_b.wait_output_len(&t, 12).await;
    assert_eq!(evs_b.contiguous_output(&t), b"history-data");
    drop(c);
}

#[tokio::test]
async fn attach_unknown_terminal_reports_remote_error() {
    let (c, _host, _conn, _evs) = connect_one().await;
    match c.attach_term("nope", TermSize::default()).await {
        Err(CtlError::Remote { code, .. }) => assert_eq!(code, "TERM_NOT_FOUND"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn open_term_timeout_does_not_leave_orphan_terminal() {
    let host = FakeHost::new();
    host.lock().open_delay = Duration::from_millis(400);
    let conn = TestConnector::new(host.clone());
    let (tx, _evs) = channel();
    let mut o = derived_opts(HOST_CODE);
    o.timing.request_timeout = Duration::from_millis(100);
    let c = Controller::connect(conn, o, tx).await.unwrap();
    assert!(matches!(
        c.open_term(TermOpenOptions::default()).await,
        Err(CtlError::Timeout)
    ));
    // 被控端迟到的 TermOpened 到达后，控制端要把这个孤儿终端关掉
    eventually("孤儿终端被关闭", || {
        host.lock().closed == vec!["t1".to_string()]
    })
    .await;
}

#[tokio::test]
async fn taken_over_terminal_is_not_reattached_after_reconnect() {
    let (c, host, conn, mut evs) = connect_one().await;
    let t = c.open_term(TermOpenOptions::default()).await.unwrap();
    // 另一个会话接管
    let (tx2, mut evs2) = channel();
    let other = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx2)
        .await
        .unwrap();
    other.attach_term(&t, TermSize::default()).await.unwrap();
    let title = evs
        .wait(|e| match e {
            CoreEvent::AppNotice { notice, .. } if notice.title == "TERM_DETACHED" => {
                Some(notice.text.clone())
            }
            _ => None,
        })
        .await;
    assert!(title.contains("别处"));
    let _ = &mut evs2;
    // 被接管的终端不能再输入
    assert!(matches!(
        c.term_input(&t, vec![1]).await,
        Err(CtlError::TermNotAttached(_))
    ));

    // c 重连后不会把终端抢回来
    let n_before = host.lock().attach_reqs.len();
    host.kill_first_link();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    assert_eq!(
        host.lock().attach_reqs.len(),
        n_before,
        "被接管的终端不应自动重新附着"
    );
    assert!(matches!(
        c.term_input(&t, vec![1]).await,
        Err(CtlError::TermNotAttached(_))
    ));
    // 用户明确要求时可以重新附着
    c.attach_term(&t, TermSize::default())
        .await
        .expect("手动重新附着");
    c.term_input(&t, vec![b'z']).await.expect("附着后可输入");
}

#[tokio::test]
async fn manager_routes_by_session_id() {
    let h1 = FakeHost::new();
    let h2 = FakeHost::new();
    let conn = TestConnector::new(h1.clone());
    conn.add_host("222222222", h2.clone());
    let (tx, mut evs) = channel();
    let mgr = ControllerManager::new(conn.clone(), tx, "test", fast_timing());

    let pw = PasswordInput::Derived {
        key: PW_KEY,
        kind: 0,
    };
    let s1 = mgr
        .connect_with(rterm_core::controller::ConnectRequest {
            host_code: HOST_CODE.into(),
            password: pw,
            known_host_key: None,
            accept_key_change: false,
        })
        .await
        .unwrap();
    let s2 = mgr
        .connect_with(rterm_core::controller::ConnectRequest {
            host_code: "222222222".into(),
            password: PasswordInput::Derived {
                key: PW_KEY,
                kind: 0,
            },
            known_host_key: None,
            accept_key_change: false,
        })
        .await
        .unwrap();
    assert_ne!(s1, s2);
    assert_eq!(mgr.sessions().len(), 2);

    let t1 = mgr
        .open_term(&s1, TermOpenOptions::default())
        .await
        .unwrap();
    let t2 = mgr
        .open_term(&s2, TermOpenOptions::default())
        .await
        .unwrap();
    h1.emit(&t1, b"from-one").await;
    h2.emit(&t2, b"from-two!").await;

    // 事件带着各自的 SessionId
    let mut got1 = Vec::new();
    let mut got2 = Vec::new();
    while got1.len() < 8 || got2.len() < 9 {
        let (s, d) = evs
            .wait(|e| match e {
                CoreEvent::TermOutput { session, data, .. } => {
                    Some((session.clone(), data.clone()))
                }
                _ => None,
            })
            .await;
        if s == s1 {
            got1.extend(d);
        } else if s == s2 {
            got2.extend(d);
        } else {
            panic!("未知会话 {s}");
        }
    }
    assert_eq!(got1, b"from-one");
    assert_eq!(got2, b"from-two!");

    // 输入路由到对应被控端
    mgr.term_input(&s1, &t1, b"A".to_vec()).await.unwrap();
    mgr.term_input(&s2, &t2, b"B".to_vec()).await.unwrap();
    eventually("两台各自收到输入", || {
        h1.lock().inputs.iter().any(|i| i.1 == b"A") && h2.lock().inputs.iter().any(|i| i.1 == b"B")
    })
    .await;
    assert!(h1.lock().inputs.iter().all(|i| i.1 != b"B"));
    assert!(h2.lock().inputs.iter().all(|i| i.1 != b"A"));

    // 会话 s2 的终端 id 在 s1 里不存在
    assert!(matches!(
        mgr.term_input(&s1, "t99", vec![]).await,
        Err(CtlError::NoSuchTerm(_))
    ));
    assert!(matches!(
        mgr.term_input("nope", &t1, vec![]).await,
        Err(CtlError::NoSuchSession(_))
    ));

    // 断开一个不影响另一个
    mgr.disconnect(&s1).await;
    assert!(matches!(mgr.get(&s1), Err(CtlError::NoSuchSession(_))));
    mgr.term_input(&s2, &t2, b"C".to_vec()).await.unwrap();
    assert_eq!(mgr.sessions(), vec![s2.clone()]);

    // 重连也是各自独立的
    h2.kill_link();
    let mut states = Vec::new();
    while !states.contains(&SessionState::Ready) || states.len() < 2 {
        let (s, st) = evs
            .wait(|e| match e {
                CoreEvent::SessionState { session, state }
                    if *session == s2 && *state != SessionState::Closed("用户断开".into()) =>
                {
                    Some((session.clone(), state.clone()))
                }
                _ => None,
            })
            .await;
        assert_eq!(s, s2);
        if matches!(st, SessionState::Reconnecting) {
            states.push(st);
        } else if matches!(st, SessionState::Ready) && !states.is_empty() {
            states.push(st);
            break;
        }
    }
    assert_eq!(
        states,
        vec![SessionState::Reconnecting, SessionState::Ready]
    );
}

#[tokio::test]
async fn manager_connect_failure_is_not_registered() {
    let host = FakeHost::new();
    let conn = TestConnector::new(host);
    *conn.expected_key.lock().unwrap() = [5u8; 32];
    let (tx, _evs) = channel();
    let mgr = Arc::new(ControllerManager::new(conn, tx, "test", fast_timing()));
    let err = mgr
        .connect_with(rterm_core::controller::ConnectRequest {
            host_code: HOST_CODE.into(),
            password: PasswordInput::Derived {
                key: PW_KEY,
                kind: 0,
            },
            known_host_key: None,
            accept_key_change: false,
        })
        .await
        .expect_err("失败");
    assert!(err.is_bad_password());
    assert!(mgr.sessions().is_empty());
}

#[tokio::test]
async fn known_key_change_is_reported_not_retried() {
    let host = FakeHost::new();
    let conn = TestConnector::new(host);
    conn.plan(vec![Some(ConnectError::Establish(
        EstablishError::PeerKeyChanged {
            known: vec![1; 32],
            actual: vec![2; 32],
        },
    ))]);
    let (tx, _evs) = channel();
    let err = Controller::connect(conn, derived_opts(HOST_CODE), tx)
        .await
        .unwrap_err();
    assert!(!err.is_retryable());
    assert!(matches!(
        err,
        ConnectError::Establish(EstablishError::PeerKeyChanged { .. })
    ));
}

#[tokio::test]
async fn attach_busy_terminal_is_rejected_with_notice_and_not_retried() {
    let (c, host, conn, _evs) = connect_one().await;
    // 另一个设备打开终端，并且被控端对它的附着回 TERM_BUSY
    let (tx_a, _evs_a) = channel();
    let a = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx_a)
        .await
        .unwrap();
    let t = a.open_term(TermOpenOptions::default()).await.unwrap();
    host.lock().busy_terms.insert(t.clone());

    let (tx_b, mut evs_b) = channel();
    let b = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx_b)
        .await
        .unwrap();
    match b.attach_term(&t, TermSize::default()).await {
        Err(CtlError::Remote { code, .. }) => assert_eq!(code, "TERM_BUSY"),
        other => panic!("{other:?}"),
    }
    let notice = evs_b
        .wait(|e| match e {
            CoreEvent::AppNotice { term, notice, .. } if notice.title == "TERM_BUSY" => {
                Some((term.clone(), notice.kind.clone(), notice.text.clone()))
            }
            _ => None,
        })
        .await;
    assert_eq!(
        notice,
        (t.clone(), "error".into(), "该终端正被其他设备使用".into())
    );
    // 不重试、不抢占
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(host.lock().attach_reqs.len(), 1);
    assert_eq!(b.state(), SessionState::Ready);
    // 与 TERM_NOT_FOUND 区分
    assert!(evs_b
        .find(|e| match e {
            CoreEvent::AppNotice { notice, .. } if notice.title == "TERM_NOT_FOUND" => Some(()),
            _ => None,
        })
        .is_none());
    drop(c);
}

#[tokio::test]
async fn reconnect_with_some_terminals_busy_resumes_the_rest() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t1 = c.open_term(TermOpenOptions::default()).await.unwrap();
    let t2 = c.open_term(TermOpenOptions::default()).await.unwrap();
    host.emit(&t1, &[b'1'; 300]).await;
    host.emit(&t2, &[b'2'; 400]).await;
    evs.wait_output_len(&t1, 300).await;
    evs.wait_output_len(&t2, 400).await;

    host.kill_link();
    // 断开期间 t1 被别的设备占用；两个终端都有新输出
    host.lock().busy_terms.insert(t1.clone());
    host.emit(&t1, b"away1").await;
    host.emit(&t2, b"away2").await;
    evs.wait_state(SessionState::Reconnecting).await;
    // BUSY 的终端不阻塞会话进入 Ready
    evs.wait_state(SessionState::Ready).await;

    // t2 正常续传，无重复无缺失
    evs.wait_output_len(&t2, 405).await;
    let mut expect2 = vec![b'2'; 400];
    expect2.extend_from_slice(b"away2");
    assert_eq!(evs.contiguous_output(&t2), expect2);

    // t1：一条 TERM_BUSY 提示，未被抢占，输入返回未附着
    let busy: Vec<_> = evs.find_all(|e| match e {
        CoreEvent::AppNotice { term, notice, .. } if notice.title == "TERM_BUSY" => {
            Some(term.clone())
        }
        _ => None,
    });
    assert_eq!(busy, vec![t1.clone()]);
    assert_eq!(evs.outputs(&t1).len(), 1, "被占用的终端没有新输出");
    assert!(matches!(
        c.term_input(&t1, vec![1]).await,
        Err(CtlError::TermNotAttached(_))
    ));
    c.term_input(&t2, vec![b'x']).await.expect("t2 可输入");
    // 每个终端只尝试附着一次
    let n1 = host
        .lock()
        .attach_reqs
        .iter()
        .filter(|r| r.term_id == t1)
        .count();
    assert_eq!(n1, 1);

    // 占用解除后，用户可以显式再次附着，偏移从已收到的位置续上
    host.lock().busy_terms.clear();
    c.attach_term(&t1, TermSize::default())
        .await
        .expect("再次附着");
    evs.wait_output_len(&t1, 305).await;
    let mut expect1 = vec![b'1'; 300];
    expect1.extend_from_slice(b"away1");
    assert_eq!(evs.contiguous_output(&t1), expect1);
    c.term_input(&t1, vec![b'y']).await.expect("t1 可输入");
}
