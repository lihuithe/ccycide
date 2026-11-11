//! 主控端上传：小文件 / 大文件（哈希）、1MB 窗口流控、取消、被控端拒绝、重连中断、剪贴板字节来源。
mod controller_common;

use std::io::Write;
use std::time::Duration;

use controller_common::*;
use rterm_core::controller::{ConnectError, CtlError, TermOpenOptions, TermSize, UploadSource};
use rterm_core::events::{CoreEvent, SessionState};
use rterm_core::signal::SignalError;
use rterm_proto::pb;
use sha2::{Digest, Sha256};

fn pattern(n: usize) -> Vec<u8> {
    (0..n)
        .map(|i| (i.wrapping_mul(31) ^ (i >> 7)) as u8)
        .collect()
}

fn sha(d: &[u8]) -> Vec<u8> {
    Sha256::digest(d).to_vec()
}

#[tokio::test]
async fn upload_small_file_from_path() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("note.txt");
    let data = pattern(1024);
    std::fs::write(&p, &data).unwrap();

    let id = c.upload(UploadSource::Path(p)).await.expect("upload");
    let (file, path) = evs
        .wait(|e| match e {
            CoreEvent::UploadDone {
                file, remote_path, ..
            } => Some((*file, remote_path.clone())),
            _ => None,
        })
        .await;
    assert_eq!(file, id);
    assert_eq!(path, "/inbox/note.txt");
    assert_eq!(host.finished_file("note.txt").unwrap(), data);
    // 最后一条进度是 total/total
    let last = evs
        .find_all(|e| match e {
            CoreEvent::UploadProgress { sent, total, .. } => Some((*sent, *total)),
            _ => None,
        })
        .pop()
        .unwrap();
    assert_eq!(last, (1024, 1024));
}

#[tokio::test]
async fn upload_zero_byte_file() {
    let (c, host, _conn, mut evs) = connect_one().await;
    c.upload(UploadSource::Bytes {
        name: "empty.bin".into(),
        mime: String::new(),
        data: vec![],
    })
    .await
    .unwrap();
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { .. }).then_some(()))
        .await;
    assert_eq!(host.finished_file("empty.bin").unwrap(), Vec::<u8>::new());
}

#[tokio::test]
async fn upload_clipboard_bytes_then_submit_with_attachment() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();
    let png = pattern(70_000); // 超过两个 32KB 块
    let id = c
        .upload(UploadSource::Bytes {
            name: "paste.png".into(),
            mime: "image/png".into(),
            data: png.clone(),
        })
        .await
        .unwrap();
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { file, .. } if *file == id).then_some(()))
        .await;
    assert_eq!(host.finished_file("paste.png").unwrap(), png);

    // 附件已就绪，提交带上 file_id
    c.term_submit(&t, "这张图是什么 \u{fffc}".into(), vec![id])
        .await
        .expect("submit");
    eventually("submit 到达", || host.lock().submits.len() == 1).await;
    assert_eq!(host.lock().submits[0].attachments, vec![id]);
}

#[tokio::test]
async fn upload_large_file_hash_matches() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("big.bin");
    // 12MB + 零头：不是 32KB 整数倍
    let data = pattern(12 * 1024 * 1024 + 4321);
    {
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(&data).unwrap();
    }
    c.upload(UploadSource::Path(p)).await.unwrap();
    // 进度事件是节流的，不会每块一条
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { .. }).then_some(()))
        .await;
    let got = host.finished_file("big.bin").unwrap();
    assert_eq!(got.len(), data.len());
    assert_eq!(sha(&got), sha(&data));
    let progress = evs.find_all(|e| match e {
        CoreEvent::UploadProgress { sent, .. } => Some(*sent),
        _ => None,
    });
    assert!(progress.windows(2).all(|w| w[0] < w[1]), "进度单调递增");
    assert!(progress.len() < data.len() / 32768, "进度被节流");
    assert_eq!(*progress.last().unwrap(), data.len() as u64);
}

