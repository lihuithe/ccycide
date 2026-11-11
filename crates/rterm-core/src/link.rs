//! 网络层与被控端/主控端之间的边界：一条已建立、已加密的会话，对上层只呈现为 Frame 流。
//!
//! - 网络层（mux）从 `LinkEnds` 取出两个发送队列，按优先级调度（交互队列优先，批量队列仅在交互队列空时发一块），
//!   加密后写入中继；收到的记录解密、解码后送进 `rx`。
//! - 被控端 / 主控端只使用 `Link`，不关心加密和 WebSocket。
use rterm_proto::pb::Frame;
use tokio::sync::mpsc;

/// 发送端。`send` 进交互队列（控制帧、终端输入输出），`send_bulk` 进批量队列（文件块）。
/// 队列都是有界的，满了发送方等待（背压）。
#[derive(Clone)]
pub struct FrameTx {
    pub interactive: mpsc::Sender<Frame>,
    pub bulk: mpsc::Sender<Frame>,
}

#[derive(Debug, thiserror::Error)]
#[error("会话已关闭")]
pub struct LinkClosed;

impl FrameTx {
    pub async fn send(&self, f: Frame) -> Result<(), LinkClosed> {
        self.interactive.send(f).await.map_err(|_| LinkClosed)
    }
    pub async fn send_bulk(&self, f: Frame) -> Result<(), LinkClosed> {
        self.bulk.send(f).await.map_err(|_| LinkClosed)
    }
    pub fn try_send(&self, f: Frame) -> Result<(), LinkClosed> {
        self.interactive.try_send(f).map_err(|_| LinkClosed)
    }
}

/// 对端信息（握手完成后得到）。
#[derive(Debug, Clone, Default)]
pub struct PeerInfo {
    pub device_code: String,
    pub platform: String,
    pub public_key: Vec<u8>,
    pub proto_ver: u32,
}

/// 上层使用的一端。`rx` 收到 None 表示会话已断开。
pub struct Link {
    pub tx: FrameTx,
    pub rx: mpsc::Receiver<Frame>,
    pub peer: PeerInfo,
}

/// 网络层使用的另一端（mux 调度器持有）。
pub struct LinkEnds {
    pub interactive_rx: mpsc::Receiver<Frame>,
    pub bulk_rx: mpsc::Receiver<Frame>,
    pub incoming_tx: mpsc::Sender<Frame>,
}

pub const INTERACTIVE_QUEUE: usize = 256;
pub const BULK_QUEUE: usize = 32;
pub const INCOMING_QUEUE: usize = 256;

/// 创建一对相连的端点。用于网络层，也用于测试（可以把两个 Link 直接对接，不经过网络）。
pub fn link_pair(peer: PeerInfo) -> (Link, LinkEnds) {
    let (itx, irx) = mpsc::channel(INTERACTIVE_QUEUE);
    let (btx, brx) = mpsc::channel(BULK_QUEUE);
    let (intx, inrx) = mpsc::channel(INCOMING_QUEUE);
    (
        Link {
            tx: FrameTx {
                interactive: itx,
                bulk: btx,
            },
            rx: inrx,
            peer,
        },
        LinkEnds {
            interactive_rx: irx,
            bulk_rx: brx,
            incoming_tx: intx,
        },
    )
}

/// 测试辅助：造出两个直接相连的 Link（a 发的 Frame 出现在 b.rx，反之亦然），不经过加密和网络。
/// 必须在 tokio 运行时内调用。交互队列优先于批量队列。
pub fn loopback_pair(peer_a: PeerInfo, peer_b: PeerInfo) -> (Link, Link) {
    let (a, a_ends) = link_pair(peer_b);
    let (b, b_ends) = link_pair(peer_a);
    spawn_pump(a_ends.interactive_rx, a_ends.bulk_rx, b_ends.incoming_tx);
    spawn_pump(b_ends.interactive_rx, b_ends.bulk_rx, a_ends.incoming_tx);
    (a, b)
}

fn spawn_pump(
    mut irx: mpsc::Receiver<Frame>,
    mut brx: mpsc::Receiver<Frame>,
    dest: mpsc::Sender<Frame>,
) {
    tokio::spawn(async move {
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
    });
}

/// 被控端的口令来源（由 host/guard.rs 实现，由网络层握手时调用）。
/// `kind`：0 = 临时密码，1 = 固定密码（对应 `PakeInit.password_kind`）。
/// 返回 `Argon2id(密码, salt="rterm-v1"||本机设备码)` 的 32 字节派生值；没有该类密码时返回 None。
pub trait HostPasswords: Send + Sync {
    fn pw_key(&self, kind: u32) -> Option<[u8; 32]>;
}
