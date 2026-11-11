//! 服务端下发配置的签名校验（《安全审查报告》H1）。
//!
//! `GET /v1/config` 里的 `adapters`（输入适配器规则）和 `claude_catalog`（动作目录）会被被控端写进 PTY，
//! 所以必须能证明它们来自我们：服务端用 Ed25519 私钥签名，客户端用内置公钥验签；
//! **缺签名或验签失败时整份忽略，只用内置规则**（见 `core.rs` 的 `apply_server_config_to_host`）。
//!
//! 被签名的字节：`"rterm-config-v1\n"` + `canonical_json({"adapters": [...], "claude_catalog": [...]})`（UTF-8）。
//!
//! 规范化 `canonical_json`：键排序的紧凑 JSON，是 RFC 8785（JCS）的子集：
//! - 对象键按 UTF-16 码元顺序排序，数组保持原顺序，不含空白；
//! - 字符串按 JSON 标准转义（与 `JSON.stringify` / `serde_json` 输出一致：只转义 `"` `\` 和 U+0000–U+001F，
//!   控制字符用 `\b \f \n \r \t`，其余用小写十六进制 `\u00xx`）；
//! - 数字只允许绝对值不超过 2^53−1 的整数，写成十进制整数；小数（包括 `1.5`）一律拒绝，
//!   `1.0` 这种值为整数的浮点按整数 `1` 处理（JS 里 `1.0` 和 `1` 是同一个数）。
//!
//! 服务端实现：`server/src/config-sign.ts`；两端共用同一组测试向量（见本文件测试 `shared_vector_with_server`）。
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;

use crate::api::ServerConfig;

/// 签名消息的域前缀。
pub const CONFIG_SIG_PREFIX: &str = "rterm-config-v1\n";

/// 内置受信公钥（base64，32 字节 Ed25519 公钥）。多把用于轮换：任意一把验签通过即可。
/// 对应的私钥只存在于服务端环境变量 `CONFIG_SIGNING_KEY`，不在仓库里。
pub const BUILTIN_PUBKEYS: &[&str] = &["Na4pV+9TUsMFqdvHFitGAe9jqObG9m2b5/XL6aV39OI="];

/// 用这个环境变量覆盖受信公钥（base64）。仅限 debug 构建，发布构建还需要 [`ENV_ALLOW_OVERRIDE`] = 1。
pub const ENV_PUBKEY: &str = "RTERM_CONFIG_PUBKEY";
/// 发布构建里显式允许 [`ENV_PUBKEY`] 生效（自建服务端、联调）。
pub const ENV_ALLOW_OVERRIDE: &str = "RTERM_ALLOW_CONFIG_PUBKEY_OVERRIDE";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SigError {
    #[error("没有签名")]
    Missing,
    #[error("签名或公钥格式无效：{0}")]
    BadFormat(String),
    #[error("没有可用的受信公钥")]
    NoTrustedKey,
    #[error("签名校验失败")]
    BadSignature,
    #[error("无法规范化：{0}")]
    Canonical(String),
}

/// 解析 base64 公钥（32 字节）。
pub fn parse_pubkey(b64: &str) -> Option<[u8; 32]> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    <[u8; 32]>::try_from(raw.as_slice()).ok()
}

/// 当前生效的受信公钥：内置的；环境变量覆盖只在 debug 构建，或显式设置 [`ENV_ALLOW_OVERRIDE`]=1 时生效。
pub fn trusted_keys() -> Vec<[u8; 32]> {
    let over = std::env::var(ENV_PUBKEY)
        .ok()
        .filter(|s| !s.trim().is_empty());
    let allow = cfg!(debug_assertions)
        || std::env::var(ENV_ALLOW_OVERRIDE)
            .map(|v| v == "1")
            .unwrap_or(false);
    trusted_keys_from(BUILTIN_PUBKEYS, over.as_deref(), allow)
}

/// [`trusted_keys`] 的纯函数形式（可测试）。`allow_override` 为假时忽略 `over`；`over` 无法解析时回退内置并记日志。
pub fn trusted_keys_from(
    builtin: &[&str],
    over: Option<&str>,
    allow_override: bool,
) -> Vec<[u8; 32]> {
    if let Some(o) = over {
        if !allow_override {
            tracing::warn!(
                "已设置 {ENV_PUBKEY}，但发布构建需要同时设置 {ENV_ALLOW_OVERRIDE}=1 才会生效，已忽略"
            );
        } else if let Some(k) = parse_pubkey(o) {
            tracing::warn!("使用环境变量 {ENV_PUBKEY} 指定的配置签名公钥（非内置公钥）");
            return vec![k];
        } else {
            tracing::warn!("{ENV_PUBKEY} 不是 base64 的 32 字节公钥，已忽略");
        }
    }
    builtin.iter().filter_map(|b| parse_pubkey(b)).collect()
}

