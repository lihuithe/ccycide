//! 主控端对接真实的 `HostSession`（真 PTY、真 inbox），链路用 `loopback_pair` 直连，不经过网络。
mod controller_common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use controller_common::*;
use futures_util::future::BoxFuture;
use rterm_core::controller::{
    ConnectError, ConnectSpec, Connected, Connector, Controller, TermOpenOptions, TermSize,
    UploadSource,
};
use rterm_core::events::{CoreEvent, SessionState};
use rterm_core::host::session::{HostConfig, HostCtx, HostSession};
use rterm_core::link::{link_pair, LinkEnds, PeerInfo};
use rterm_proto::pb::Frame;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

struct RealHostConnector {
    ctx: Arc<HostCtx>,
    running: Mutex<Vec<JoinHandle<()>>>,
}

impl RealHostConnector {
    /// 模拟网络断开：终止所有正在服务的会话任务（链路随之关闭）。
    fn drop_links(&self) {
        for h in self.running.lock().unwrap().drain(..) {
            h.abort();
        }
    }
}

impl Connector for RealHostConnector {
    fn connect<'a>(
        &'a self,
        _spec: &'a ConnectSpec,
    ) -> BoxFuture<'a, Result<Connected, ConnectError>> {
        Box::pin(async move {
            // 手工搭一对链路，两条泵任务可以被终止：终止即等于网络断开
            // （被控端终端持有的发送端不会因为会话任务结束而关闭链路）
            let (c, c_ends) = link_pair(PeerInfo::default());
            // 被控端一侧的 peer 要带上稳定的主控设备码：终端隔离按设备区分，重连后还是同一台设备
            let (h, h_ends) = link_pair(PeerInfo {
                device_code: "111111111".into(),
                ..PeerInfo::default()
            });
            let LinkEnds {
                interactive_rx: ci,
                bulk_rx: cb,
                incoming_tx: c_in,
            } = c_ends;
            let LinkEnds {
                interactive_rx: hi,
                bulk_rx: hb,
                incoming_tx: h_in,
            } = h_ends;
            let mut running = self.running.lock().unwrap();
            running.push(tokio::spawn(pump(ci, cb, h_in)));
            running.push(tokio::spawn(pump(hi, hb, c_in)));
            let ctx = self.ctx.clone();
            running.push(tokio::spawn(async move {
                let _ = HostSession::run(h, ctx).await;
            }));
            Ok(Connected {
                link: c,
                close: None,
                peer_public_key: vec![3u8; 32],
            })
        })
    }
}

/// 单向泵：交互队列优先于批量队列（与 mux 的调度规则一致）。
async fn pump(
    mut irx: mpsc::Receiver<Frame>,
    mut brx: mpsc::Receiver<Frame>,
    dest: mpsc::Sender<Frame>,
) {
    loop {
        let f = tokio::select! {
            biased;
            Some(f) = irx.recv() => f,
            Some(f) = brx.recv() => f,
            else => break,
        };
        if dest.send(f).await.is_err() {
            break;
        }
    }
}

fn text(v: &[u8]) -> String {
    String::from_utf8_lossy(v).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn controller_against_real_host_session() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = HostConfig::new(dir.path().to_path_buf());
    cfg.probe_claude = false;
    cfg.claude_integration = false;
    let ctx = HostCtx::new(cfg).await;
    let conn = Arc::new(RealHostConnector {
        ctx: ctx.clone(),
        running: Mutex::new(Vec::new()),
    });

    let (tx, mut evs) = channel();
    let c = Controller::connect(conn.clone(), derived_opts(HOST_CODE), tx)
        .await
        .expect("连接真实被控端");

    // HostInfo / ActionCatalog
    let info = evs
        .find(|e| match e {
            CoreEvent::HostInfo { info, .. } => Some(info.clone()),
            _ => None,
        })
        .expect("HostInfo");
    assert!(!info.shells.is_empty(), "被控端应探测到 shell");
    let cat = evs
        .wait(|e| match e {
            CoreEvent::ActionCatalog { catalog, .. } => Some(catalog.clone()),
            _ => None,
        })
        .await;
    assert!(!cat.actions.is_empty());
    assert!(c.host().unwrap().features.contains("file.upload"));

    // 打开终端并执行命令
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::new(100, 30)))
        .await
        .expect("open_term");
    c.term_input(&t, b"echo RT_FIRST_MARK_77\r".to_vec())
        .await
        .expect("input");
    wait_text(&mut evs, &t, "RT_FIRST_MARK_77").await;
    c.term_ack(
        &t,
        evs.outputs(&t)
            .iter()
            .map(|(s, d)| s + d.len() as u64)
            .max()
            .unwrap_or(0),
    );

    // 断线重连：终端继续存在，续传后无重复、无缺口
    conn.drop_links();
    evs.wait_state(SessionState::Reconnecting).await;
    evs.wait_state(SessionState::Ready).await;
    c.term_input(&t, b"echo RT_SECOND_MARK_88\r".to_vec())
        .await
        .expect("input after reconnect");
    wait_text(&mut evs, &t, "RT_SECOND_MARK_88").await;
    // 输出整体连续（按 seq 衔接）
    let all = text(&evs.contiguous_output(&t));
    assert!(all.contains("RT_FIRST_MARK_77") && all.contains("RT_SECOND_MARK_88"));

    // 动作：终端里没有运行 Claude Code，被控端应返回结果（失败）
    let req = c
        .term_action(
            &t,
            "model.set",
            HashMap::from([("model".into(), "opus".into())]),
        )
        .await
        .expect("action");
    let res = evs
        .wait(|e| match e {
            CoreEvent::ActionResult { result, .. } if result.req_id == req => Some(result.clone()),
            _ => None,
        })
        .await;
    assert!(!res.ok, "没有运行 Claude Code 时动作应失败：{res:?}");

    // 上传 + 带附件提交
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let fid = c
        .upload(UploadSource::Bytes {
            name: "paste.png".into(),
            mime: "image/png".into(),
            data: data.clone(),
        })
        .await
        .expect("upload");
    let remote = evs
        .wait(|e| match e {
            CoreEvent::UploadDone {
                file, remote_path, ..
            } if *file == fid => Some(remote_path.clone()),
            CoreEvent::UploadFailed { file, reason, .. } if *file == fid => {
                panic!("上传失败: {reason}")
            }
            _ => None,
        })
        .await;
    assert_eq!(std::fs::read(&remote).expect("被控端文件存在"), data);
    c.term_submit(&t, "附件在这里 \u{fffc}".into(), vec![fid])
        .await
        .expect("submit with attachment");

    // 自定义命令清单
    c.command_list_req(&t).await.expect("command_list_req");
    evs.wait(|e| matches!(e, CoreEvent::CommandList { .. }).then_some(()))
        .await;

    // 关闭终端
    c.close_term(&t).await.expect("close");
    eventually("被控端终端被清理", || ctx.terms.list().is_empty()).await;
    c.disconnect().await;
    ctx.shutdown().await;
}

async fn wait_text(evs: &mut Evs, term: &str, needle: &str) {
    for _ in 0..200 {
        evs.pump();
        let all: Vec<u8> = evs.outputs(term).into_iter().flat_map(|x| x.1).collect();
        if text(&all).contains(needle) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!(
        "终端输出里没有等到 {needle}：{}",
        text(
            &evs.outputs(term)
                .into_iter()
                .flat_map(|x| x.1)
                .collect::<Vec<_>>()
        )
    );
}
