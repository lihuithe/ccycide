//! 读取系统剪贴板里的文件列表（在文件管理器里复制的文件）。
//! 失败（Wayland 无权限、剪贴板被占用等）统一返回 `CLIPBOARD_UNAVAILABLE`，前端据此提示改用拖拽。
use clipboard_rs::{Clipboard, ClipboardContext};

use crate::error::{CmdResult, CommandError};

fn unavailable(why: impl std::fmt::Display) -> CommandError {
    tracing::warn!("读取剪贴板文件失败：{why}");
    CommandError::new(
        "CLIPBOARD_UNAVAILABLE",
        "无法读取剪贴板里的文件，请改用拖拽或选择文件",
    )
}

/// `file:///C:/a%20b.txt` -> `C:/a b.txt`（Windows）/ `/home/a b.txt`（Unix）；普通路径原样返回。
pub fn normalize_path(raw: &str) -> String {
    let Some(rest) = raw.strip_prefix("file://") else {
        return raw.to_string();
    };
    // file://localhost/xxx 或 file:///xxx
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = percent_encoding::percent_decode_str(rest)
        .decode_utf8_lossy()
        .into_owned();
    // Windows：/C:/x -> C:/x
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[2] == b':' && b[1].is_ascii_alphabetic() {
        return decoded[1..].to_string();
    }
    decoded
}

/// 返回剪贴板里的文件路径；剪贴板里没有文件时返回空列表。
pub async fn read_files() -> CmdResult<Vec<String>> {
    // 剪贴板 API 是同步阻塞的，放到阻塞线程
    let res = tokio::task::spawn_blocking(|| -> Result<Vec<String>, String> {
        let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
        match ctx.get_files() {
            Ok(v) => Ok(v),
            // 剪贴板里不是文件时各平台的报错不同，统一当作“没有文件”
            Err(e) => {
                tracing::debug!("剪贴板中没有文件：{e}");
                Ok(Vec::new())
            }
        }
    })
    .await
    .map_err(unavailable)?
    .map_err(unavailable)?;
    Ok(res.iter().map(|p| normalize_path(p)).collect())
}

#[cfg(test)]
mod tests {
    use super::normalize_path;

    #[test]
    fn plain_paths_untouched() {
        assert_eq!(normalize_path(r"C:\a\b.txt"), r"C:\a\b.txt");
        assert_eq!(normalize_path("/home/u/a.txt"), "/home/u/a.txt");
    }

    #[test]
    fn file_uri_decoded() {
        assert_eq!(normalize_path("file:///C:/a%20b/中.txt"), "C:/a b/中.txt");
        assert_eq!(
            normalize_path("file:///home/u/a%20b.txt"),
            "/home/u/a b.txt"
        );
    }
}
