//! 门面层的统一错误：`{ code, message }`，错误码与前端契约 `ErrorCodes` 一致，可直接序列化给界面。
use serde::Serialize;

use crate::api::{ApiError, BootstrapError};
use crate::controller::{ConnectError, CtlError};
use crate::relay::EstablishError;
use crate::signal::SignalError;

/// 错误码常量（与 `apps/desktop/src/backend/types.ts` 的 `ErrorCodes` 对应，另加几个核心库自己的）。
pub mod codes {
    pub const UNAVAILABLE: &str = "UNAVAILABLE";
    pub const REJECTED: &str = "REJECTED";
    pub const RATE_LIMITED: &str = "RATE_LIMITED";
    pub const LOCKED: &str = "LOCKED";
    pub const VERSION: &str = "VERSION";
    pub const BANNED: &str = "BANNED";
    pub const NO_RELAY: &str = "NO_RELAY";
    pub const PASSWORD_WRONG: &str = "PASSWORD_WRONG";
    pub const NETWORK: &str = "NETWORK";
    pub const NOT_READY: &str = "NOT_READY";
    pub const IS_DIRECTORY: &str = "IS_DIRECTORY";
    pub const FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";
    pub const FILE_DISABLED: &str = "FILE_DISABLED";
    pub const BAD_REQUEST: &str = "BAD_REQUEST";
    pub const TERM_NOT_FOUND: &str = "TERM_NOT_FOUND";
    pub const UNKNOWN: &str = "UNKNOWN";
    /// 被控端公钥与记住的不一致；`data` 里带 `known` / `actual` 指纹，用户确认后用 `accept_key_change` 重连
    pub const PEER_KEY_CHANGED: &str = "PEER_KEY_CHANGED";
    pub const NO_SUCH_SESSION: &str = "NO_SUCH_SESSION";
    /// 本机尚未注册设备（服务器不可达）
    pub const NOT_REGISTERED: &str = "NOT_REGISTERED";
    pub const WEAK_PASSWORD: &str = "WEAK_PASSWORD";
    pub const UPGRADE_REQUIRED: &str = "UPGRADE_REQUIRED";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const CLOSED: &str = "CLOSED";
    /// 用户取消了还在等对方确认的连接
    pub const CANCELLED: &str = "CANCELLED";
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}（{}）", self.message, self.code)
    }
}

impl std::error::Error for CoreError {}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            data: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(codes::BAD_REQUEST, message)
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl From<SignalError> for CoreError {
    fn from(e: SignalError) -> Self {
        let code = match &e {
            SignalError::Connect(c) => match c.as_str() {
                "UNAVAILABLE" => codes::UNAVAILABLE,
                "REJECTED" => codes::REJECTED,
                "RATE_LIMITED" => codes::RATE_LIMITED,
                "LOCKED" => codes::LOCKED,
                "VERSION" => codes::VERSION,
                "BANNED" => codes::BANNED,
                "NO_RELAY" => codes::NO_RELAY,
                _ => codes::UNKNOWN,
            },
            SignalError::Offline | SignalError::Timeout | SignalError::Closed => codes::NETWORK,
            SignalError::Cancelled => codes::CANCELLED,
            _ => codes::UNKNOWN,
        };
        CoreError::new(code, e.user_text())
    }
}

