//! 终端输出的合并（《实现方案.md》5.7.1）。
//!
//! 这里只有纯数据结构，不碰 Tauri，便于单元测试：
//! - [`Coalescer`]：同一终端的连续输出每 8ms 或攒够 64KB 发一次，减少跨进程调用次数；
//! - [`encode_frame`]：Channel 帧格式 `[8 字节 u64 大端 seq][数据]`。
use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// 合并窗口。
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// 单帧数据上限（不含 8 字节帧头）。
pub const MAX_FRAME: usize = 64 * 1024;

/// 编码成前端 `parseOutputFrame` 能解析的原始字节。
pub fn encode_frame(seq: u64, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + data.len());
    v.extend_from_slice(&seq.to_be_bytes());
    v.extend_from_slice(data);
    v
}

struct Buf {
    seq: u64,
    data: Vec<u8>,
    since: Instant,
}

/// 按键合并连续输出。
pub struct Coalescer<K> {
    bufs: HashMap<K, Buf>,
    interval: Duration,
    max: usize,
}

impl<K: Hash + Eq + Clone> Coalescer<K> {
    pub fn new(interval: Duration, max: usize) -> Self {
        Self {
            bufs: HashMap::new(),
            interval,
            max: max.max(1),
        }
    }

    /// 追加一段输出，返回需要立即发出的帧 `(seq, 数据)`：偏移不连续时先刷出旧缓冲；缓冲满 `max` 即发。
    pub fn push(&mut self, key: &K, seq: u64, data: &[u8], now: Instant) -> Vec<(u64, Vec<u8>)> {
        let mut out = Vec::new();
        let contiguous = self
            .bufs
            .get(key)
            .is_none_or(|b| b.seq + b.data.len() as u64 == seq);
        if !contiguous {
            if let Some(b) = self.bufs.remove(key) {
                out.push((b.seq, b.data));
            }
        }
        let mut seq = seq;
        let mut rest = data;
        while !rest.is_empty() {
            let b = self.bufs.entry(key.clone()).or_insert_with(|| Buf {
                seq,
                data: Vec::new(),
                since: now,
            });
            let n = (self.max - b.data.len()).min(rest.len());
            b.data.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
            seq += n as u64;
            if b.data.len() >= self.max {
                if let Some(b) = self.bufs.remove(key) {
                    out.push((b.seq, b.data));
                }
            }
        }
        out
    }

    /// 取出已经攒够时间的缓冲。
    pub fn take_due(&mut self, now: Instant) -> Vec<(K, u64, Vec<u8>)> {
        let due: Vec<K> = self
            .bufs
            .iter()
            .filter(|(_, b)| now.duration_since(b.since) >= self.interval)
            .map(|(k, _)| k.clone())
            .collect();
        due.into_iter()
            .filter_map(|k| self.bufs.remove(&k).map(|b| (k, b.seq, b.data)))
            .collect()
    }

    /// 立即取出某个键的缓冲（终端退出、状态变化前保证顺序）。
    pub fn take(&mut self, key: &K) -> Option<(u64, Vec<u8>)> {
        self.bufs.remove(key).map(|b| (b.seq, b.data))
    }

    /// 丢弃满足条件的键的缓冲。
    pub fn discard(&mut self, pred: impl Fn(&K) -> bool) {
        self.bufs.retain(|k, _| !pred(k));
    }

    /// 最早需要刷出的时刻。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.bufs.values().map(|b| b.since + self.interval).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn frame_header_is_big_endian_seq() {
        let f = encode_frame(0x0102_0304_0506_0708, b"ab");
        assert_eq!(&f[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&f[8..], b"ab");
    }

    #[test]
    fn merges_contiguous_until_due() {
        let mut c = Coalescer::new(Duration::from_millis(8), 1024);
        let now = t0();
        assert!(c.push(&1u8, 0, b"hello", now).is_empty());
        assert!(c.push(&1u8, 5, b" world", now).is_empty());
        assert!(c.take_due(now).is_empty());
        let due = c.take_due(now + Duration::from_millis(9));
        assert_eq!(due, vec![(1u8, 0, b"hello world".to_vec())]);
        assert!(c.next_deadline().is_none());
    }

    #[test]
    fn flushes_on_gap() {
        let mut c = Coalescer::new(Duration::from_millis(8), 1024);
        let now = t0();
        c.push(&1u8, 0, b"abc", now);
        let out = c.push(&1u8, 100, b"xyz", now);
        assert_eq!(out, vec![(0, b"abc".to_vec())]);
        assert_eq!(c.take(&1u8), Some((100, b"xyz".to_vec())));
    }

    #[test]
    fn splits_at_max_frame() {
        let mut c = Coalescer::new(Duration::from_millis(8), 4);
        let out = c.push(&1u8, 10, b"0123456789", t0());
        assert_eq!(out, vec![(10, b"0123".to_vec()), (14, b"4567".to_vec())]);
        assert_eq!(c.take(&1u8), Some((18, b"89".to_vec())));
    }

    #[test]
    fn keys_are_independent() {
        let mut c = Coalescer::new(Duration::from_millis(8), 1024);
        let now = t0();
        c.push(&1u8, 0, b"a", now);
        c.push(&2u8, 0, b"b", now);
        assert_eq!(c.take(&1u8), Some((0, b"a".to_vec())));
        c.discard(|k| *k == 2);
        assert!(c.take(&2u8).is_none());
    }
}
