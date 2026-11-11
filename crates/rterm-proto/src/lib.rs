//! RTerm 协议类型（protobuf 生成）和记录层常量。

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/rterm.v1.rs"));
}

pub const PROTO_VER: u32 = 1;
pub const MIN_PROTO_VER: u32 = 1;
/// 记录类型：握手（明文）
pub const REC_HANDSHAKE: u8 = 0x01;
/// 记录类型：数据（AEAD 密文）
pub const REC_DATA: u8 = 0x02;

#[cfg(test)]
mod tests {
    use super::pb;
    use prost::Message;

    #[test]
    fn frame_roundtrip() {
        let f = pb::Frame {
            channel: 3,
            body: Some(pb::frame::Body::TermOutput(pb::TermOutput {
                seq: 42,
                data: b"hello".to_vec(),
            })),
        };
        let bytes = f.encode_to_vec();
        let back = pb::Frame::decode(bytes.as_slice()).unwrap();
        assert_eq!(back.channel, 3);
        assert!(matches!(back.body, Some(pb::frame::Body::TermOutput(o)) if o.seq == 42));
    }

    #[test]
    fn unknown_branch_is_none() {
        // 字段号 999 的未知消息：解码后 body 为 None，不报错
        let bytes = [0xBA, 0x3E, 0x00]; // tag(999, LEN) + len 0
        let f = pb::Frame::decode(&bytes[..]).unwrap();
        assert!(f.body.is_none());
    }

    #[test]
    fn handshake_roundtrip() {
        let h = pb::Handshake {
            body: Some(pb::handshake::Body::Init(pb::PakeInit {
                proto_ver: 1,
                spake_msg: vec![1; 33],
                public_key: vec![2; 32],
                nonce: vec![3; 16],
                password_kind: 1,
            })),
        };
        let back = pb::Handshake::decode(h.encode_to_vec().as_slice()).unwrap();
        assert_eq!(back, h);
    }
}
