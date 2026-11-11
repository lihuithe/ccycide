//! 日志（《实现方案.md》5.9）：`tracing` 输出到按天滚动的文件，保留 7 天；可选同时输出到 stderr。
//!
//! 约定：日志里不记录终端内容、密码、文件内容；设备码只记录后 4 位（用 [`mask_code`]）。
use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// 日志文件名前缀 / 后缀：`rterm.2026-11-11.log`
pub const LOG_PREFIX: &str = "rterm";
pub const LOG_SUFFIX: &str = "log";
pub const KEEP_DAYS: usize = 7;

/// 持有它才能保证退出前日志落盘；程序结束前不要丢弃。
pub struct LogGuard {
    _worker: WorkerGuard,
}

/// 设备码只保留后 4 位：`123456789` -> `*****6789`。
pub fn mask_code(code: &str) -> String {
    let n = code.chars().count();
    if n <= 4 {
        return "*".repeat(n);
    }
    let tail: String = code.chars().skip(n - 4).collect();
    format!("{}{}", "*".repeat(n - 4), tail)
}

/// 初始化全局日志。重复调用（或已有全局订阅者）时返回 None。
/// `RUST_LOG` 可覆盖级别，默认 `info`。
pub fn init(logs_dir: &Path, to_stderr: bool) -> Option<LogGuard> {
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_PREFIX)
        .filename_suffix(LOG_SUFFIX)
        .max_log_files(KEEP_DAYS)
        .build(logs_dir)
        .map_err(|e| eprintln!("无法创建日志文件（{}）：{e}", logs_dir.display()))
        .ok()?;
    let (file, worker) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt = tracing_subscriber::fmt::layer().with_ansi(false);
    let ok = if to_stderr {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt.with_writer(file.and(std::io::stderr)))
            .try_init()
            .is_ok()
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt.with_writer(file))
            .try_init()
            .is_ok()
    };
    ok.then_some(LogGuard { _worker: worker })
}

/// 最新的日志文件（按文件名里的日期排序）。
pub fn latest_log_file(logs_dir: &Path) -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(logs_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(LOG_PREFIX) && n.ends_with(LOG_SUFFIX))
        })
        .collect();
    files.sort();
    files.pop()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_all_but_last_four() {
        assert_eq!(mask_code("123456789"), "*****6789");
        assert_eq!(mask_code("123"), "***");
        assert_eq!(mask_code(""), "");
    }

    #[test]
    fn latest_file_is_newest_date() {
        let d = tempfile::tempdir().unwrap();
        for n in ["rterm.2026-11-09.log", "rterm.2026-11-11.log", "other.txt"] {
            std::fs::write(d.path().join(n), "x").unwrap();
        }
        let p = latest_log_file(d.path()).unwrap();
        assert!(p.ends_with("rterm.2026-11-11.log"));
        assert!(latest_log_file(&d.path().join("nope")).is_none());
    }
}