#[tokio::test]
async fn upload_window_is_1mb_until_acked() {
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().ack_files = false; // 被控端不回 FileAck
    let data = pattern(4 * 1024 * 1024);
    let id = c
        .upload(UploadSource::Bytes {
            name: "w.bin".into(),
            mime: String::new(),
            data: data.clone(),
        })
        .await
        .unwrap();

    // 恰好发出一个窗口（1MB）就停住
    eventually("发满窗口", || host.file_bytes() >= 1024 * 1024).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.file_bytes(), 1024 * 1024, "未确认时不能超过窗口");

    // 确认 512KB：窗口前进，再多发 512KB 后停住
    host.send_ctl(pb::frame::Body::FileAck(pb::FileAck {
        file_id: id,
        received: 512 * 1024,
    }))
    .await;
    eventually("窗口前进", || host.file_bytes() >= 1536 * 1024).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.file_bytes(), 1536 * 1024);

    // 过期（更小）的确认不会让窗口倒退或多发
    host.send_ctl(pb::frame::Body::FileAck(pb::FileAck {
        file_id: id,
        received: 100,
    }))
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(host.file_bytes(), 1536 * 1024);

    // 恢复自动确认并补发一次累计确认，传输走完
    host.lock().ack_files = true;
    host.send_ctl(pb::frame::Body::FileAck(pb::FileAck {
        file_id: id,
        received: 1536 * 1024,
    }))
    .await;
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { .. }).then_some(()))
        .await;
    assert_eq!(sha(&host.finished_file("w.bin").unwrap()), sha(&data));
}

#[tokio::test]
async fn upload_cancel_midway_sends_file_cancel() {
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().ack_files = false;
    let id = c
        .upload(UploadSource::Bytes {
            name: "c.bin".into(),
            mime: String::new(),
            data: pattern(3 * 1024 * 1024),
        })
        .await
        .unwrap();
    eventually("传了一部分", || host.file_bytes() >= 512 * 1024).await;
    c.cancel_upload(id);
    let reason = evs
        .wait(|e| match e {
            CoreEvent::UploadFailed { file, reason, .. } if *file == id => Some(reason.clone()),
            _ => None,
        })
        .await;
    assert_eq!(reason, "已取消");
    eventually("被控端收到 FileCancel", || {
        host.lock().cancelled == vec![id]
    })
    .await;
    // 之后不再有数据块
    let n = host.file_bytes();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(host.file_bytes(), n);
    assert!(host.finished_file("c.bin").is_none());
}

#[tokio::test]
async fn upload_rejected_by_host_reports_reason() {
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().reject_files = Some("FILE_DISABLED");
    let id = c
        .upload(UploadSource::Bytes {
            name: "x".into(),
            mime: String::new(),
            data: vec![1; 10],
        })
        .await
        .unwrap();
    let reason = evs
        .wait(|e| match e {
            CoreEvent::UploadFailed { file, reason, .. } if *file == id => Some(reason.clone()),
            _ => None,
        })
        .await;
    assert!(reason.contains("FILE_DISABLED"), "{reason}");
}

#[tokio::test]
async fn upload_larger_than_host_limit_fails_immediately() {
    let host = FakeHost::new();
    host.lock().max_file_size = 1000;
    let conn = TestConnector::new(host.clone());
    let (tx, _evs) = channel();
    let c = rterm_core::controller::Controller::connect(conn, derived_opts(HOST_CODE), tx)
        .await
        .unwrap();
    let r = c
        .upload(UploadSource::Bytes {
            name: "big".into(),
            mime: String::new(),
            data: vec![0; 1001],
        })
        .await;
    assert!(
        matches!(
            r,
            Err(CtlError::FileTooLarge {
                size: 1001,
                max: 1000
            })
        ),
        "{r:?}"
    );
    assert_eq!(host.file_bytes(), 0);
}

#[tokio::test]
async fn upload_missing_file_and_unsupported_host() {
    let (c, _host, _conn, _evs) = connect_one().await;
    let r = c
        .upload(UploadSource::Path("Z:/no/such/file.bin".into()))
        .await;
    assert!(matches!(r, Err(CtlError::Io(_))), "{r:?}");

    let host = FakeHost::new();
    host.lock().features.retain(|f| f != "file.upload");
    let conn = TestConnector::new(host);
    let (tx, _evs2) = channel();
    let c2 = rterm_core::controller::Controller::connect(conn, derived_opts(HOST_CODE), tx)
        .await
        .unwrap();
    let r = c2
        .upload(UploadSource::Bytes {
            name: "a".into(),
            mime: String::new(),
            data: vec![1],
        })
        .await;
    assert!(matches!(r, Err(CtlError::FileUnsupported)), "{r:?}");
}

