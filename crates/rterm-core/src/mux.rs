//! 多路复用：把「加密记录层 + 中继连接」包装成上层使用的 `Link`。
//!
//! - 发送任务：一个任务里按顺序完成「选帧 → 编码 → 加密 → 写出」，保证 nonce 计数器与发送顺序一致。
//! - 优先级：交互队列优先；批量队列（文件块）只在交互队列为空、且底层可写时才发一块（每块 32KB）。
//!   因此交互帧最多等待一块批量数据写出的时间。
//! - 单条记录（含类型字节和 16 字节标签）不超过 128KB。
//! - 背压：所有队列都是有界通道。底层写不动 -> 发送任务停住 -> 队列填满 -> 上层 `send` 等待；
//!   接收方向同理：上层不取，`incoming` 通道填满后停止读取 socket，TCP 反压到中继。
use std::future::poll_fn;
use std::sync::Arc;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use prost::Message;
use rterm_proto::pb::Frame;
use tokio::sync::watch;

use crate::crypto::{RecordError, Sealer};
use crate::link::{link_pair, Link, LinkEnds, PeerInfo};
use crate::relay::RelayError;

/// 单条记录（整条 WebSocket 消息）的上限。
pub const MAX_RECORD: usize = 128 * 1024;
/// 类型字节 + AEAD 标签。
const RECORD_OVERHEAD: usize = 1 + 16;
/// 单个 Frame 编码后的上限。
pub const MAX_FRAME_PLAIN: usize = MAX_RECORD - RECORD_OVERHEAD;
/// 批量数据分块大小（上层按此大小切分文件块）。
pub const BULK_CHUNK: usize = 32 * 1024;

/// 会话结束的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseInfo {
    /// 中继的 WebSocket 关闭码（4001–4007）；没有则为 None
    pub code: Option<u16>,
    pub reason: String,
    /// 是否由本端主动关闭（Link 被丢弃）
    pub local: bool,
}

/// 会话句柄：观察关闭原因、主动关闭。
#[derive(Clone)]
pub struct MuxHandle {
    closed: watch::Receiver<Option<CloseInfo>>,
    stop: Arc<tokio::sync::Notify>,
}

impl MuxHandle {
    /// 会话已关闭则返回原因。
    pub fn close_info(&self) -> Option<CloseInfo> {
        self.closed.borrow().clone()
    }

    /// 等待会话关闭，返回原因。
    pub async fn wait_closed(&mut self) -> CloseInfo {
        loop {
            if let Some(i) = self.closed.borrow().clone() {
                return i;
            }
            if self.closed.changed().await.is_err() {
                return self.closed.borrow().clone().unwrap_or(CloseInfo {
                    code: None,
                    reason: "任务已结束".into(),
                    local: true,
                });
            }
        }
    }

    /// 立即关闭连接（不等队列排空）。
    pub fn abort(&self) {
        self.stop.notify_one();
    }
}

/// 用已协商好的方向密钥启动 mux，返回上层使用的 `Link`。
///
/// `sink`/`stream` 的一个元素是一条完整记录（含类型字节）。
pub fn spawn_mux<S, R>(
    sink: S,
    stream: R,
    send: Sealer,
    recv: Sealer,
    peer: PeerInfo,
) -> (Link, MuxHandle)
where
    S: Sink<Vec<u8>, Error = RelayError> + Unpin + Send + 'static,
    R: Stream<Item = Result<Vec<u8>, RelayError>> + Unpin + Send + 'static,
{
    let (link, ends) = link_pair(peer);
    let (closed_tx, closed_rx) = watch::channel(None);
    let stop = Arc::new(tokio::sync::Notify::new());
    let stop2 = stop.clone();
    tokio::spawn(async move {
        let info = run(sink, stream, send, recv, ends, stop2).await;
        tracing::debug!("mux 结束: {info:?}");
        let _ = closed_tx.send(Some(info));
    });
    (
        link,
        MuxHandle {
            closed: closed_rx,
            stop,
        },
    )
}

