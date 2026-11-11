//! 加密记录层（《开发指南.md》T29）：ChaCha20-Poly1305，nonce 为每个方向的计数器。
//!
//! 记录格式：`0x02 || AEAD 密文（含 16 字节标签）`，AAD 为 `[0x02]`。
//! nonce：96 位，高 32 位为 0，低 64 位是该方向的记录计数器（从 0 递增，不随记录传输）。
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use rterm_proto::REC_DATA;

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("不是数据记录")]
    NotData,
    #[error("加密失败")]
    Seal,
    #[error("解密失败")]
    Open,
    #[error("记录计数器耗尽")]
    CounterExhausted,
}

/// 单方向的加密器或解密器。每个方向各用一个，密钥不同。
/// 加密和发送必须在同一个任务里按顺序进行，否则计数器顺序与发送顺序不一致，对方解密失败。
pub struct Sealer {
    cipher: ChaCha20Poly1305,
    counter: u64,
}

impl Sealer {
    pub fn new(key: &[u8; 32]) -> Self {
        // 32 字节密钥长度固定，new 不会失败
        Self {
            cipher: ChaCha20Poly1305::new(key.into()),
            counter: 0,
        }
    }

    fn next_nonce(&mut self) -> Result<[u8; 12], RecordError> {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or(RecordError::CounterExhausted)?;
        Ok(n)
    }

    /// 明文 -> 一条完整的记录（首字节 0x02 + 密文）
    pub fn seal(&mut self, plain: &[u8]) -> Result<Vec<u8>, RecordError> {
        let nonce = self.next_nonce()?;
        let ct = self
            .cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: plain,
                    aad: &[REC_DATA],
                },
            )
            .map_err(|_| RecordError::Seal)?;
        let mut rec = Vec::with_capacity(1 + ct.len());
        rec.push(REC_DATA);
        rec.extend_from_slice(&ct);
        Ok(rec)
    }

    /// 一条记录 -> 明文。失败后不可继续使用（计数器已前进），调用方应立即关闭连接。
    pub fn open(&mut self, record: &[u8]) -> Result<Vec<u8>, RecordError> {
        if record.first() != Some(&REC_DATA) {
            return Err(RecordError::NotData);
        }
        let nonce = self.next_nonce()?;
        self.cipher
            .decrypt(
                (&nonce).into(),
                Payload {
                    msg: &record[1..],
                    aad: &[REC_DATA],
                },
            )
            .map_err(|_| RecordError::Open)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thousand_records_in_order() {
        let key = [7u8; 32];
        let mut tx = Sealer::new(&key);
        let mut rx = Sealer::new(&key);
        for i in 0..1000u32 {
            let plain = format!("消息 {i}")
                .repeat((i % 7 + 1) as usize)
                .into_bytes();
            let rec = tx.seal(&plain).unwrap();
            assert_eq!(rec[0], 0x02);
            assert_eq!(rx.open(&rec).unwrap(), plain);
        }
    }

    #[test]
    fn any_byte_flip_fails() {
        let key = [1u8; 32];
        let rec = Sealer::new(&key).seal(b"secret terminal output").unwrap();
        for i in 1..rec.len() {
            let mut bad = rec.clone();
            bad[i] ^= 0x01;
            assert!(
                Sealer::new(&key).open(&bad).is_err(),
                "第 {i} 字节被改动应失败"
            );
        }
    }

    #[test]
    fn type_byte_must_be_data() {
        let key = [1u8; 32];
        let mut rec = Sealer::new(&key).seal(b"x").unwrap();
        rec[0] = 0x01;
        assert!(matches!(
            Sealer::new(&key).open(&rec),
            Err(RecordError::NotData)
        ));
    }

    #[test]
    fn reordered_records_fail() {
        let key = [3u8; 32];
        let mut tx = Sealer::new(&key);
        let _r1 = tx.seal(b"one").unwrap();
        let r2 = tx.seal(b"two").unwrap();
        let r3 = tx.seal(b"three").unwrap();
        let mut rx = Sealer::new(&key);
        assert!(rx.open(&r3).is_err());
        let mut rx = Sealer::new(&key);
        let _ = rx.open(&_r1).unwrap();
        assert!(rx.open(&r3).is_err()); // 跳过第 2 条
        let mut rx = Sealer::new(&key);
        let _ = rx.open(&_r1).unwrap();
        assert_eq!(rx.open(&r2).unwrap(), b"two");
        assert_eq!(rx.open(&r3).unwrap(), b"three");
    }

    #[test]
    fn replay_and_wrong_key_fail() {
        let mut tx = Sealer::new(&[5u8; 32]);
        let r = tx.seal(b"a").unwrap();
        let mut rx = Sealer::new(&[5u8; 32]);
        assert!(rx.open(&r).is_ok());
        assert!(rx.open(&r).is_err()); // 重放
        assert!(Sealer::new(&[6u8; 32]).open(&r).is_err());
    }

    #[test]
    fn nonces_differ_per_record() {
        let mut tx = Sealer::new(&[9u8; 32]);
        let a = tx.seal(b"same").unwrap();
        let b = tx.seal(b"same").unwrap();
        assert_ne!(a, b);
    }
}
