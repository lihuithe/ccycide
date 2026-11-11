//! 主控端的终端代理（《实现方案.md》5.6、3.8，《开发指南.md》T14、T23）。
//!
//! 对每个终端维护：
//! - `received`：已经转成事件交给界面的输出流偏移（重连后作为 `TermAttach.last_seq`）；
//! - `rendered`：界面通过 `term_ack` 告知的已渲染偏移（用于流控确认）；
//! - 通道号：被控端分配，只在当前这条连接内有效，重连后要重新附着才有新的通道号。
//!
//! 本文件只有纯数据结构和去重逻辑，不做任何 IO，便于单元测试。
use std::collections::HashMap;
use std::sync::Mutex;

use rterm_proto::pb;
use tokio::sync::Notify;

use crate::events::{TermId, TermModes};

/// 终端复位序列（`ESC c`）。被控端在回放无法衔接时先发它。
pub const RESET_SEQ: &[u8] = b"\x1bc";

/// 终端尺寸（列、行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u32,
    pub rows: u32,
}

impl TermSize {
    pub fn new(cols: u32, rows: u32) -> Self {
        Self { cols, rows }
    }
}

impl Default for TermSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

/// 打开终端的参数。
#[derive(Debug, Clone, Default)]
pub struct TermOpenOptions {
    pub profile: TermProfile,
    /// 空 = 被控端默认 shell
    pub shell_id: String,
    /// 空 = 被控端用户主目录
    pub cwd: String,
    pub size: TermSize,
    /// `TermProfile::Custom` 时使用
    pub command: String,
    /// `TermProfile::Claude` 时的启动参数（《实现方案.md》18.7）
    pub launch: Option<pb::LaunchOptions>,
}

impl TermOpenOptions {
    /// 普通 shell 终端。
    pub fn shell(size: TermSize) -> Self {
        Self {
            size,
            ..Self::default()
        }
    }

