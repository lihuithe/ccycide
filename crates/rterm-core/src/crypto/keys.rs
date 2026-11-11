//! 握手用的密钥派生与确认（《开发指南.md》T28，【已验证】代码，算法与顺序不得改动）。
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, thiserror::Error)]
#[error("密钥派生失败")]
pub struct KdfError;

/// 握手得到的三把密钥。
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SessionKeys {
    /// 主控端 -> 被控端 方向的加密密钥
    pub c2h: [u8; 32],
    /// 被控端 -> 主控端
    pub h2c: [u8; 32],
    /// 确认用
    pub confirm: [u8; 32],
}

pub fn derive_keys(shared: &[u8], transcript: &[u8; 32]) -> Result<SessionKeys, KdfError> {
    let hk = Hkdf::<Sha256>::new(Some(transcript), shared);
    let mut k = SessionKeys {
        c2h: [0; 32],
        h2c: [0; 32],
        confirm: [0; 32],
    };
    hk.expand(b"rterm v1 c2h", &mut k.c2h)
        .map_err(|_| KdfError)?;
    hk.expand(b"rterm v1 h2c", &mut k.h2c)
        .map_err(|_| KdfError)?;
    hk.expand(b"rterm v1 confirm", &mut k.confirm)
        .map_err(|_| KdfError)?;
    Ok(k)
}

/// role：主控端用 b'c'，被控端用 b'h'
pub fn confirm_mac(confirm_key: &[u8; 32], role: u8, transcript: &[u8; 32]) -> Vec<u8> {
    // HMAC 接受任意长度密钥，new_from_slice 不会失败
    let mut mac = match <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(confirm_key) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    mac.update(&[role]);
    mac.update(transcript);
    mac.finalize().into_bytes().to_vec()
}

pub fn verify_mac(confirm_key: &[u8; 32], role: u8, transcript: &[u8; 32], got: &[u8]) -> bool {
    let Ok(mut mac) = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(confirm_key) else {
        return false;
    };
    mac.update(&[role]);
    mac.update(transcript);
    mac.verify_slice(got).is_ok() // 常数时间比较，不要自己用 == 比
}

/// transcript 的输入。
pub struct TranscriptInput<'a> {
    pub proto_ver: u32,
    pub session_id: &'a str,
    pub controller_code: &'a str,
    pub host_code: &'a str,
    pub spake_msg_a: &'a [u8],
    pub spake_msg_b: &'a [u8],
    pub controller_pubkey: &'a [u8],
    pub host_pubkey: &'a [u8],
    pub nonce_c: &'a [u8],
    pub nonce_h: &'a [u8],
}

/// 每个字段前面加 4 字节的长度（大端），再拼接，顺序固定。
pub fn transcript(i: &TranscriptInput<'_>) -> [u8; 32] {
    let ver = i.proto_ver.to_be_bytes();
    let parts: [&[u8]; 10] = [
        &ver,                         // 1. 协议版本，u32 大端
        i.session_id.as_bytes(),      // 2. 信令下发的 session_id
        i.controller_code.as_bytes(), // 3. 主控端设备码
        i.host_code.as_bytes(),       // 4. 被控端设备码
        i.spake_msg_a,                // 5.
        i.spake_msg_b,                // 6.
        i.controller_pubkey,          // 7. 32 字节
        i.host_pubkey,                // 8. 32 字节
        i.nonce_c,                    // 9. 主控端的随机数，16 字节
        i.nonce_h,                    // 10. 被控端的随机数，16 字节
    ];
    let mut h = Sha256::new();
    for part in parts {
        h.update((part.len() as u32).to_be_bytes());
        h.update(part);
    }
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ti<'a>(sid: &'a str, nonce_h: &'a [u8]) -> TranscriptInput<'a> {
        TranscriptInput {
            proto_ver: 1,
            session_id: sid,
            controller_code: "111111111",
            host_code: "222222222",
            spake_msg_a: &[1; 33],
            spake_msg_b: &[2; 33],
            controller_pubkey: &[3; 32],
            host_pubkey: &[4; 32],
            nonce_c: &[5; 16],
            nonce_h,
        }
    }

    #[test]
    fn transcript_binds_every_field() {
        let a = transcript(&ti("S1", &[6; 16]));
        assert_eq!(a, transcript(&ti("S1", &[6; 16])));
        assert_ne!(a, transcript(&ti("S2", &[6; 16])));
        assert_ne!(a, transcript(&ti("S1", &[7; 16])));
    }

    #[test]
    fn keys_distinct_and_mac_roles() {
        let t = [9u8; 32];
        let k = derive_keys(b"shared secret", &t).unwrap();
        assert_ne!(k.c2h, k.h2c);
        assert_ne!(k.c2h, k.confirm);
        let k2 = derive_keys(b"shared secret", &[8u8; 32]).unwrap();
        assert_ne!(k.c2h, k2.c2h);

        let m = confirm_mac(&k.confirm, b'c', &t);
        assert!(verify_mac(&k.confirm, b'c', &t, &m));
        assert!(
            !verify_mac(&k.confirm, b'h', &t, &m),
            "角色不同 mac 不同，防反射"
        );
        assert!(!verify_mac(&k2.confirm, b'c', &t, &m));
        assert!(!verify_mac(&k.confirm, b'c', &t, &m[..31]));
    }
}
