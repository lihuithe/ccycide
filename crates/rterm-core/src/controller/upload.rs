//! 主控端上传（《实现方案.md》3.7、4.7、5.6，《开发指南.md》T26）。
//!
//! 每个上传是一个独立任务：`FileBegin` → 等 `FileAccept` → 32KB 一块走批量队列（`send_bulk`）→
//! `FileEnd`（带 SHA-256）→ 等 `FileDone`。
//! - 路径来源按块流式读取，边读边算哈希，内存占用与文件大小无关；
//! - 发送窗口 1MB：已发送且未被 `FileAck` 确认的字节达到窗口就暂停；
//! - 进度事件节流（默认每 100 毫秒最多一次）；
//! - 会话重连时进行中的上传全部失败（不做断点续传）：会话任务丢弃收件箱发送端，上传任务据此得知连接中断。
use std::path::PathBuf;
use std::time::{Duration, Instant};

use rterm_proto::pb;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use crate::events::{CoreEvent, FileId, SessionId};
use crate::link::FrameTx;
use crate::mux::BULK_CHUNK;

/// 发送窗口：已发送未确认的字节数达到它就暂停。
pub const WINDOW: u64 = 1024 * 1024;
/// 每块大小。
pub const CHUNK: usize = BULK_CHUNK;
/// 同时进行的上传数上限（与被控端一致）。
pub const MAX_CONCURRENT: usize = 8;
/// 控制端分配的 `file_id` 从这里开始，避免与请求编号（`req_id`）重叠：被控端的 `Error.ref_id` 两者通用。
pub const FILE_ID_BASE: u64 = 1 << 32;

/// 上传的数据来源。
#[derive(Debug, Clone)]
pub enum UploadSource {
    /// 本机文件路径，按块流式读取
    Path(PathBuf),
    /// 原始字节（例如前端交来的剪贴板图片）
    Bytes {
        name: String,
        mime: String,
        data: Vec<u8>,
    },
}

/// 已解析的上传来源：名称、类型、大小已知。
#[derive(Debug)]
pub(crate) struct Prepared {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub source: Source,
}

#[derive(Debug)]
pub(crate) enum Source {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

impl UploadSource {
    /// 读取元数据（文件是否存在、大小）。不读取内容。
    pub(crate) async fn prepare(self) -> Result<Prepared, String> {
        match self {
            UploadSource::Path(p) => {
                let meta = tokio::fs::metadata(&p)
                    .await
                    .map_err(|e| format!("读取文件信息失败: {e}"))?;
                if !meta.is_file() {
                    return Err("不是普通文件".into());
                }
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "file".into());
                let mime = guess_mime(&name).to_string();
                Ok(Prepared {
                    name,
                    mime,
                    size: meta.len(),
                    source: Source::Path(p),
                })
            }
            UploadSource::Bytes { name, mime, data } => {
                let name = if name.trim().is_empty() {
                    "file".to_string()
                } else {
                    name
                };
                let mime = if mime.trim().is_empty() {
                    guess_mime(&name).to_string()
                } else {
                    mime
                };
                Ok(Prepared {
                    name,
                    mime,
                    size: data.len() as u64,
                    source: Source::Bytes(data),
                })
            }
        }
    }
}

