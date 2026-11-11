//! 握手状态机（纯同步、不碰网络，便于在内存里互相喂消息测试）。
//! 步骤与《开发指南.md》T28 的表一一对应：
//!
//! | 步 | 主控端 | 被控端 |
//! |---|---|---|
//! | 1 | `ControllerStart::begin` -> PakeInit | |
//! | 2 | | `HostStart::on_init` -> PakeResp |
//! | 3 | `ControllerAwaitResp::on_resp` -> PakeConfirm | |
//! | 4 | | `HostAwaitConfirm::on_confirm` -> PakeConfirm（失败 = 密码错误） |
//! | 5 | `ControllerAwaitConfirm::on_confirm` -> 完成 | |
//!
//! 每个状态的方法都消费 self：一次连接只能走一遍，重复/乱序在类型层面就不可能。
use std::sync::Arc;

use rterm_proto::pb::{PakeConfirm, PakeInit, PakeResp};
use rterm_proto::{MIN_PROTO_VER, PROTO_VER};
use spake2::{Ed25519Group, Identity as SpakeId, Password, Spake2};
use zeroize::Zeroizing;

use super::keys::{confirm_mac, derive_keys, transcript, verify_mac, SessionKeys, TranscriptInput};
use crate::identity::{verify_signature, Identity};
use crate::link::HostPasswords;

