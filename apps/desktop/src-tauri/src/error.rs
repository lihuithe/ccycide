//! 命令错误：序列化成前端约定的 `{ code, message }`（`apps/desktop/src/backend/types.ts` 的 `CommandError`）。
use rterm_core::error::CoreError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    /// 附加数据（如 `PEER_KEY_CHANGED` 的指纹），前端可忽略
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub type CmdResult<T> = Result<T, CommandError>;

impl CommandError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            data: None,
        }
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new("UNKNOWN", message)
    }
}

impl From<CoreError> for CommandError {
    fn from(e: CoreError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            data: e.data,
        }
    }
}