/// 按扩展名猜 MIME 类型（只覆盖常见的图片和文本，其余为 octet-stream）。
pub fn guess_mime(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// 会话任务转给上传任务的消息。
#[derive(Debug)]
pub(crate) enum UploadMsg {
    Accept,
    Ack(u64),
    Done(String),
    /// 被控端返回的 `Error`（`ref_id` = file_id）
    Error {
        code: String,
        message: String,
    },
    Cancel,
}

/// 上传任务的运行参数。
pub(crate) struct UploadJob {
    pub session: SessionId,
    pub file_id: FileId,
    pub prepared: Prepared,
    pub tx: FrameTx,
    pub events: mpsc::Sender<CoreEvent>,
    pub inbox: mpsc::Receiver<UploadMsg>,
    /// 等待 `FileAccept` / `FileDone` / 窗口确认的最长时间
    pub stall_timeout: Duration,
    pub progress_interval: Duration,
}

#[derive(Debug)]
enum UpErr {
    Cancelled,
    /// 连接已中断（收件箱被丢弃，或发送失败）
    ConnLost,
    Remote(String),
    Io(String),
    Stalled(&'static str),
}

impl UpErr {
    fn reason(&self) -> String {
        match self {
            UpErr::Cancelled => "已取消".into(),
            UpErr::ConnLost => "连接中断，上传失败".into(),
            UpErr::Remote(s) => s.clone(),
            UpErr::Io(s) => format!("读取文件失败: {s}"),
            UpErr::Stalled(what) => format!("被控端无响应（{what}）"),
        }
    }
}

fn file_frame(body: pb::frame::Body) -> pb::Frame {
    pb::Frame {
        channel: 0,
        body: Some(body),
    }
}

/// 数据读取器：路径按块读，字节按偏移切。
enum Reader {
    File(tokio::fs::File),
    Mem { data: Vec<u8>, pos: usize },
}

impl Reader {
    async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Reader::File(f) => f.read(buf).await,
            Reader::Mem { data, pos } => {
                let n = buf.len().min(data.len() - *pos);
                buf[..n].copy_from_slice(&data[*pos..*pos + n]);
                *pos += n;
                Ok(n)
            }
        }
    }
}

/// 上传任务入口。结束时发 `UploadDone` 或 `UploadFailed`。
pub(crate) async fn run(mut job: UploadJob) {
    let res = transfer(&mut job).await;
    let ev = match res {
        Ok(remote_path) => CoreEvent::UploadDone {
            session: job.session.clone(),
            file: job.file_id,
            remote_path,
        },
        Err(e) => {
            // 取消、读盘失败、超时：通知被控端删除 .part。连接已断或被控端报错的不用再发
            if matches!(e, UpErr::Cancelled | UpErr::Io(_) | UpErr::Stalled(_)) {
                let _ = job
                    .tx
                    .try_send(file_frame(pb::frame::Body::FileCancel(pb::FileCancel {
                        file_id: job.file_id,
                        reason: e.reason(),
                    })));
            }
            CoreEvent::UploadFailed {
                session: job.session.clone(),
                file: job.file_id,
                reason: e.reason(),
            }
        }
    };
    let _ = job.events.send(ev).await;
}

/// 进度节流器。
struct Progress {
    last: Option<Instant>,
    last_sent: u64,
    interval: Duration,
}

impl Progress {
    fn emit(&mut self, job: &UploadJob, sent: u64, force: bool) {
        let due = force || self.last.is_none_or(|t| t.elapsed() >= self.interval);
        if !due || (self.last.is_some() && sent == self.last_sent) {
            return;
        }
        // 进度不重要：事件通道满了就丢弃，不阻塞传输
        let ok = job
            .events
            .try_send(CoreEvent::UploadProgress {
                session: job.session.clone(),
                file: job.file_id,
                sent,
                total: job.prepared.size,
            })
            .is_ok();
        if ok {
            self.last = Some(Instant::now());
            self.last_sent = sent;
        }
    }
}

/// 处理一条会话消息。返回 Err 表示上传应当结束。
fn on_msg(msg: UploadMsg, acked: &mut u64) -> Result<(), UpErr> {
    match msg {
        UploadMsg::Ack(n) => {
            *acked = (*acked).max(n);
            Ok(())
        }
        UploadMsg::Error { code, message } => {
            Err(UpErr::Remote(format!("被控端拒绝: {code}: {message}")))
        }
        UploadMsg::Cancel => Err(UpErr::Cancelled),
        // 乱序或重复的 Accept / Done 忽略
        UploadMsg::Accept | UploadMsg::Done(_) => Ok(()),
    }
}