fn write_json_string(out: &mut String, s: &str) {
    // serde_json 对字符串的转义与 JSON.stringify / JCS 一致
    match serde_json::to_string(s) {
        Ok(j) => out.push_str(&j),
        Err(_) => out.push_str("\"\""),
    }
}

fn write_canonical(v: &Value, out: &mut String) -> Result<(), SigError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            const MAX_SAFE: i64 = (1 << 53) - 1;
            if let Some(i) = n.as_i64() {
                if i.abs() > MAX_SAFE {
                    return Err(SigError::Canonical(format!("整数超出安全范围：{n}")));
                }
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                if u > MAX_SAFE as u64 {
                    return Err(SigError::Canonical(format!("整数超出安全范围：{n}")));
                }
                out.push_str(&u.to_string());
            } else {
                // 浮点：值为整数时按整数写（JS 里 1.0 就是 1），否则拒绝
                match n.as_f64() {
                    Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64 => {
                        out.push_str(&(f as i64).to_string());
                    }
                    _ => return Err(SigError::Canonical(format!("只允许整数：{n}"))),
                }
            }
        }
        Value::String(s) => write_json_string(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(x, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            // UTF-16 码元顺序（JCS）；与按 UTF-8 字节或码点排序只在补充平面字符上不同
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                if let Some(x) = m.get(*k) {
                    write_canonical(x, out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

/// 规范化 JSON（见模块文档）。
pub fn canonical_json(v: &Value) -> Result<String, SigError> {
    let mut out = String::new();
    write_canonical(v, &mut out)?;
    Ok(out)
}

/// 被签名的字节。
pub fn signed_bytes(adapters: &[Value], claude_catalog: &[Value]) -> Result<Vec<u8>, SigError> {
    let body = serde_json::json!({ "adapters": adapters, "claude_catalog": claude_catalog });
    Ok(format!("{CONFIG_SIG_PREFIX}{}", canonical_json(&body)?).into_bytes())
}

/// 用 `keys` 里任意一把公钥验证 `adapters` + `claude_catalog` 的签名。
pub fn verify(
    adapters: &[Value],
    claude_catalog: &[Value],
    sig_b64: Option<&str>,
    keys: &[[u8; 32]],
) -> Result<(), SigError> {
    let sig_b64 = sig_b64
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(SigError::Missing)?;
    if keys.is_empty() {
        return Err(SigError::NoTrustedKey);
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(sig_b64)
        .map_err(|e| SigError::BadFormat(e.to_string()))?;
    let sig = Signature::from_slice(&raw).map_err(|e| SigError::BadFormat(e.to_string()))?;
    let msg = signed_bytes(adapters, claude_catalog)?;
    for k in keys {
        let Ok(vk) = VerifyingKey::from_bytes(k) else {
            continue;
        };
        // verify_strict：拒绝小阶点公钥和不规范的签名
        if vk.verify_strict(&msg, &sig).is_ok() {
            return Ok(());
        }
    }
    Err(SigError::BadSignature)
}

/// 校验一份 `ServerConfig`。
pub fn verify_server_config(sc: &ServerConfig, keys: &[[u8; 32]]) -> Result<(), SigError> {
    verify(
        &sc.adapters,
        &sc.claude_catalog,
        sc.config_sig.as_deref(),
        keys,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    // ---- 与服务端（server/test/hardening.test.ts 的 VEC）共用的测试向量 ----
    const VEC_SEED_B64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const VEC_PUB_B64: &str = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
    const VEC_SIG_B64: &str =
        "Ns39bjnoajMv83LcqiBd2QJGzdoRhj/bQHb8bKHTDJc6+HEbIhYh5uK6ljj7pomhqniLLDH9rQb5Yd6N4b1pDQ==";
    const VEC_CANONICAL: &str = "{\"adapters\":[{\"fallback_newline\":\"\\\\\\r\",\"id\":\"a\",\"match\":{\"profile\":\"CLAUDE\"},\"newline_in_paste\":\"\\n\",\"paste\":\"bracketed\",\"submit_delay_ms\":80,\"submit_key\":\"\\r\"}],\"claude_catalog\":[{\"actions\":[{\"id\":\"x.y\",\"steps\":[{\"submit\":\"/clear\"}],\"title\":\"标题 😀\"}],\"app\":\"claude\",\"catalog_ver\":\"t1\"}]}";

    fn vec_adapters() -> Vec<Value> {
        vec![json!({
            "id": "a", "match": {"profile": "CLAUDE"}, "paste": "bracketed",
            "newline_in_paste": "\n", "submit_delay_ms": 80, "submit_key": "\r",
            "fallback_newline": "\\\r"
        })]
    }

    fn vec_catalog() -> Vec<Value> {
        vec![json!({
            "catalog_ver": "t1", "app": "claude",
            "actions": [{"id": "x.y", "title": "标题 \u{1F600}", "steps": [{"submit": "/clear"}]}]
        })]
    }

    fn seed() -> [u8; 32] {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(VEC_SEED_B64)
            .expect("b64");
        <[u8; 32]>::try_from(raw.as_slice()).expect("32")
    }

    fn sign_with(key: &SigningKey, a: &[Value], c: &[Value]) -> String {
        let msg = signed_bytes(a, c).expect("canonical");
        base64::engine::general_purpose::STANDARD.encode(key.sign(&msg).to_bytes())
    }

    #[test]
    fn shared_vector_with_server() {
        let body = json!({"adapters": vec_adapters(), "claude_catalog": vec_catalog()});
        assert_eq!(canonical_json(&body).expect("canonical"), VEC_CANONICAL);
        let sk = SigningKey::from_bytes(&seed());
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().to_bytes()),
            VEC_PUB_B64
        );
        // Ed25519 是确定性的：同一私钥同一消息得到与服务端完全相同的签名
        assert_eq!(sign_with(&sk, &vec_adapters(), &vec_catalog()), VEC_SIG_B64);
        // 用服务端算出的签名验签
        let keys = [parse_pubkey(VEC_PUB_B64).expect("pk")];
        assert_eq!(
            verify(&vec_adapters(), &vec_catalog(), Some(VEC_SIG_B64), &keys),
            Ok(())
        );
    }

    #[test]
    fn canonical_rules() {
        let v = json!({"b": 1, "a": [true, null, "x\"y\\z\n"], "c": {"z": 1, "y": 2}});
        assert_eq!(
            canonical_json(&v).expect("c"),
            r#"{"a":[true,null,"x\"y\\z\n"],"b":1,"c":{"y":2,"z":1}}"#
        );
        // 控制字符用小写 \u00xx，DEL 和 U+2028 不转义
        assert_eq!(
            canonical_json(&json!("\u{1b}\u{7f}\u{2028}")).expect("c"),
            "\"\\u001b\u{7f}\u{2028}\""
        );
        // UTF-16 码元顺序：U+1F600 的首个码元 0xD83D 小于 U+FFFF
        assert_eq!(
            canonical_json(&json!({"\u{ffff}": 2, "\u{1F600}": 1})).expect("c"),
            "{\"\u{1F600}\":1,\"\u{ffff}\":2}"
        );
        // 整数值的浮点按整数处理；真正的小数拒绝
        let f: Value = serde_json::from_str(r#"{"a":1.0,"b":-3}"#).expect("json");
        assert_eq!(canonical_json(&f).expect("c"), r#"{"a":1,"b":-3}"#);
        let f: Value = serde_json::from_str(r#"{"a":1.5}"#).expect("json");
        assert!(canonical_json(&f).is_err());
        let big: Value = serde_json::from_str(r#"{"a":9007199254740993}"#).expect("json");
        assert!(canonical_json(&big).is_err());
    }

    #[test]
    fn verify_accepts_good_and_rejects_everything_else() {
        let sk = SigningKey::from_bytes(&seed());
        let keys = [sk.verifying_key().to_bytes()];
        let (a, c) = (vec_adapters(), vec_catalog());
        let sig = sign_with(&sk, &a, &c);
        assert_eq!(verify(&a, &c, Some(&sig), &keys), Ok(()));
        // 缺签名
        assert_eq!(verify(&a, &c, None, &keys), Err(SigError::Missing));
        assert_eq!(verify(&a, &c, Some("  "), &keys), Err(SigError::Missing));
        // 格式错
        assert!(matches!(
            verify(&a, &c, Some("!!!"), &keys),
            Err(SigError::BadFormat(_))
        ));
        assert!(matches!(
            verify(&a, &c, Some("AAAA"), &keys),
            Err(SigError::BadFormat(_))
        ));
        // 内容被改（报告 H1 的复现点）
        let mut evil = a.clone();
        evil[0]["fallback_newline"] = json!("\r;id>x;\r");
        assert_eq!(
            verify(&evil, &c, Some(&sig), &keys),
            Err(SigError::BadSignature)
        );
        let mut evil_cat = c.clone();
        evil_cat[0]["actions"][0]["steps"][0]["submit"] = json!("!calc");
        assert_eq!(
            verify(&a, &evil_cat, Some(&sig), &keys),
            Err(SigError::BadSignature)
        );
        // adapters 和 claude_catalog 互换位置也不行
        assert_eq!(
            verify(&c, &a, Some(&sig), &keys),
            Err(SigError::BadSignature)
        );
        // 别人的密钥签的
        let other = SigningKey::from_bytes(&[7u8; 32]);
        let sig2 = sign_with(&other, &a, &c);
        assert_eq!(
            verify(&a, &c, Some(&sig2), &keys),
            Err(SigError::BadSignature)
        );
        // 不带域前缀的签名（直接签规范化 JSON）不被接受
        let raw = canonical_json(&json!({"adapters": a, "claude_catalog": c})).expect("c");
        let sig3 =
            base64::engine::general_purpose::STANDARD.encode(sk.sign(raw.as_bytes()).to_bytes());
        assert_eq!(
            verify(&a, &c, Some(&sig3), &keys),
            Err(SigError::BadSignature)
        );
        // 没有受信公钥
        assert_eq!(verify(&a, &c, Some(&sig), &[]), Err(SigError::NoTrustedKey));
        // 多把公钥（轮换）：任意一把通过即可
        assert_eq!(
            verify(
                &a,
                &c,
                Some(&sig),
                &[other.verifying_key().to_bytes(), keys[0]]
            ),
            Ok(())
        );
        // 改动签名的任意一位
        let mut raw = base64::engine::general_purpose::STANDARD
            .decode(&sig)
            .expect("b64");
        raw[10] ^= 1;
        let tampered = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(
            verify(&a, &c, Some(&tampered), &keys),
            Err(SigError::BadSignature)
        );
    }

    #[test]
    fn server_config_roundtrip_through_cache_still_verifies() {
        let sk = SigningKey::from_bytes(&seed());
        let (a, c) = (vec_adapters(), vec_catalog());
        let sc = ServerConfig {
            adapters: a.clone(),
            claude_catalog: c.clone(),
            config_sig: Some(sign_with(&sk, &a, &c)),
            ..Default::default()
        };
        let keys = [sk.verifying_key().to_bytes()];
        assert_eq!(verify_server_config(&sc, &keys), Ok(()));
        // 写进 config.json 缓存再读出来（Value 往返）后仍然验签通过
        let v = serde_json::to_value(&sc).expect("to_value");
        let text = serde_json::to_string(&v).expect("string");
        let back: ServerConfig = serde_json::from_str(&text).expect("from_str");
        assert_eq!(verify_server_config(&back, &keys), Ok(()));
        // 没有 config_sig 字段的旧缓存：Missing
        let mut old = back.clone();
        old.config_sig = None;
        assert_eq!(verify_server_config(&old, &keys), Err(SigError::Missing));
    }

    #[test]
    fn builtin_keys_parse() {
        let k = trusted_keys_from(BUILTIN_PUBKEYS, None, false);
        assert_eq!(k.len(), BUILTIN_PUBKEYS.len());
        assert!(k.iter().all(|x| VerifyingKey::from_bytes(x).is_ok()));
    }

    #[test]
    fn pubkey_override_rules() {
        let builtin = trusted_keys_from(BUILTIN_PUBKEYS, None, false);
        // 允许覆盖：用环境变量指定的（只用它，不再信任内置）
        let over = trusted_keys_from(BUILTIN_PUBKEYS, Some(VEC_PUB_B64), true);
        assert_eq!(over, vec![parse_pubkey(VEC_PUB_B64).expect("pk")]);
        assert_ne!(over, builtin);
        // 不允许覆盖（发布构建且没有显式开关）：忽略环境变量
        assert_eq!(
            trusted_keys_from(BUILTIN_PUBKEYS, Some(VEC_PUB_B64), false),
            builtin
        );
        // 环境变量格式错：回退内置，绝不会变成"没有公钥所以全放行"
        assert_eq!(
            trusted_keys_from(BUILTIN_PUBKEYS, Some("garbage"), true),
            builtin
        );
    }
}
