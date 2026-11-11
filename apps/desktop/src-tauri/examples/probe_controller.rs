//! 验证用：以“另一台设备”的身份连入本机桌面端（被控端），用来测试来访事件、通知、托盘图标变色、
//! 连接确认（无超时、排队）和主控方取消。
//!
//! 用法（桌面端已运行）：
//!   RTERM_API_URL=http://127.0.0.1:8080 RTERM_DATA_DIR=<独立目录> RTERM_NO_KEYRING=1 \
//!     cargo run -p rterm-desktop --example probe_controller -- <设备码> <密码> [保持秒数] [取消秒数]
//!
//! 第 4 个参数：等待对方确认超过这么多秒后调用 `cancel_connect`（测试主控方取消）。
use std::time::Duration;

use rterm_core::controller::TermSize;
use rterm_core::core::{Core, CoreKind, CoreOptions, OpenTermParams};
use rterm_core::events::{CoreEvent, SessionState};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法：probe_controller <设备码> <密码> [保持秒数] [取消秒数]");
        std::process::exit(2);
    }
    let hold: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
    let cancel_after: Option<u64> = args.get(4).and_then(|s| s.parse().ok());
    let mut opts = CoreOptions::new(CoreKind::Cli, "0.0.0-probe");
    opts.probe_claude = false;
    let (core, mut rx) = match Core::start(opts).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("核心启动失败：{e}");
            std::process::exit(1);
        }
    };

    let started = tokio::time::Instant::now();
    let connect = {
        let core = core.clone();
        let (code, pw) = (args[1].clone(), args[2].clone());
        tokio::spawn(async move { core.connect(&code, &pw).await })
    };
    tokio::pin!(connect);
    let mut pending_sid: Option<String> = None;
    let cancel_at = cancel_after.map(|s| started + Duration::from_secs(s));
    let sid = loop {
        tokio::select! {
            r = &mut connect => match r {
                Ok(Ok(s)) => break s,
                Ok(Err(e)) => {
                    println!("连接失败：{e}（用时 {:?}）", started.elapsed());
                    core.shutdown().await;
                    return;
                }
                Err(e) => {
                    eprintln!("连接任务异常：{e}");
                    return;
                }
            },
            ev = rx.recv() => {
                if let Some(CoreEvent::SessionState { session, state }) = ev {
                    println!("[{:?}] 会话状态 {state:?}", started.elapsed());
                    if matches!(state, SessionState::Connecting | SessionState::AwaitingApproval) {
                        pending_sid = Some(session);
                    }
                }
            },
            _ = async {
                match cancel_at {
                    Some(t) => tokio::time::sleep_until(t).await,
                    None => std::future::pending().await,
                }
            }, if pending_sid.is_some() => {
                println!("[{:?}] 调用 cancel_connect", started.elapsed());
                if let Some(s) = &pending_sid {
                    core.cancel_connect(s);
                }
                // 只取消一次
                pending_sid = None;
            }
        }
    };
    println!("已连接（用时 {:?}），会话 {sid}", started.elapsed());
    let opened = core
        .open_term_ui(
            &sid,
            OpenTermParams {
                profile: "shell".into(),
                cols: 100,
                rows: 30,
                ..OpenTermParams::default()
            },
        )
        .await;
    match opened {
        Ok(t) => {
            println!("终端已打开 {}", t.term_id);
            let _ = core
                .attach_term(&sid, &t.term_id, TermSize::new(100, 30))
                .await;
            let _ = core
                .term_input(&sid, &t.term_id, b"echo probe-hello\r".to_vec())
                .await;
        }
        Err(e) => eprintln!("打开终端失败：{e}"),
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(hold);
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(CoreEvent::TermOutput { data, .. }) => print!("{}", String::from_utf8_lossy(&data)),
                Some(CoreEvent::SessionState { state, .. }) => println!("[会话状态] {state:?}"),
                Some(_) => {}
                None => break,
            },
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    let _ = core.disconnect(&sid).await;
    core.shutdown().await;
    println!("\n探针退出");
}