async fn transfer(job: &mut UploadJob) -> Result<String, UpErr> {
    let size = job.prepared.size;
    let file_id = job.file_id;

    // 打开数据来源（Bytes 取走，避免多占一份内存）
    let mut reader = match std::mem::replace(&mut job.prepared.source, Source::Bytes(Vec::new())) {
        Source::Path(p) => Reader::File(
            tokio::fs::File::open(&p)
                .await
                .map_err(|e| UpErr::Io(e.to_string()))?,
        ),
        Source::Bytes(data) => Reader::Mem { data, pos: 0 },
    };

    // 1. FileBegin → FileAccept
    job.tx
        .send(file_frame(pb::frame::Body::FileBegin(pb::FileBegin {
            file_id,
            name: job.prepared.name.clone(),
            size,
            mime: job.prepared.mime.clone(),
        })))
        .await
        .map_err(|_| UpErr::ConnLost)?;
    let mut acked = 0u64;
    loop {
        match tokio::time::timeout(job.stall_timeout, job.inbox.recv()).await {
            Err(_) => return Err(UpErr::Stalled("等待接受")),
            Ok(None) => return Err(UpErr::ConnLost),
            Ok(Some(UploadMsg::Accept)) => break,
            Ok(Some(m)) => on_msg(m, &mut acked)?,
        }
    }

    // 2. 分块发送
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut sent = 0u64;
    let mut progress = Progress {
        last: None,
        last_sent: 0,
        interval: job.progress_interval,
    };
    while sent < size {
        // 窗口已满：等确认
        while sent - acked >= WINDOW {
            match tokio::time::timeout(job.stall_timeout, job.inbox.recv()).await {
                Err(_) => return Err(UpErr::Stalled("等待确认")),
                Ok(None) => return Err(UpErr::ConnLost),
                Ok(Some(m)) => on_msg(m, &mut acked)?,
            }
        }
        // 取走已到的消息（取消、错误、确认），不等待
        loop {
            match job.inbox.try_recv() {
                Ok(m) => on_msg(m, &mut acked)?,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return Err(UpErr::ConnLost),
            }
        }

        let want = (size - sent).min(CHUNK as u64) as usize;
        let n = reader
            .read(&mut buf[..want])
            .await
            .map_err(|e| UpErr::Io(e.to_string()))?;
        if n == 0 {
            return Err(UpErr::Io("文件在上传期间被截断".into()));
        }
        hasher.update(&buf[..n]);
        let frame = file_frame(pb::frame::Body::FileChunk(pb::FileChunk {
            file_id,
            offset: sent,
            data: buf[..n].to_vec(),
        }));

        // 批量队列满时在这里等待；等待期间仍要响应取消、错误和连接中断
        let send = job.tx.send_bulk(frame);
        tokio::pin!(send);
        loop {
            tokio::select! {
                r = &mut send => {
                    r.map_err(|_| UpErr::ConnLost)?;
                    break;
                }
                m = job.inbox.recv() => match m {
                    None => return Err(UpErr::ConnLost),
                    Some(m) => on_msg(m, &mut acked)?,
                },
            }
        }
        sent += n as u64;
        progress.emit(job, sent, false);
    }
    progress.emit(job, size, true);

    // 3. FileEnd → FileDone
    // FileEnd 必须和数据块走同一个（批量）队列：交互队列优先，走交互队列会让它超过还没发出的数据块
    let digest = hasher.finalize().to_vec();
    job.tx
        .send_bulk(file_frame(pb::frame::Body::FileEnd(pb::FileEnd {
            file_id,
            sha256: digest,
        })))
        .await
        .map_err(|_| UpErr::ConnLost)?;
    loop {
        match tokio::time::timeout(job.stall_timeout, job.inbox.recv()).await {
            Err(_) => return Err(UpErr::Stalled("等待校验结果")),
            Ok(None) => return Err(UpErr::ConnLost),
            Ok(Some(UploadMsg::Done(path))) => return Ok(path),
            Ok(Some(m)) => on_msg(m, &mut acked)?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_guess() {
        assert_eq!(guess_mime("a.PNG"), "image/png");
        assert_eq!(guess_mime("x.tar.gz"), "application/octet-stream");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
        assert_eq!(guess_mime("a.jpeg"), "image/jpeg");
    }

    #[tokio::test]
    async fn prepare_bytes_defaults() {
        let p = UploadSource::Bytes {
            name: "  ".into(),
            mime: String::new(),
            data: vec![1, 2, 3],
        }
        .prepare()
        .await
        .expect("prepare");
        assert_eq!(p.name, "file");
        assert_eq!(p.size, 3);
        assert_eq!(p.mime, "application/octet-stream");
    }

    #[tokio::test]
    async fn prepare_missing_path_fails() {
        let r = UploadSource::Path(PathBuf::from("Z:/definitely/not/here.bin"))
            .prepare()
            .await;
        assert!(r.is_err());
    }
}