async fn run<S, R>(
    mut sink: S,
    mut stream: R,
    send: Sealer,
    recv: Sealer,
    ends: LinkEnds,
    stop: Arc<tokio::sync::Notify>,
) -> CloseInfo
where
    S: Sink<Vec<u8>, Error = RelayError> + Unpin + Send + 'static,
    R: Stream<Item = Result<Vec<u8>, RelayError>> + Unpin + Send + 'static,
{
    let LinkEnds {
        interactive_rx,
        bulk_rx,
        incoming_tx,
    } = ends;
    let (info, flush_close) = {
        let writer = write_loop(&mut sink, send, interactive_rx, bulk_rx);
        let reader = read_loop(&mut stream, recv, incoming_tx);
        tokio::pin!(writer);
        tokio::pin!(reader);
        tokio::select! {
            r = &mut writer => (r, true),   // 上层丢弃了 Link：队列已排空，正常关闭
            r = &mut reader => (r, false),  // 对端关闭 / 出错
            _ = stop.notified() => (CloseInfo { code: None, reason: "本端中止".into(), local: true }, false),
        }
    };
    if flush_close {
        // 礼貌地发送 Close 帧，限时 2 秒
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sink.close()).await;
    }
    info
}

/// 发送循环。返回时说明发送侧结束。
async fn write_loop<S>(
    sink: &mut S,
    mut sealer: Sealer,
    mut interactive: tokio::sync::mpsc::Receiver<Frame>,
    mut bulk: tokio::sync::mpsc::Receiver<Frame>,
) -> CloseInfo
where
    S: Sink<Vec<u8>, Error = RelayError> + Unpin,
{
    loop {
        // 先等底层可写：只有可写时才决定发哪个队列的帧，避免批量块抢在刚到的交互帧前面占位
        if let Err(e) = poll_fn(|cx| sink.poll_ready_unpin(cx)).await {
            return close_from(e);
        }
        let frame = tokio::select! {
            biased; // 交互队列优先；批量队列只有在交互队列为空时才会被选中
            Some(f) = interactive.recv() => f,
            Some(f) = bulk.recv() => f,
            else => return CloseInfo { code: None, reason: "本端关闭".into(), local: true },
        };
        let plain = frame.encode_to_vec();
        if plain.len() > MAX_FRAME_PLAIN {
            tracing::error!(
                "Frame 过大（{} 字节，上限 {}），关闭会话",
                plain.len(),
                MAX_FRAME_PLAIN
            );
            return CloseInfo {
                code: None,
                reason: "发送的 Frame 超过 128KB 上限".into(),
                local: true,
            };
        }
        let rec = match sealer.seal(&plain) {
            Ok(r) => r,
            Err(e) => {
                return CloseInfo {
                    code: None,
                    reason: format!("加密失败: {e}"),
                    local: true,
                }
            }
        };
        if let Err(e) = sink.send(rec).await {
            return close_from(e);
        }
    }
}

/// 接收循环。返回时说明接收侧结束（对端关闭、解密失败等）。
async fn read_loop<R>(
    stream: &mut R,
    mut opener: Sealer,
    incoming: tokio::sync::mpsc::Sender<Frame>,
) -> CloseInfo
where
    R: Stream<Item = Result<Vec<u8>, RelayError>> + Unpin,
{
    loop {
        let rec = match stream.next().await {
            Some(Ok(r)) => r,
            Some(Err(e)) => return close_from(e),
            None => {
                return CloseInfo {
                    code: None,
                    reason: "连接已断开".into(),
                    local: false,
                }
            }
        };
        if rec.len() > MAX_RECORD {
            return CloseInfo {
                code: None,
                reason: "收到超长记录".into(),
                local: false,
            };
        }
        // 解密失败立即关闭连接，不尝试跳过
        let plain = match opener.open(&rec) {
            Ok(p) => p,
            Err(RecordError::NotData) => {
                return CloseInfo {
                    code: None,
                    reason: "收到非数据记录".into(),
                    local: false,
                }
            }
            Err(e) => {
                return CloseInfo {
                    code: None,
                    reason: format!("记录校验失败: {e}"),
                    local: false,
                }
            }
        };
        let frame = match Frame::decode(plain.as_slice()) {
            Ok(f) => f,
            Err(e) => {
                return CloseInfo {
                    code: None,
                    reason: format!("Frame 解码失败: {e}"),
                    local: false,
                }
            }
        };
        // 有界：上层不取则这里等待，进而停止读取 socket（背压）
        if incoming.send(frame).await.is_err() {
            return CloseInfo {
                code: None,
                reason: "本端关闭".into(),
                local: true,
            };
        }
    }
}