fn fingerprint(key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(key);
    h.iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

impl From<ConnectError> for CoreError {
    fn from(e: ConnectError) -> Self {
        match &e {
            ConnectError::Signal(s) => CoreError::from(s.clone()),
            ConnectError::Establish(EstablishError::BadPassword) => {
                CoreError::new(codes::PASSWORD_WRONG, "密码错误")
            }
            ConnectError::Establish(EstablishError::PeerKeyChanged { known, actual }) => {
                CoreError::new(codes::PEER_KEY_CHANGED, e.user_text()).with_data(
                    serde_json::json!({
                        "known": fingerprint(known),
                        "actual": fingerprint(actual),
                    }),
                )
            }
            ConnectError::Establish(EstablishError::Version { .. }) => {
                CoreError::new(codes::VERSION, e.user_text())
            }
            ConnectError::Establish(
                EstablishError::Connect(_)
                | EstablishError::Timeout
                | EstablishError::RelayClosed { .. },
            )
            | ConnectError::HelloTimeout
            | ConnectError::LinkLost => CoreError::new(codes::NETWORK, e.user_text()),
            _ => CoreError::new(codes::UNKNOWN, e.user_text()),
        }
    }
}

impl From<CtlError> for CoreError {
    fn from(e: CtlError) -> Self {
        match e {
            CtlError::NotConnected | CtlError::ConnectionLost => {
                CoreError::new(codes::NOT_READY, "尚未连接（重连中）")
            }
            CtlError::Closed => CoreError::new(codes::CLOSED, "会话已关闭"),
            CtlError::Timeout => CoreError::new(codes::TIMEOUT, "请求超时"),
            CtlError::NoSuchSession(s) => {
                CoreError::new(codes::NO_SUCH_SESSION, format!("会话不存在：{s}"))
            }
            CtlError::NoSuchTerm(t) | CtlError::TermNotAttached(t) => {
                CoreError::new(codes::TERM_NOT_FOUND, format!("终端不存在：{t}"))
            }
            CtlError::Remote { code, message } => CoreError::new(&code, message),
            CtlError::AttachmentNotReady(f) => {
                CoreError::bad_request(format!("附件 {f} 尚未上传完成"))
            }
            CtlError::FileUnsupported => {
                CoreError::new(codes::FILE_DISABLED, "被控端不支持或已关闭文件接收")
            }
            e @ CtlError::FileTooLarge { .. } => {
                CoreError::new(codes::FILE_TOO_LARGE, e.to_string())
            }
            CtlError::TooManyUploads => CoreError::new(codes::RATE_LIMITED, "同时上传的文件过多"),
            CtlError::Io(m) => CoreError::new(codes::UNKNOWN, m),
        }
    }
}

impl From<ApiError> for CoreError {
    fn from(e: ApiError) -> Self {
        let code = if matches!(e, ApiError::Network(_)) {
            codes::NETWORK
        } else {
            codes::UNKNOWN
        };
        CoreError::new(code, e.to_string())
    }
}

impl From<BootstrapError> for CoreError {
    fn from(e: BootstrapError) -> Self {
        match e {
            BootstrapError::Api(a) => CoreError::from(a),
            other => CoreError::new(codes::UNKNOWN, other.to_string()),
        }
    }
}

impl From<crate::settings::SettingsError> for CoreError {
    fn from(e: crate::settings::SettingsError) -> Self {
        CoreError::bad_request(e.0)
    }
}

impl From<crate::config::ConfigError> for CoreError {
    fn from(e: crate::config::ConfigError) -> Self {
        CoreError::new(codes::UNKNOWN, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_connect_errors() {
        let e: CoreError = ConnectError::Signal(SignalError::Connect("LOCKED".into())).into();
        assert_eq!(e.code, "LOCKED");
        let e: CoreError = ConnectError::Establish(EstablishError::BadPassword).into();
        assert_eq!(e.code, "PASSWORD_WRONG");
        let e: CoreError = ConnectError::Establish(EstablishError::PeerKeyChanged {
            known: vec![1; 32],
            actual: vec![2; 32],
        })
        .into();
        assert_eq!(e.code, "PEER_KEY_CHANGED");
        assert!(e.data.is_some());
        let e: CoreError = CtlError::NotConnected.into();
        assert_eq!(e.code, "NOT_READY");
        let e: CoreError = CtlError::Remote {
            code: "TERM_BUSY".into(),
            message: "x".into(),
        }
        .into();
        assert_eq!(e.code, "TERM_BUSY");
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"code\":\"TERM_BUSY\""));
    }
}