    /// 带 Claude Code 启动参数的终端。
    pub fn claude(size: TermSize, cwd: impl Into<String>, launch: pb::LaunchOptions) -> Self {
        Self {
            profile: TermProfile::Claude,
            cwd: cwd.into(),
            size,
            launch: Some(launch),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TermProfile {
    #[default]
    Shell,
    Claude,
    Custom,
}

impl From<TermProfile> for pb::Profile {
    fn from(p: TermProfile) -> Self {
        match p {
            TermProfile::Shell => pb::Profile::Shell,
            TermProfile::Claude => pb::Profile::Claude,
            TermProfile::Custom => pb::Profile::Custom,
        }
    }
}

/// 输出去重结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Dedup {
    /// 整段都是已收到的数据，丢弃
    Drop,
    /// 需要交给界面的数据（可能已被裁掉与已收部分重叠的前缀）
    Emit { seq: u64, data: Vec<u8> },
}

/// 按偏移裁剪一段输出。
///
/// - `end <= received`：整段重复，丢弃；
/// - `seq < received < end`：与已收部分重叠，裁掉前面的重叠；
/// - `seq >= received`：正常衔接（`seq > received` 说明被控端的缓冲已覆盖了中间的数据，原样交出）；
/// - 例外：附着后的第一段如果恰好是复位序列且跨过 `received`，原样交出，
///   否则裁剪会留下半个转义序列（被控端的复位帧 `seq` = 回放起点 − 2）。
pub fn dedup(received: u64, seq: u64, mut data: Vec<u8>, first_after_attach: bool) -> Dedup {
    if data.is_empty() {
        return Dedup::Drop;
    }
    let end = seq.saturating_add(data.len() as u64);
    if first_after_attach && data == RESET_SEQ && seq < received && end > received {
        return Dedup::Emit { seq, data };
    }
    if end <= received {
        return Dedup::Drop;
    }
    if seq >= received {
        return Dedup::Emit { seq, data };
    }
    let skip = (received - seq) as usize;
    data.drain(..skip);
    Dedup::Emit {
        seq: received,
        data,
    }
}

/// 把被控端的 `TermState` 转成界面事件里的模式结构。
pub fn modes_from_pb(s: &pb::TermState) -> TermModes {
    TermModes {
        bracketed_paste: s.bracketed_paste,
        alt_screen: s.alt_screen,
        app_cursor: s.app_cursor,
        mouse: s.mouse,
        title: s.title.clone(),
    }
}

/// 一个终端在主控端的状态。
#[derive(Debug, Clone)]
pub struct TermEntry {
    pub id: TermId,
    /// 当前连接里的通道号；未附着时为 None
    pub channel: Option<u32>,
    pub size: TermSize,
    /// 已交给界面的输出偏移（下一次期望的 seq）
    pub received: u64,
    /// 界面已渲染到的偏移
    pub rendered: u64,
    /// 已经告知被控端的确认偏移（附着时被控端以 `last_seq` 为基准）
    pub acked_sent: u64,
    pub exited: bool,
    /// 被另一个会话接管（收到 `TERM_DETACHED`）；重连时不再自动附着
    pub taken_elsewhere: bool,
    /// 附着时被拒绝（`TERM_BUSY`，正被其他设备使用）；不抢占，用户再次 `attach_term` 或下次重连时才会再试
    pub busy: bool,
    /// 刚附着，还没收到第一段输出
    pub fresh_attach: bool,
}

impl TermEntry {
    fn new(id: TermId, size: TermSize) -> Self {
        Self {
            id,
            channel: None,
            size,
            received: 0,
            rendered: 0,
            acked_sent: 0,
            exited: false,
            taken_elsewhere: false,
            busy: false,
            fresh_attach: false,
        }
    }
}

/// 一台被控端上本会话关心的全部终端。
#[derive(Debug, Default)]
pub struct TermTable {
    by_id: HashMap<TermId, TermEntry>,
    by_channel: HashMap<u32, TermId>,
}

impl TermTable {
    pub fn get(&self, id: &str) -> Option<&TermEntry> {
        self.by_id.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut TermEntry> {
        self.by_id.get_mut(id)
    }

    pub fn id_of_channel(&self, ch: u32) -> Option<&TermId> {
        self.by_channel.get(&ch)
    }

    pub fn ids(&self) -> Vec<TermId> {
        self.by_id.keys().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// 附着成功（`TermOpened`）：登记通道号。终端不存在则新建（偏移从 0 开始）。
    pub fn on_attached(&mut self, id: &str, channel: u32, size: TermSize) {
        // 同一终端的旧通道作废
        if let Some(old) = self.by_id.get(id).and_then(|e| e.channel) {
            self.by_channel.remove(&old);
        }
        let e = self
            .by_id
            .entry(id.to_string())
            .or_insert_with(|| TermEntry::new(id.to_string(), size));
        e.channel = Some(channel);
        e.size = size;
        e.fresh_attach = true;
        e.taken_elsewhere = false;
        e.busy = false;
        // 被控端以 last_seq（= received）作为确认基准
        e.acked_sent = e.received;
        self.by_channel.insert(channel, id.to_string());
    }

    pub fn remove(&mut self, id: &str) -> Option<TermEntry> {
        let e = self.by_id.remove(id)?;
        if let Some(ch) = e.channel {
            self.by_channel.remove(&ch);
        }
        Some(e)
    }

    /// 连接断开：所有通道号作废，终端记录保留（偏移用于重连续传）。
    pub fn drop_channels(&mut self) {
        self.by_channel.clear();
        for e in self.by_id.values_mut() {
            e.channel = None;
            e.fresh_attach = false;
        }
    }

    /// 被另一个会话接管：解除附着，记下原因。
    pub fn mark_taken(&mut self, id: &str) {
        if let Some(e) = self.by_id.get_mut(id) {
            if let Some(ch) = e.channel.take() {
                self.by_channel.remove(&ch);
            }
            e.taken_elsewhere = true;
        }
    }

    /// 附着被拒绝（`TERM_BUSY`）：保留记录和偏移，标记为被占用。
    pub fn mark_busy(&mut self, id: &str) {
        if let Some(e) = self.by_id.get_mut(id) {
            e.busy = true;
        }
    }

    /// 重连后需要重新附着的终端：(id, last_seq, 尺寸)。已退出和被接管的不在其中。
    pub fn resumable(&self) -> Vec<(TermId, u64, TermSize)> {
        let mut v: Vec<_> = self
            .by_id
            .values()
            .filter(|e| !e.exited && !e.taken_elsewhere)
            .map(|e| (e.id.clone(), e.received, e.size))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    /// 收到一段输出：按偏移去重后返回需要交给界面的 (终端, seq, 数据)。
    pub fn on_output(
        &mut self,
        ch: u32,
        seq: u64,
        data: Vec<u8>,
    ) -> Option<(TermId, u64, Vec<u8>)> {
        let id = self.by_channel.get(&ch)?.clone();
        let e = self.by_id.get_mut(&id)?;
        let first = std::mem::take(&mut e.fresh_attach);
        match dedup(e.received, seq, data, first) {
            Dedup::Drop => None,
            Dedup::Emit { seq, data } => {
                e.received = seq + data.len() as u64;
                Some((id, seq, data))
            }
        }
    }

    /// 界面确认已渲染到 `consumed`。返回需要发给被控端的 (通道号, 确认偏移)；没有新进展或未附着时返回 None。
    pub fn note_rendered(&mut self, id: &str, consumed: u64) -> Option<(u32, u64)> {
        let e = self.by_id.get_mut(id)?;
        // 不能确认还没收到的数据
        let consumed = consumed.min(e.received);
        if consumed > e.rendered {
            e.rendered = consumed;
        }
        let ch = e.channel?;
        if e.rendered > e.acked_sent {
            e.acked_sent = e.rendered;
            Some((ch, e.rendered))
        } else {
            None
        }
    }
}

/// 界面确认偏移的汇集处。`term_ack` 是同步调用，只记下最大值并唤醒会话任务，
/// 因此即使会话任务正忙于向（慢速的）事件接收方投递事件，界面处理事件时调用 `term_ack` 也不会死锁。
#[derive(Default)]
pub struct AckBoard {
    map: Mutex<HashMap<TermId, u64>>,
    pub(crate) notify: Notify,
}

impl AckBoard {
    pub fn put(&self, term: &str, consumed: u64) {
        {
            let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
            let v = m.entry(term.to_string()).or_insert(0);
            if consumed > *v {
                *v = consumed;
            }
        }
        self.notify.notify_one();
    }

    pub fn take(&self) -> HashMap<TermId, u64> {
        std::mem::take(&mut *self.map.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emit(seq: u64, d: &[u8]) -> Dedup {
        Dedup::Emit {
            seq,
            data: d.to_vec(),
        }
    }

    #[test]
    fn dedup_contiguous() {
        assert_eq!(dedup(10, 10, b"abc".to_vec(), false), emit(10, b"abc"));
    }

    #[test]
    fn dedup_full_duplicate_dropped() {
        assert_eq!(dedup(10, 5, b"12345".to_vec(), false), Dedup::Drop);
        assert_eq!(dedup(10, 0, b"12345".to_vec(), false), Dedup::Drop);
    }

    #[test]
    fn dedup_partial_overlap_trimmed() {
        assert_eq!(dedup(10, 8, b"abcde".to_vec(), false), emit(10, b"cde"));
    }

    #[test]
    fn dedup_gap_passes_through() {
        assert_eq!(dedup(10, 20, b"xy".to_vec(), false), emit(20, b"xy"));
    }

    #[test]
    fn dedup_empty_dropped() {
        assert_eq!(dedup(0, 0, Vec::new(), false), Dedup::Drop);
    }

    #[test]
    fn dedup_reset_straddling_received_is_kept_whole() {
        // received = 99，被控端回放起点 100，复位帧 seq = 98，长度 2
        assert_eq!(dedup(99, 98, RESET_SEQ.to_vec(), true), emit(98, RESET_SEQ));
        // 不是附着后的第一段：按普通重叠裁剪
        assert_eq!(dedup(99, 98, RESET_SEQ.to_vec(), false), emit(99, b"c"));
        // 复位帧完全在 received 之前（正常情形 seq >= received 也直接交出）
        assert_eq!(dedup(50, 98, RESET_SEQ.to_vec(), true), emit(98, RESET_SEQ));
    }

    #[test]
    fn table_output_tracks_received_and_ignores_unknown_channel() {
        let mut t = TermTable::default();
        t.on_attached("t1", 1, TermSize::default());
        assert!(t.on_output(9, 0, b"x".to_vec()).is_none());
        assert_eq!(t.on_output(1, 0, b"hello".to_vec()).map(|x| x.1), Some(0));
        assert_eq!(t.get("t1").map(|e| e.received), Some(5));
        // 重叠
        let r = t.on_output(1, 3, b"loWorld".to_vec());
        assert_eq!(r.map(|x| (x.1, x.2)), Some((5, b"World".to_vec())));
        assert_eq!(t.get("t1").map(|e| e.received), Some(10));
        // 重复
        assert!(t.on_output(1, 0, b"hello".to_vec()).is_none());
    }

    #[test]
    fn table_reattach_keeps_offsets_and_swaps_channel() {
        let mut t = TermTable::default();
        t.on_attached("t1", 1, TermSize::default());
        t.on_output(1, 0, vec![b'a'; 100]);
        t.drop_channels();
        assert!(t.id_of_channel(1).is_none());
        assert_eq!(t.resumable().len(), 1);
        assert_eq!(t.resumable()[0].1, 100);
        t.on_attached("t1", 7, TermSize::new(100, 30));
        assert_eq!(t.id_of_channel(7).map(|s| s.as_str()), Some("t1"));
        let e = t.get("t1");
        assert_eq!(e.map(|e| (e.received, e.acked_sent)), Some((100, 100)));
    }

    #[test]
    fn rendered_clamped_and_monotonic() {
        let mut t = TermTable::default();
        t.on_attached("t1", 1, TermSize::default());
        t.on_output(1, 0, vec![0; 1000]);
        assert_eq!(t.note_rendered("t1", 400), Some((1, 400)));
        // 回退的确认不重复发
        assert_eq!(t.note_rendered("t1", 300), None);
        // 超过 received 的被截到 received
        assert_eq!(t.note_rendered("t1", 5000), Some((1, 1000)));
        assert_eq!(t.get("t1").map(|e| e.rendered), Some(1000));
        // 断开后只记录，不发送
        t.drop_channels();
        t.on_attached("t1", 2, TermSize::default());
        t.drop_channels();
        assert_eq!(t.note_rendered("t1", 1000), None);
    }

    #[test]
    fn exited_and_taken_not_resumable() {
        let mut t = TermTable::default();
        t.on_attached("a", 1, TermSize::default());
        t.on_attached("b", 2, TermSize::default());
        t.on_attached("c", 3, TermSize::default());
        if let Some(e) = t.get_mut("a") {
            e.exited = true;
        }
        t.mark_taken("b");
        let ids: Vec<_> = t.resumable().into_iter().map(|x| x.0).collect();
        assert_eq!(ids, vec!["c".to_string()]);
    }

    #[test]
    fn ack_board_keeps_max() {
        let b = AckBoard::default();
        b.put("t", 10);
        b.put("t", 5);
        b.put("u", 1);
        let m = b.take();
        assert_eq!(m.get("t"), Some(&10));
        assert_eq!(m.get("u"), Some(&1));
        assert!(b.take().is_empty());
    }
}