fn close_from(e: RelayError) -> CloseInfo {
    match e {
        RelayError::Closed { code, reason } => CloseInfo {
            code,
            reason,
            local: false,
        },
        other => CloseInfo {
            code: None,
            reason: other.to_string(),
            local: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rterm_proto::pb;
    use std::collections::VecDeque;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::task::{Context, Poll};

    fn peer() -> PeerInfo {
        PeerInfo::default()
    }

    fn term_frame(n: u64) -> Frame {
        Frame {
            channel: 1,
            body: Some(pb::frame::Body::TermOutput(pb::TermOutput {
                seq: n,
                data: vec![b'x'; 10],
            })),
        }
    }

    fn bulk_frame(n: u64) -> Frame {
        Frame {
            channel: 0,
            body: Some(pb::frame::Body::FileChunk(pb::FileChunk {
                file_id: 1,
                offset: n,
                data: vec![0u8; BULK_CHUNK],
            })),
        }
    }

    /// 测试用 Sink：记录写出的记录；`gate` 为 false 时 poll_ready 返回 Pending（模拟底层写不动）。
    #[derive(Clone)]
    struct TestSink {
        written: Arc<Mutex<Vec<Vec<u8>>>>,
        gate: Arc<Mutex<(bool, Option<std::task::Waker>)>>,
        /// 每写出一条后让出的次数，让并发任务有机会插入新帧
        slow: bool,
    }

    impl TestSink {
        fn new(open: bool) -> Self {
            Self {
                written: Arc::default(),
                gate: Arc::new(Mutex::new((open, None))),
                slow: false,
            }
        }
        fn open_gate(&self) {
            let mut g = self.gate.lock().unwrap();
            g.0 = true;
            if let Some(w) = g.1.take() {
                w.wake();
            }
        }
    }

    impl Sink<Vec<u8>> for TestSink {
        type Error = RelayError;
        fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), RelayError>> {
            let mut g = self.gate.lock().unwrap();
            if g.0 {
                Poll::Ready(Ok(()))
            } else {
                g.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
        fn start_send(self: Pin<&mut Self>, item: Vec<u8>) -> Result<(), RelayError> {
            self.written.lock().unwrap().push(item);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), RelayError>> {
            if self.slow {
                cx.waker().wake_by_ref();
            }
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), RelayError>> {
            Poll::Ready(Ok(()))
        }
    }

    struct Pending;
    impl Stream for Pending {
        type Item = Result<Vec<u8>, RelayError>;
        fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Poll::Pending
        }
    }

    fn decode_all(recs: &[Vec<u8>], key: &[u8; 32]) -> Vec<Frame> {
        let mut o = Sealer::new(key);
        recs.iter()
            .map(|r| Frame::decode(o.open(r).unwrap().as_slice()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn interactive_beats_bulk_when_both_queued() {
        let key = [1u8; 32];
        let sink = TestSink::new(false); // 底层先不可写，让两个队列都积压
        let (link, _h) = spawn_mux(
            sink.clone(),
            Pending,
            Sealer::new(&key),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        for i in 0..8 {
            link.tx.send_bulk(bulk_frame(i)).await.unwrap();
        }
        for i in 0..8 {
            link.tx.send(term_frame(i)).await.unwrap();
        }
        tokio::task::yield_now().await;
        sink.open_gate();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let frames = decode_all(&sink.written.lock().unwrap(), &key);
        assert_eq!(frames.len(), 16);
        // 前 8 条必须全是交互帧（终端输出），之后才是批量块；各自保持顺序
        for (i, f) in frames.iter().take(8).enumerate() {
            assert!(
                matches!(&f.body, Some(pb::frame::Body::TermOutput(o)) if o.seq == i as u64),
                "第 {i} 条应是交互帧"
            );
        }
        for (i, f) in frames.iter().skip(8).enumerate() {
            assert!(matches!(&f.body, Some(pb::frame::Body::FileChunk(c)) if c.offset == i as u64));
        }
    }

    #[tokio::test]
    async fn interactive_waits_at_most_one_bulk_chunk() {
        // 批量源源不断，中途插入交互帧：交互帧前面最多再出现 1 个批量块
        let key = [1u8; 32];
        let sink = TestSink::new(true);
        let (link, _h) = spawn_mux(
            sink.clone(),
            Pending,
            Sealer::new(&key),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        let tx = link.tx.clone();
        let feeder = tokio::spawn(async move {
            for i in 0..200 {
                if tx.send_bulk(bulk_frame(i)).await.is_err() {
                    break;
                }
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let before = sink.written.lock().unwrap().len();
        link.tx.send(term_frame(999)).await.unwrap();
        // 等交互帧出现
        let frames = loop {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let frames = decode_all(&sink.written.lock().unwrap(), &key);
            if frames
                .iter()
                .any(|f| matches!(&f.body, Some(pb::frame::Body::TermOutput(_))))
            {
                break frames;
            }
        };
        let pos = frames
            .iter()
            .position(|f| matches!(&f.body, Some(pb::frame::Body::TermOutput(_))))
            .unwrap();
        assert!(
            pos <= before + 1 + 1,
            "交互帧位置 {pos}，插入时已写出 {before}，不应被多个批量块阻塞"
        );
        feeder.abort();
    }

    #[tokio::test]
    async fn backpressure_when_sink_blocked() {
        let sink = TestSink::new(false);
        let (link, _h) = spawn_mux(
            sink.clone(),
            Pending,
            Sealer::new(&[1u8; 32]),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        // 交互队列容量 256：填满后 try_send 失败，async send 会阻塞
        let mut accepted = 0;
        for i in 0..1000 {
            if link.tx.try_send(term_frame(i)).is_err() {
                break;
            }
            accepted += 1;
        }
        assert!(
            accepted <= crate::link::INTERACTIVE_QUEUE + 1,
            "有界队列应当拒绝，实际接受 {accepted}"
        );
        assert!(accepted >= crate::link::INTERACTIVE_QUEUE);
        let blocked = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            link.tx.send(term_frame(0)),
        )
        .await;
        assert!(blocked.is_err(), "队列满时 send 应当等待");
        // 批量队列同理
        let mut bulk_ok = 0;
        for i in 0..100 {
            match tokio::time::timeout(
                std::time::Duration::from_millis(20),
                link.tx.send_bulk(bulk_frame(i)),
            )
            .await
            {
                Ok(Ok(())) => bulk_ok += 1,
                _ => break,
            }
        }
        assert!(bulk_ok <= crate::link::BULK_QUEUE + 1);
        // 放开后全部排空
        sink.open_gate();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(link.tx.try_send(term_frame(1)).is_ok());
    }

    #[tokio::test]
    async fn incoming_backpressure_stops_reading() {
        // 上层不取 rx：incoming 通道填满后停止从 stream 拉取
        let key = [3u8; 32];
        let pulled = Arc::new(Mutex::new(0usize));
        struct Src {
            sealer: Sealer,
            pulled: Arc<Mutex<usize>>,
            q: VecDeque<u64>,
        }
        impl Stream for Src {
            type Item = Result<Vec<u8>, RelayError>;
            fn poll_next(
                mut self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Option<Self::Item>> {
                match self.q.pop_front() {
                    Some(i) => {
                        *self.pulled.lock().unwrap() += 1;
                        let rec = self.sealer.seal(&term_frame(i).encode_to_vec()).unwrap();
                        Poll::Ready(Some(Ok(rec)))
                    }
                    None => Poll::Pending,
                }
            }
        }
        let src = Src {
            sealer: Sealer::new(&key),
            pulled: pulled.clone(),
            q: (0..5000).collect(),
        };
        let (mut link, _h) = spawn_mux(
            TestSink::new(true),
            src,
            Sealer::new(&[9u8; 32]),
            Sealer::new(&key),
            peer(),
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let n = *pulled.lock().unwrap();
        assert!(
            n <= crate::link::INCOMING_QUEUE + 2,
            "应因背压停止拉取，实际拉取 {n}"
        );
        // 开始消费后继续
        let f = link.rx.recv().await.unwrap();
        assert!(matches!(f.body, Some(pb::frame::Body::TermOutput(o)) if o.seq == 0));
    }

    #[tokio::test]
    async fn oversized_frame_closes_session() {
        let sink = TestSink::new(true);
        let (link, mut h) = spawn_mux(
            sink,
            Pending,
            Sealer::new(&[1u8; 32]),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        let big = Frame {
            channel: 1,
            body: Some(pb::frame::Body::TermOutput(pb::TermOutput {
                seq: 0,
                data: vec![0u8; MAX_RECORD],
            })),
        };
        link.tx.send(big).await.unwrap();
        let info = tokio::time::timeout(std::time::Duration::from_secs(2), h.wait_closed())
            .await
            .unwrap();
        assert!(info.local);
    }

    #[tokio::test]
    async fn bad_ciphertext_closes_and_ends_rx() {
        let key = [4u8; 32];
        let mut s = Sealer::new(&key);
        let mut rec = s.seal(&term_frame(1).encode_to_vec()).unwrap();
        *rec.last_mut().unwrap() ^= 1;
        let stream =
            futures_util::stream::iter(vec![Ok(rec)]).chain(futures_util::stream::pending());
        let (mut link, mut h) = spawn_mux(
            TestSink::new(true),
            Box::pin(stream),
            Sealer::new(&[9u8; 32]),
            Sealer::new(&key),
            peer(),
        );
        assert!(link.rx.recv().await.is_none());
        let info = h.wait_closed().await;
        assert!(info.reason.contains("校验"), "{info:?}");
    }

    #[tokio::test]
    async fn relay_close_code_is_reported() {
        let stream = futures_util::stream::iter(vec![Err(RelayError::Closed {
            code: Some(4003),
            reason: "peer gone".into(),
        })]);
        let (mut link, mut h) = spawn_mux(
            TestSink::new(true),
            Box::pin(stream),
            Sealer::new(&[1u8; 32]),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        assert!(link.rx.recv().await.is_none());
        assert_eq!(h.wait_closed().await.code, Some(4003));
    }

    #[tokio::test]
    async fn dropping_link_flushes_queued_frames_then_closes() {
        let key = [1u8; 32];
        let sink = TestSink::new(true);
        let (link, mut h) = spawn_mux(
            sink.clone(),
            Pending,
            Sealer::new(&key),
            Sealer::new(&[2u8; 32]),
            peer(),
        );
        for i in 0..5 {
            link.tx.send(term_frame(i)).await.unwrap();
        }
        drop(link);
        let info = tokio::time::timeout(std::time::Duration::from_secs(2), h.wait_closed())
            .await
            .unwrap();
        assert!(info.local);
        assert_eq!(sink.written.lock().unwrap().len(), 5);
    }
}