const NONCE_LEN: usize = 16;
const PUBKEY_LEN: usize = 32;
const SPAKE_MSG_MAX: usize = 64;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum HsError {
    /// 消息格式错误、步骤不对、长度不对
    #[error("握手协议错误: {0}")]
    Protocol(&'static str),
    /// 对端公钥与信令下发的不一致（中继冒充或信令数据被篡改）
    #[error("对端公钥与信令下发的不一致")]
    KeyMismatch,
    /// 被控端：主控端的确认 mac 不对，即密码错误
    #[error("密码错误")]
    BadPassword,
    /// 主控端：被控端的确认 mac 不对（密码错误或连接不安全）
    #[error("确认失败：密码错误或连接不安全")]
    BadConfirm,
    /// 签名校验失败
    #[error("签名校验失败")]
    BadSignature,
    /// 协议版本不兼容
    #[error("协议版本不兼容（对端 {peer}）")]
    Version { peer: u32 },
    #[error("密码学运算失败")]
    Crypto,
}

/// 握手成功后的产出。
pub struct Established {
    pub keys: SessionKeys,
    pub transcript: [u8; 32],
    /// 对端（已用签名认证过的）公钥
    pub peer_public_key: [u8; 32],
    /// 协商的协议版本 = min(双方)
    pub proto_ver: u32,
    pub password_kind: u32,
}

fn check_lens(spake: &[u8], pubkey: &[u8], nonce: &[u8]) -> Result<(), HsError> {
    if spake.is_empty() || spake.len() > SPAKE_MSG_MAX {
        return Err(HsError::Protocol("spake 消息长度非法"));
    }
    if pubkey.len() != PUBKEY_LEN {
        return Err(HsError::Protocol("公钥长度非法"));
    }
    if nonce.len() != NONCE_LEN {
        return Err(HsError::Protocol("随机数长度非法"));
    }
    Ok(())
}

fn random_nonce() -> [u8; NONCE_LEN] {
    rand::random::<[u8; NONCE_LEN]>()
}

// ---------------------------------------------------------------- 主控端

pub struct ControllerCtx {
    pub proto_ver: u32,
    pub session_id: String,
    pub controller_code: String,
    pub host_code: String,
    pub identity: Arc<Identity>,
    /// `derive_pw_key` 的结果
    pub pw_key: Zeroizing<[u8; 32]>,
    /// 0 临时密码，1 固定密码
    pub password_kind: u32,
    /// 信令 `connect.ok` 里的被控端公钥
    pub expected_host_pubkey: Vec<u8>,
}

pub struct ControllerStart;

pub struct ControllerAwaitResp {
    ctx: ControllerCtx,
    state: Spake2<Ed25519Group>,
    spake_a: Vec<u8>,
    nonce_c: [u8; NONCE_LEN],
}

pub struct ControllerAwaitConfirm {
    ctx: ControllerCtx,
    keys: SessionKeys,
    transcript: [u8; 32],
    host_pubkey: [u8; 32],
}

impl ControllerStart {
    /// 步骤 1：`start_a`，产出 PakeInit。
    pub fn begin(ctx: ControllerCtx) -> (ControllerAwaitResp, PakeInit) {
        let (state, spake_a) = Spake2::<Ed25519Group>::start_a(
            &Password::new(&ctx.pw_key[..]),
            &SpakeId::new(ctx.controller_code.as_bytes()),
            &SpakeId::new(ctx.host_code.as_bytes()),
        );
        let nonce_c = random_nonce();
        let init = PakeInit {
            proto_ver: ctx.proto_ver,
            spake_msg: spake_a.clone(),
            public_key: ctx.identity.public_key().to_vec(),
            nonce: nonce_c.to_vec(),
            password_kind: ctx.password_kind,
        };
        (
            ControllerAwaitResp {
                ctx,
                state,
                spake_a,
                nonce_c,
            },
            init,
        )
    }
}

impl ControllerAwaitResp {
    /// 步骤 3：检查公钥与信令一致 -> `finish` -> 算 transcript 和密钥 -> 发 PakeConfirm。
    pub fn on_resp(
        self,
        resp: &PakeResp,
    ) -> Result<(ControllerAwaitConfirm, PakeConfirm), HsError> {
        check_lens(&resp.spake_msg, &resp.public_key, &resp.nonce)?;
        if resp.public_key != self.ctx.expected_host_pubkey {
            return Err(HsError::KeyMismatch);
        }
        let shared = Zeroizing::new(
            self.state
                .finish(&resp.spake_msg)
                .map_err(|_| HsError::Protocol("spake2 finish 失败"))?,
        );
        let my_pk = self.ctx.identity.public_key();
        let t = transcript(&TranscriptInput {
            proto_ver: self.ctx.proto_ver,
            session_id: &self.ctx.session_id,
            controller_code: &self.ctx.controller_code,
            host_code: &self.ctx.host_code,
            spake_msg_a: &self.spake_a,
            spake_msg_b: &resp.spake_msg,
            controller_pubkey: &my_pk,
            host_pubkey: &resp.public_key,
            nonce_c: &self.nonce_c,
            nonce_h: &resp.nonce,
        });
        let keys = derive_keys(&shared, &t).map_err(|_| HsError::Crypto)?;
        let confirm = PakeConfirm {
            mac: confirm_mac(&keys.confirm, b'c', &t),
            signature: self.ctx.identity.sign(&t).to_vec(),
        };
        let host_pubkey: [u8; 32] = resp
            .public_key
            .as_slice()
            .try_into()
            .map_err(|_| HsError::Protocol("公钥长度非法"))?;
        Ok((
            ControllerAwaitConfirm {
                ctx: self.ctx,
                keys,
                transcript: t,
                host_pubkey,
            },
            confirm,
        ))
    }
}

impl ControllerAwaitConfirm {
    /// 步骤 5：校验被控端的 mac（role = b'h'）和签名。
    pub fn on_confirm(self, c: &PakeConfirm) -> Result<Established, HsError> {
        if !verify_mac(&self.keys.confirm, b'h', &self.transcript, &c.mac) {
            return Err(HsError::BadConfirm);
        }
        if !verify_signature(&self.host_pubkey, &self.transcript, &c.signature) {
            return Err(HsError::BadSignature);
        }
        Ok(Established {
            keys: self.keys,
            transcript: self.transcript,
            peer_public_key: self.host_pubkey,
            proto_ver: self.ctx.proto_ver.min(PROTO_VER),
            password_kind: self.ctx.password_kind,
        })
    }
}

// ---------------------------------------------------------------- 被控端

pub struct HostCtx {
    pub session_id: String,
    pub controller_code: String,
    pub host_code: String,
    pub identity: Arc<Identity>,
    pub passwords: Arc<dyn HostPasswords>,
    /// 信令 `connect.incoming` 里的主控端公钥
    pub expected_controller_pubkey: Vec<u8>,
}

pub struct HostStart;

pub struct HostAwaitConfirm {
    keys: SessionKeys,
    transcript: [u8; 32],
    controller_pubkey: [u8; 32],
    identity: Arc<Identity>,
    proto_ver: u32,
    password_kind: u32,
}

impl HostStart {
    /// 步骤 2：检查公钥与信令一致 -> `start_b` -> `finish` -> 算 transcript 和密钥 -> 发 PakeResp。
    ///
    /// 没有对应类别的密码（例如没设固定密码却收到 kind = 1）时，用随机口令继续走完，
    /// 让它在步骤 4 以“密码错误”的方式失败：行为和耗时与真正的密码错误一致，不泄露是否设置了固定密码。
    pub fn on_init(
        ctx: &HostCtx,
        init: &PakeInit,
    ) -> Result<(HostAwaitConfirm, PakeResp), HsError> {
        check_lens(&init.spake_msg, &init.public_key, &init.nonce)?;
        if init.proto_ver < MIN_PROTO_VER {
            return Err(HsError::Version {
                peer: init.proto_ver,
            });
        }
        if init.public_key != ctx.expected_controller_pubkey {
            return Err(HsError::KeyMismatch);
        }
        let pw_key = Zeroizing::new(
            ctx.passwords
                .pw_key(init.password_kind)
                .unwrap_or_else(rand::random),
        );
        let (state, spake_b) = Spake2::<Ed25519Group>::start_b(
            &Password::new(&pw_key[..]),
            &SpakeId::new(ctx.controller_code.as_bytes()),
            &SpakeId::new(ctx.host_code.as_bytes()),
        );
        let shared = Zeroizing::new(
            state
                .finish(&init.spake_msg)
                .map_err(|_| HsError::Protocol("spake2 finish 失败"))?,
        );
        let nonce_h = random_nonce();
        let my_pk = ctx.identity.public_key();
        let t = transcript(&TranscriptInput {
            proto_ver: init.proto_ver,
            session_id: &ctx.session_id,
            controller_code: &ctx.controller_code,
            host_code: &ctx.host_code,
            spake_msg_a: &init.spake_msg,
            spake_msg_b: &spake_b,
            controller_pubkey: &init.public_key,
            host_pubkey: &my_pk,
            nonce_c: &init.nonce,
            nonce_h: &nonce_h,
        });
        let keys = derive_keys(&shared, &t).map_err(|_| HsError::Crypto)?;
        let controller_pubkey: [u8; 32] = init
            .public_key
            .as_slice()
            .try_into()
            .map_err(|_| HsError::Protocol("公钥长度非法"))?;
        let resp = PakeResp {
            spake_msg: spake_b,
            public_key: my_pk.to_vec(),
            nonce: nonce_h.to_vec(),
        };
        Ok((
            HostAwaitConfirm {
                keys,
                transcript: t,
                controller_pubkey,
                identity: ctx.identity.clone(),
                proto_ver: init.proto_ver.min(PROTO_VER),
                password_kind: init.password_kind,
            },
            resp,
        ))
    }
}

impl HostAwaitConfirm {
    /// 步骤 4：校验 mac（role = b'c'），失败 = 密码错误；成功再校验签名，然后产出被控端的 PakeConfirm。
    pub fn on_confirm(self, c: &PakeConfirm) -> Result<(Established, PakeConfirm), HsError> {
        if !verify_mac(&self.keys.confirm, b'c', &self.transcript, &c.mac) {
            return Err(HsError::BadPassword);
        }
        if !verify_signature(&self.controller_pubkey, &self.transcript, &c.signature) {
            return Err(HsError::BadSignature);
        }
        let reply = PakeConfirm {
            mac: confirm_mac(&self.keys.confirm, b'h', &self.transcript),
            signature: self.identity.sign(&self.transcript).to_vec(),
        };
        Ok((
            Established {
                keys: self.keys,
                transcript: self.transcript,
                peer_public_key: self.controller_pubkey,
                proto_ver: self.proto_ver,
                password_kind: self.password_kind,
            },
            reply,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::derive_pw_key;
    use crate::crypto::record::Sealer;

    struct Pw(Option<[u8; 32]>, Option<[u8; 32]>);
    impl HostPasswords for Pw {
        fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
            if kind == 0 {
                self.0
            } else {
                self.1
            }
        }
    }

    struct World {
        c_id: Arc<Identity>,
        h_id: Arc<Identity>,
    }

    impl World {
        fn new() -> Self {
            Self {
                c_id: Arc::new(Identity::generate()),
                h_id: Arc::new(Identity::generate()),
            }
        }
        fn c_ctx(&self, pw: [u8; 32], kind: u32) -> ControllerCtx {
            ControllerCtx {
                proto_ver: 1,
                session_id: "SID1".into(),
                controller_code: "111111111".into(),
                host_code: "222222222".into(),
                identity: self.c_id.clone(),
                pw_key: Zeroizing::new(pw),
                password_kind: kind,
                expected_host_pubkey: self.h_id.public_key().to_vec(),
            }
        }
        fn h_ctx(&self, pws: Pw) -> HostCtx {
            HostCtx {
                session_id: "SID1".into(),
                controller_code: "111111111".into(),
                host_code: "222222222".into(),
                identity: self.h_id.clone(),
                passwords: Arc::new(pws),
                expected_controller_pubkey: self.c_id.public_key().to_vec(),
            }
        }
    }

    /// 在内存里跑完整握手，返回 (主控端结果, 被控端结果)
    fn run(
        w: &World,
        c: ControllerCtx,
        h: &HostCtx,
    ) -> (Result<Established, HsError>, Result<Established, HsError>) {
        let (c1, init) = ControllerStart::begin(c);
        let (h1, resp) = match HostStart::on_init(h, &init) {
            Ok(x) => x,
            Err(e) => return (Err(e.clone()), Err(e)),
        };
        let (c2, c_confirm) = match c1.on_resp(&resp) {
            Ok(x) => x,
            Err(e) => return (Err(e), Err(HsError::Protocol("主控端中止"))),
        };
        let _ = w;
        match h1.on_confirm(&c_confirm) {
            Err(e) => (Err(HsError::BadConfirm), Err(e)),
            Ok((h_est, h_confirm)) => (c2.on_confirm(&h_confirm), Ok(h_est)),
        }
    }

    #[test]
    fn right_password_same_keys_and_bidirectional_records() {
        let w = World::new();
        let pw = derive_pw_key("abc23456", "222222222").expect("kdf");
        let (c, h) = run(&w, w.c_ctx(pw, 0), &w.h_ctx(Pw(Some(pw), None)));
        let (c, h) = (c.unwrap(), h.unwrap());
        assert_eq!(c.keys.c2h, h.keys.c2h);
        assert_eq!(c.keys.h2c, h.keys.h2c);
        assert_eq!(c.keys.confirm, h.keys.confirm);
        assert_eq!(c.transcript, h.transcript);
        assert_eq!(c.peer_public_key, w.h_id.public_key());
        assert_eq!(h.peer_public_key, w.c_id.public_key());
        // 双向收发
        let mut c_tx = Sealer::new(&c.keys.c2h);
        let mut h_rx = Sealer::new(&h.keys.c2h);
        let mut h_tx = Sealer::new(&h.keys.h2c);
        let mut c_rx = Sealer::new(&c.keys.h2c);
        assert_eq!(h_rx.open(&c_tx.seal(b"ls\r").unwrap()).unwrap(), b"ls\r");
        assert_eq!(
            c_rx.open(&h_tx.seal(b"file1 file2").unwrap()).unwrap(),
            b"file1 file2"
        );
    }

    #[test]
    fn wrong_password_fails_at_host_step4() {
        let w = World::new();
        let right = derive_pw_key("abc23456", "222222222").expect("kdf");
        let wrong = derive_pw_key("abc23457", "222222222").expect("kdf");
        let (c, h) = run(&w, w.c_ctx(wrong, 0), &w.h_ctx(Pw(Some(right), None)));
        assert_eq!(h.err(), Some(HsError::BadPassword));
        assert!(c.is_err());
    }

    #[test]
    fn fixed_password_kind_selects_key() {
        let w = World::new();
        let temp = derive_pw_key("abc23456", "222222222").expect("kdf");
        let fixed = derive_pw_key("my long fixed password", "222222222").expect("kdf");
        let pws = || Pw(Some(temp), Some(fixed));
        assert!(run(&w, w.c_ctx(fixed, 1), &w.h_ctx(pws())).1.is_ok());
        assert!(run(&w, w.c_ctx(temp, 0), &w.h_ctx(pws())).1.is_ok());
        // 声明 kind=0 却用固定密码：失败
        assert_eq!(
            run(&w, w.c_ctx(fixed, 0), &w.h_ctx(pws())).1.err(),
            Some(HsError::BadPassword)
        );
    }

    #[test]
    fn no_fixed_password_set_is_bad_password() {
        let w = World::new();
        let temp = derive_pw_key("abc23456", "222222222").expect("kdf");
        let fixed = derive_pw_key("my long fixed password", "222222222").expect("kdf");
        let (c, h) = run(&w, w.c_ctx(fixed, 1), &w.h_ctx(Pw(Some(temp), None)));
        assert_eq!(h.err(), Some(HsError::BadPassword));
        assert!(c.is_err());
    }

    #[test]
    fn resp_public_key_swapped_fails_at_step3() {
        let w = World::new();
        let pw = [1u8; 32];
        let (c1, init) = ControllerStart::begin(w.c_ctx(pw, 0));
        let (_h1, mut resp) = HostStart::on_init(&w.h_ctx(Pw(Some(pw), None)), &init).unwrap();
        resp.public_key = Identity::generate().public_key().to_vec(); // 中继换成自己的公钥
        assert_eq!(c1.on_resp(&resp).err(), Some(HsError::KeyMismatch));
    }

    #[test]
    fn init_public_key_must_match_signaling() {
        let w = World::new();
        let pw = [1u8; 32];
        let (_c1, init) = ControllerStart::begin(w.c_ctx(pw, 0));
        let mut h = w.h_ctx(Pw(Some(pw), None));
        h.expected_controller_pubkey = Identity::generate().public_key().to_vec();
        assert_eq!(
            HostStart::on_init(&h, &init).err(),
            Some(HsError::KeyMismatch)
        );
    }

    #[test]
    fn mitm_with_own_key_but_matching_signaling_is_caught_by_signature() {
        // 信令（可信）告知的公钥是真实公钥；攻击者在中继上无法产生有效签名
        let w = World::new();
        let pw = [1u8; 32];
        let (c1, init) = ControllerStart::begin(w.c_ctx(pw, 0));
        let (h1, resp) = HostStart::on_init(&w.h_ctx(Pw(Some(pw), None)), &init).unwrap();
        let (c2, mut c_confirm) = c1.on_resp(&resp).unwrap();
        c_confirm.signature[0] ^= 1;
        assert_eq!(h1.on_confirm(&c_confirm).err(), Some(HsError::BadSignature));
        let _ = c2;
    }

    /// 把任意一条握手消息的任意一个字节改动，握手必须失败。
    #[test]
    fn any_tampered_byte_breaks_handshake() {
        let w = World::new();
        let pw = derive_pw_key("abc23456", "222222222").expect("kdf");
        let hctx = || w.h_ctx(Pw(Some(pw), None));

        let fresh_init = || ControllerStart::begin(w.c_ctx(pw, 0));

        // 篡改 PakeInit 的每个字节
        let (_, init) = fresh_init();
        let fields =
            |i: &PakeInit| vec![i.spake_msg.clone(), i.public_key.clone(), i.nonce.clone()];
        for (fi, f) in fields(&init).iter().enumerate() {
            for bi in 0..f.len() {
                let (c1, mut init) = fresh_init();
                match fi {
                    0 => init.spake_msg[bi] ^= 0x01,
                    1 => init.public_key[bi] ^= 0x01,
                    _ => init.nonce[bi] ^= 0x01,
                }
                let ok = HostStart::on_init(&hctx(), &init)
                    .ok()
                    .and_then(|(h1, resp)| {
                        let (c2, cc) = c1.on_resp(&resp).ok()?;
                        let (_, hc) = h1.on_confirm(&cc).ok()?;
                        c2.on_confirm(&hc).ok()
                    });
                assert!(
                    ok.is_none(),
                    "init 字段 {fi} 字节 {bi} 被改动后握手不应成功"
                );
            }
        }

        // 篡改 PakeResp 的每个字节
        let (c1, init) = fresh_init();
        let (_, resp) = HostStart::on_init(&hctx(), &init).unwrap();
        let n = resp.spake_msg.len() + resp.public_key.len() + resp.nonce.len();
        for k in 0..n {
            let (c1, init) = fresh_init();
            let (h1, mut resp) = HostStart::on_init(&hctx(), &init).unwrap();
            let (a, b) = (resp.spake_msg.len(), resp.public_key.len());
            if k < a {
                resp.spake_msg[k] ^= 1;
            } else if k < a + b {
                resp.public_key[k - a] ^= 1;
            } else {
                resp.nonce[k - a - b] ^= 1;
            }
            let ok = c1.on_resp(&resp).ok().and_then(|(c2, cc)| {
                let (_, hc) = h1.on_confirm(&cc).ok()?;
                c2.on_confirm(&hc).ok()
            });
            assert!(ok.is_none(), "resp 第 {k} 字节被改动后握手不应成功");
        }
        drop(c1);

        // 篡改两条 Confirm 的每个字节
        for which in 0..2 {
            for k in 0..(32 + 64) {
                let (c1, init) = fresh_init();
                let (h1, resp) = HostStart::on_init(&hctx(), &init).unwrap();
                let (c2, mut cc) = c1.on_resp(&resp).unwrap();
                if which == 0 {
                    if k < 32 {
                        cc.mac[k] ^= 1
                    } else {
                        cc.signature[k - 32] ^= 1
                    }
                    assert!(
                        h1.on_confirm(&cc).is_err(),
                        "主控端 confirm 第 {k} 字节被改动应失败"
                    );
                } else {
                    let (_, mut hc) = h1.on_confirm(&cc).unwrap();
                    if k < 32 {
                        hc.mac[k] ^= 1
                    } else {
                        hc.signature[k - 32] ^= 1
                    }
                    assert!(
                        c2.on_confirm(&hc).is_err(),
                        "被控端 confirm 第 {k} 字节被改动应失败"
                    );
                }
            }
        }
    }

    #[test]
    fn bad_lengths_and_version_rejected() {
        let w = World::new();
        let pw = [1u8; 32];
        let (_c1, init) = ControllerStart::begin(w.c_ctx(pw, 0));
        let h = w.h_ctx(Pw(Some(pw), None));
        let mut bad = init.clone();
        bad.nonce.pop();
        assert!(matches!(
            HostStart::on_init(&h, &bad),
            Err(HsError::Protocol(_))
        ));
        let mut bad = init.clone();
        bad.proto_ver = 0;
        assert_eq!(
            HostStart::on_init(&h, &bad).err(),
            Some(HsError::Version { peer: 0 })
        );
        let mut bad = init.clone();
        bad.spake_msg.clear();
        assert!(matches!(
            HostStart::on_init(&h, &bad),
            Err(HsError::Protocol(_))
        ));
    }

    #[test]
    fn session_id_or_codes_mismatch_fails() {
        // 两端对 session_id 的认知不同（例如中继把别的会话的报文塞进来）-> mac 不对
        let w = World::new();
        let pw = [1u8; 32];
        let mut h = w.h_ctx(Pw(Some(pw), None));
        h.session_id = "OTHER".into();
        let (_, hres) = run(&w, w.c_ctx(pw, 0), &h);
        assert_eq!(hres.err(), Some(HsError::BadPassword));
    }

    #[test]
    fn replayed_init_gets_fresh_keys() {
        // 重放同一条 PakeInit：被控端每次都用新的 nonce_h，transcript 不同，旧的 Confirm 无效
        let w = World::new();
        let pw = [1u8; 32];
        let h = w.h_ctx(Pw(Some(pw), None));
        let (c1, init) = ControllerStart::begin(w.c_ctx(pw, 0));
        let (h1, resp1) = HostStart::on_init(&h, &init).unwrap();
        let (_, cc) = c1.on_resp(&resp1).unwrap();
        assert!(h1.on_confirm(&cc).is_ok());
        let (h1b, _resp2) = HostStart::on_init(&h, &init).unwrap();
        assert_eq!(h1b.on_confirm(&cc).err(), Some(HsError::BadPassword));
    }
}