#[tokio::test]
async fn reconnect_fails_inflight_uploads_and_invalidates_attachments() {
    let (c, host, conn, mut evs) = connect_one().await;
    let t = c
        .open_term(TermOpenOptions::shell(TermSize::default()))
        .await
        .unwrap();

    // 先完成一个上传，拿到可用附件
    let done = c
        .upload(UploadSource::Bytes {
            name: "ok.bin".into(),
            mime: String::new(),
            data: vec![7; 100],
        })
        .await
        .unwrap();
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { file, .. } if *file == done).then_some(()))
        .await;

    // 再开一个停在半路的上传
    host.lock().ack_files = false;
    let stuck = c
        .upload(UploadSource::Bytes {
            name: "stuck.bin".into(),
            mime: String::new(),
            data: pattern(4 * 1024 * 1024),
        })
        .await
        .unwrap();
    eventually("停在窗口上", || host.file_bytes() >= 1024 * 1024).await;

    // 断线（重连会卡在失败状态里，方便检查"重连中"的行为）
    *conn.fail_all.lock().unwrap() = Some(ConnectError::Signal(SignalError::Offline));
    host.kill_link();
    let reason = evs
        .wait(|e| match e {
            CoreEvent::UploadFailed { file, reason, .. } if *file == stuck => Some(reason.clone()),
            _ => None,
        })
        .await;
    assert!(reason.contains("连接中断"), "{reason}");
    eventually("进入重连中", || {
        c.state() == SessionState::Reconnecting
    })
    .await;

    // 重连中不能上传
    let r = c
        .upload(UploadSource::Bytes {
            name: "z".into(),
            mime: String::new(),
            data: vec![1],
        })
        .await;
    assert!(matches!(r, Err(CtlError::NotConnected)), "{r:?}");

    // 重连成功后旧附件作废（被控端的记录按会话），不会带着失效的 file_id 提交
    *conn.fail_all.lock().unwrap() = None;
    evs.wait_state(SessionState::Ready).await;
    let r = c.term_submit(&t, "hi".into(), vec![done]).await;
    assert!(
        matches!(r, Err(CtlError::AttachmentNotReady(x)) if x == done),
        "{r:?}"
    );
    // 重连后可以重新上传
    host.lock().ack_files = true;
    let again = c
        .upload(UploadSource::Bytes {
            name: "again.bin".into(),
            mime: String::new(),
            data: vec![9; 50],
        })
        .await
        .unwrap();
    assert!(again > stuck, "file_id 在会话内单调递增、不复用");
    evs.wait(|e| matches!(e, CoreEvent::UploadDone { file, .. } if *file == again).then_some(()))
        .await;
}

#[tokio::test]
async fn concurrent_uploads_complete_independently() {
    let (c, host, _conn, mut evs) = connect_one().await;
    let mut ids = Vec::new();
    for i in 0..4u8 {
        ids.push(
            c.upload(UploadSource::Bytes {
                name: format!("f{i}.bin"),
                mime: String::new(),
                data: vec![i; 200_000 + i as usize],
            })
            .await
            .unwrap(),
        );
    }
    let mut done = 0;
    while done < 4 {
        evs.wait(|e| matches!(e, CoreEvent::UploadDone { .. }).then_some(()))
            .await;
        done += 1;
    }
    for i in 0..4u8 {
        let d = host.finished_file(&format!("f{i}.bin")).unwrap();
        assert_eq!(d.len(), 200_000 + i as usize);
        assert!(d.iter().all(|b| *b == i));
    }
}

#[tokio::test]
async fn path_source_deleted_midway_fails_without_hanging() {
    let (c, host, _conn, mut evs) = connect_one().await;
    host.lock().ack_files = false;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("trunc.bin");
    std::fs::write(&p, pattern(3 * 1024 * 1024)).unwrap();
    let id = c.upload(UploadSource::Path(p.clone())).await.unwrap();
    eventually("停在窗口上", || host.file_bytes() >= 1024 * 1024).await;
    // 截断文件后确认窗口，读取到提前结束
    std::fs::OpenOptions::new()
        .write(true)
        .open(&p)
        .unwrap()
        .set_len(1024 * 1024)
        .unwrap();
    host.send_ctl(pb::frame::Body::FileAck(pb::FileAck {
        file_id: id,
        received: 1024 * 1024,
    }))
    .await;
    let reason = evs
        .wait(|e| match e {
            CoreEvent::UploadFailed { file, reason, .. } if *file == id => Some(reason.clone()),
            _ => None,
        })
        .await;
    assert!(reason.contains("截断"), "{reason}");
    eventually("被控端收到 FileCancel", || {
        host.lock().cancelled.contains(&id)
    })
    .await;
}
