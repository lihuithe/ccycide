//! 文件接收（《实现方案.md》5.5.5，《开发指南.md》T26 被控端部分）。
//!
//! 存放位置 `<inbox>/<日期>/<时分秒>-<清洗后的文件名>`；先写 `.part`，`FileEnd` 校验 SHA-256 通过后改名。
//! 接收的文件一律不执行、不自动打开。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use rterm_proto::pb;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

/// 每收到这么多字节回一次 `FileAck`。
pub const ACK_EVERY: u64 = 256 * 1024;
/// 单个会话同时进行的上传数上限。
pub const MAX_CONCURRENT_FILES: usize = 8;
/// 进行中的文件的默认空闲超时。
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 文件名最大字节数。
pub const MAX_NAME_BYTES: usize = 200;

#[derive(Debug, Clone)]
pub struct InboxConfig {
    pub dir: PathBuf,
    pub enabled: bool,
    pub max_file_size: u64,
    pub max_total: u64,
    /// inbox 里最多保留多少个文件（含进行中的 `.part`）。大小为 0 的文件不占配额，没有这个上限就能无限创建
    pub max_files: usize,
    pub retention: Duration,
    /// 进行中的文件这么久没有任何数据块就回收预留并删除 `.part`（审查 L6）
    pub idle_timeout: Duration,
}

impl InboxConfig {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            enabled: true,
            max_file_size: 200 * 1024 * 1024,
            max_total: 2 * 1024 * 1024 * 1024,
            max_files: 5000,
            retention: Duration::from_secs(7 * 24 * 3600),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }
}

/// `chunk` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkOutcome {
    Continue,
    /// 需要回 `FileAck`
    Ack(pb::FileAck),
    /// 这一块补齐了数据，并触发了之前暂存的 `FileEnd`
    Done(pb::FileDone),
}

/// 失败原因。`code` 就是 `Error.code`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxError {
    pub code: &'static str,
    pub message: String,
}

impl InboxError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn io(e: impl std::fmt::Display) -> Self {
        Self::new("FILE_IO", e.to_string())
    }
}

impl std::fmt::Display for InboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// 全局的 inbox（被控端一个）。
pub struct Inbox {
    cfg: RwLock<InboxConfig>,
    /// 所有会话正在接收的文件占用的预留大小
    reserved: AtomicU64,
    enabled: AtomicBool,
    /// "统计占用 + 预留"必须是原子的，否则并发的 FileBegin 会同时通过总量检查（审查 L6）
    quota_lock: tokio::sync::Mutex<()>,
    /// 所有进行中的文件（跨会话），供空闲回收
    slots: Mutex<Vec<Arc<Slot>>>,
}

/// 一个进行中文件的占位：预留大小、最近活动时间。预留只会被释放一次。
struct Slot {
    size: u64,
    part_path: PathBuf,
    last: Mutex<Instant>,
    released: AtomicBool,
    expired: AtomicBool,
}

impl Slot {
    fn touch(&self) {
        if let Ok(mut l) = self.last.lock() {
            *l = Instant::now();
        }
    }
    fn idle_for(&self) -> Duration {
        self.last
            .lock()
            .map(|l| l.elapsed())
            .unwrap_or_else(|e| e.into_inner().elapsed())
    }
}

impl Inbox {
    pub fn new(cfg: InboxConfig) -> Arc<Self> {
        let enabled = AtomicBool::new(cfg.enabled);
        Arc::new(Self {
            cfg: RwLock::new(cfg),
            reserved: AtomicU64::new(0),
            enabled,
            quota_lock: tokio::sync::Mutex::new(()),
            slots: Mutex::new(Vec::new()),
        })
    }

    pub fn config(&self) -> InboxConfig {
        self.cfg
            .read()
            .map(|c| c.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// 在设置里开关文件接收。
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Release);
        if let Ok(mut c) = self.cfg.write() {
            c.enabled = on;
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_limits(&self, max_file_size: u64, max_total: u64) {
        if let Ok(mut c) = self.cfg.write() {
            c.max_file_size = max_file_size;
            c.max_total = max_total;
        }
    }

    pub fn set_idle_timeout(&self, d: Duration) {
        if let Ok(mut c) = self.cfg.write() {
            c.idle_timeout = d;
        }
    }

    fn idle_timeout(&self) -> Duration {
        self.cfg
            .read()
            .map(|c| c.idle_timeout)
            .unwrap_or_else(|e| e.into_inner().idle_timeout)
    }

    fn register(&self, slot: Arc<Slot>) {
        if let Ok(mut v) = self.slots.lock() {
            v.push(slot);
        }
    }

    /// 释放预留并注销（幂等）。
    fn release(&self, slot: &Arc<Slot>) {
        if !slot.released.swap(true, Ordering::AcqRel) {
            self.reserved.fetch_sub(slot.size, Ordering::AcqRel);
            if let Ok(mut v) = self.slots.lock() {
                v.retain(|s| !Arc::ptr_eq(s, slot));
            }
        }
    }

    /// 回收空闲超时的文件：释放预留、删除 `.part`，并标记过期（所属会话下次访问时得到错误）。
    /// 返回回收的个数。
    pub fn reap_idle(&self) -> usize {
        let limit = self.idle_timeout();
        let idle: Vec<Arc<Slot>> = match self.slots.lock() {
            Ok(v) => v.iter().filter(|s| s.idle_for() > limit).cloned().collect(),
            Err(_) => return 0,
        };
        for s in &idle {
            s.expired.store(true, Ordering::Release);
            self.release(s);
            let _ = std::fs::remove_file(&s.part_path);
        }
        idle.len()
    }

    /// 新建一个会话级的接收状态。
    pub fn session(self: &Arc<Self>) -> InboxSession {
        InboxSession {
            inbox: self.clone(),
            files: HashMap::new(),
            done: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 当前 inbox 目录总大小（阻塞）。
    pub fn total_size(&self) -> u64 {
        dir_size(&self.config().dir)
    }

    /// 清理超过保留期的文件，以及上次崩溃遗留的 `.part`。阻塞，返回删除的文件数。
    pub fn cleanup_expired(&self) -> usize {
        let cfg = self.config();
        let now = SystemTime::now();
        let mut removed = 0;
        let Ok(days) = std::fs::read_dir(&cfg.dir) else {
            return 0;
        };
        for day in days.flatten() {
            let p = day.path();
            // 不跟随符号链接：inbox 里被放进指向别处的链接目录时，不能进去删东西（审查 L6）
            if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_dir()) {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(&p) {
                for f in files.flatten() {
                    let fp = f.path();
                    let age = f
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| now.duration_since(t).ok())
                        .unwrap_or_default();
                    let is_part = fp.extension().is_some_and(|e| e == "part");
                    let limit = if is_part {
                        Duration::from_secs(24 * 3600)
                    } else {
                        cfg.retention
                    };
                    if age > limit && std::fs::remove_file(&fp).is_ok() {
                        removed += 1;
                    }
                }
            }
            // 空目录顺手删掉
            let _ = std::fs::remove_dir(&p);
        }
        removed
    }

    /// 启动时清理一次，之后每天一次。需在 tokio 运行时内调用。
    pub fn spawn_cleanup_task(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        // 空闲回收：只持弱引用，Inbox 释放后自行退出
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(i) = weak.upgrade() {
                let period = (i.idle_timeout() / 4)
                    .clamp(Duration::from_millis(20), Duration::from_secs(15));
                drop(i);
                tokio::time::sleep(period).await;
                match weak.upgrade() {
                    Some(i) => {
                        i.reap_idle();
                    }
                    None => break,
                }
            }
        });
        tokio::spawn(async move {
            loop {
                let m = me.clone();
                let _ = tokio::task::spawn_blocking(move || m.cleanup_expired()).await;
                tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
            }
        })
    }
}

fn dir_size(dir: &Path) -> u64 {
    dir_stats(dir).0
}

/// （总字节数，文件数）。不进入符号链接指向的目录。
fn dir_stats(dir: &Path) -> (u64, usize) {
    let mut total = 0;
    let mut count = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let is_link = e.file_type().is_ok_and(|t| t.is_symlink());
            match e.metadata() {
                Ok(m) if m.is_dir() && !is_link => stack.push(e.path()),
                Ok(m) if m.is_dir() => {}
                Ok(m) => {
                    total += m.len();
                    count += 1;
                }
                Err(_) => {}
            }
        }
    }
    (total, count)
}

struct Incoming {
    file: tokio::fs::File,
    part_path: PathBuf,
    final_path: PathBuf,
    size: u64,
    received: u64,
    last_ack: u64,
    hasher: Sha256,
    /// `FileEnd` 先于数据到达时暂存的哈希
    pending_end: Option<Vec<u8>>,
    slot: Arc<Slot>,
}

/// 一条会话里的文件接收状态。会话结束（或丢弃）时，未完成的 `.part` 被删除。
pub struct InboxSession {
    inbox: Arc<Inbox>,
    files: HashMap<u64, Incoming>,
    /// 本会话已完成的文件：file_id -> 绝对路径，供 `TermSubmit` 的附件使用
    done: Arc<Mutex<HashMap<u64, PathBuf>>>,
}

impl InboxSession {
    /// 已完成文件表的共享句柄。
    pub fn done_files(&self) -> Arc<Mutex<HashMap<u64, PathBuf>>> {
        self.done.clone()
    }

    pub fn path_of(&self, file_id: u64) -> Option<PathBuf> {
        self.done.lock().ok().and_then(|m| m.get(&file_id).cloned())
    }

    /// 丢弃本会话里已被回收（过期）的文件。
    async fn sweep_expired(&mut self) {
        self.inbox.reap_idle();
        let ids: Vec<u64> = self
            .files
            .iter()
            .filter(|(_, f)| f.slot.expired.load(Ordering::Acquire))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.discard(id).await;
        }
    }

    fn timeout_error() -> InboxError {
        InboxError::new("FILE_IO", "上传空闲超时，已回收")
    }

    pub async fn begin(&mut self, req: &pb::FileBegin) -> Result<pb::FileAccept, InboxError> {
        self.sweep_expired().await;
        if !self.inbox.is_enabled() {
            return Err(InboxError::new("FILE_DISABLED", "被控端已关闭文件接收"));
        }
        let cfg = self.inbox.config();
        if self.files.contains_key(&req.file_id) || self.path_of(req.file_id).is_some() {
            return Err(InboxError::new("BAD_REQUEST", "file_id 重复"));
        }
        if self.files.len() >= MAX_CONCURRENT_FILES {
            return Err(InboxError::new("BAD_REQUEST", "同时上传的文件过多"));
        }
        if req.size > cfg.max_file_size {
            return Err(InboxError::new(
                "FILE_TOO_LARGE",
                format!("文件超过单文件上限 {} 字节", cfg.max_file_size),
            ));
        }
        let inbox = self.inbox.clone();
        let dir = cfg.dir.clone();
        // 统计 + 预留放在同一把锁里（直到文件建好、预留记账完成才释放）
        let _quota = inbox.quota_lock.lock().await;
        let (used, count) = tokio::task::spawn_blocking(move || dir_stats(&dir))
            .await
            .map_err(InboxError::io)?;
        let reserved = inbox.reserved.load(Ordering::Acquire);
        if used.saturating_add(reserved).saturating_add(req.size) > cfg.max_total {
            return Err(InboxError::new("FILE_TOO_LARGE", "接收目录已达总量上限"));
        }
        if count >= cfg.max_files {
            return Err(InboxError::new("FILE_TOO_LARGE", "接收目录文件数已达上限"));
        }

        let name = sanitize_filename(&req.name);
        let now = chrono::Local::now();
        let day_dir = cfg.dir.join(now.format("%Y%m%d").to_string());
        tokio::fs::create_dir_all(&day_dir)
            .await
            .map_err(InboxError::io)?;
        let stamp = now.format("%H%M%S").to_string();
        let (final_path, part_path, file) = create_unique(&day_dir, &stamp, &name).await?;
        // 拼好之后再检查一次，确认真的在 inbox 目录里面
        if !final_path.starts_with(&cfg.dir) || final_path.parent() != Some(day_dir.as_path()) {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(InboxError::new("FILE_IO", "目标路径越界"));
        }
        inbox.reserved.fetch_add(req.size, Ordering::AcqRel);
        let slot = Arc::new(Slot {
            size: req.size,
            part_path: part_path.clone(),
            last: Mutex::new(Instant::now()),
            released: AtomicBool::new(false),
            expired: AtomicBool::new(false),
        });
        inbox.register(slot.clone());
        self.files.insert(
            req.file_id,
            Incoming {
                file,
                part_path,
                final_path,
                size: req.size,
                received: 0,
                last_ack: 0,
                hasher: Sha256::new(),
                pending_end: None,
                slot,
            },
        );
        Ok(pb::FileAccept {
            file_id: req.file_id,
        })
    }

    /// 写入一块。出错时该文件已被清理。
    /// `FileEnd` 比最后几块数据先到时（交互队列优先于批量队列，可能乱序），收齐数据的那一块会触发收尾。
    pub async fn chunk(&mut self, c: &pb::FileChunk) -> Result<ChunkOutcome, InboxError> {
        let limit = self.inbox.idle_timeout();
        let Some(f) = self.files.get_mut(&c.file_id) else {
            return Err(InboxError::new("BAD_REQUEST", "未知的 file_id"));
        };
        if f.slot.expired.load(Ordering::Acquire) || f.slot.idle_for() > limit {
            self.discard(c.file_id).await;
            return Err(Self::timeout_error());
        }
        f.slot.touch();
        let bad = if c.offset != f.received {
            Some(InboxError::new("FILE_IO", "offset 不连续"))
        } else if f.received + c.data.len() as u64 > f.size {
            Some(InboxError::new("FILE_IO", "数据超出声明的大小"))
        } else {
            None
        };
        if let Some(e) = bad {
            self.discard(c.file_id).await;
            return Err(e);
        }
        if let Err(e) = f.file.write_all(&c.data).await {
            self.discard(c.file_id).await;
            return Err(InboxError::io(e));
        }
        f.hasher.update(&c.data);
        f.received += c.data.len() as u64;
        if f.received == f.size {
            if let Some(sha) = f.pending_end.take() {
                return self.finalize(c.file_id, &sha).await.map(ChunkOutcome::Done);
            }
        }
        if f.received - f.last_ack >= ACK_EVERY {
            f.last_ack = f.received;
            return Ok(ChunkOutcome::Ack(pb::FileAck {
                file_id: c.file_id,
                received: f.received,
            }));
        }
        Ok(ChunkOutcome::Continue)
    }

    /// 收到 `FileEnd`。数据已收齐则校验并改名，返回 `Some(FileDone)`；
    /// 数据还没收齐（`FileEnd` 抢在了数据块前面）则先记下哈希，返回 `None`，等最后一块到达时收尾。
    pub async fn end(&mut self, e: &pb::FileEnd) -> Result<Option<pb::FileDone>, InboxError> {
        let limit = self.inbox.idle_timeout();
        let Some(f) = self.files.get_mut(&e.file_id) else {
            return Err(InboxError::new("BAD_REQUEST", "未知的 file_id"));
        };
        if f.slot.expired.load(Ordering::Acquire) || f.slot.idle_for() > limit {
            self.discard(e.file_id).await;
            return Err(Self::timeout_error());
        }
        if f.received < f.size {
            f.pending_end = Some(e.sha256.clone());
            return Ok(None);
        }
        self.finalize(e.file_id, &e.sha256).await.map(Some)
    }

    async fn finalize(&mut self, file_id: u64, sha256: &[u8]) -> Result<pb::FileDone, InboxError> {
        let Some(mut f) = self.files.remove(&file_id) else {
            return Err(InboxError::new("BAD_REQUEST", "未知的 file_id"));
        };
        self.inbox.release(&f.slot);
        if f.received != f.size {
            let _ = tokio::fs::remove_file(&f.part_path).await;
            return Err(InboxError::new("FILE_IO", "接收的字节数与声明不符"));
        }
        if let Err(err) = f.file.flush().await {
            let _ = tokio::fs::remove_file(&f.part_path).await;
            return Err(InboxError::io(err));
        }
        if let Err(err) = f.file.sync_all().await {
            let _ = tokio::fs::remove_file(&f.part_path).await;
            return Err(InboxError::io(err));
        }
        let digest = f.hasher.clone().finalize();
        if digest.as_slice() != sha256 {
            drop(f.file);
            let _ = tokio::fs::remove_file(&f.part_path).await;
            return Err(InboxError::new("FILE_HASH_MISMATCH", "SHA-256 校验失败"));
        }
        drop(f.file);
        if let Err(err) = tokio::fs::rename(&f.part_path, &f.final_path).await {
            let _ = tokio::fs::remove_file(&f.part_path).await;
            return Err(InboxError::io(err));
        }
        let path = f.final_path.to_string_lossy().into_owned();
        if let Ok(mut m) = self.done.lock() {
            m.insert(file_id, f.final_path);
        }
        Ok(pb::FileDone {
            file_id,
            remote_path: path,
        })
    }

    pub async fn cancel(&mut self, file_id: u64) {
        self.discard(file_id).await;
    }

    async fn discard(&mut self, file_id: u64) {
        if let Some(f) = self.files.remove(&file_id) {
            self.inbox.release(&f.slot);
            drop(f.file);
            let _ = tokio::fs::remove_file(&f.part_path).await;
        }
    }

    /// 会话中断：删除所有未完成的 `.part`。
    pub async fn abort_all(&mut self) {
        let ids: Vec<u64> = self.files.keys().copied().collect();
        for id in ids {
            self.discard(id).await;
        }
    }

    /// 正在接收的文件数。
    pub fn in_progress(&self) -> usize {
        self.files.len()
    }
}

impl Drop for InboxSession {
    fn drop(&mut self) {
        // 兜底：任务被直接取消时也别留下 .part
        for (_, f) in self.files.drain() {
            self.inbox.release(&f.slot);
            let part = f.part_path.clone();
            drop(f.file);
            let _ = std::fs::remove_file(part);
        }
    }
}

/// 创建 `.part` 文件，重名时加序号。返回（最终路径，.part 路径，已打开的文件）。
async fn create_unique(
    day_dir: &Path,
    stamp: &str,
    name: &str,
) -> Result<(PathBuf, PathBuf, tokio::fs::File), InboxError> {
    let (stem, ext) = split_ext(name);
    for n in 0..1000u32 {
        let base = if n == 0 {
            format!("{stamp}-{stem}{ext}")
        } else {
            format!("{stamp}-{stem}-{n}{ext}")
        };
        let final_path = day_dir.join(&base);
        // .part 名里带随机串：否则上传 `x.png.part` 的最终名会和上传 `x.png` 的临时名相同，
        // 其中一个完成时的 rename 会替换另一个正在写的文件（审查 L6）。扩展名仍是 `.part`，清理逻辑不变
        let part_path = day_dir.join(format!("{base}.{:08x}.part", rand::random::<u32>()));
        if final_path.exists() {
            continue;
        }
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .await
        {
            Ok(f) => return Ok((final_path, part_path, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(InboxError::io(e)),
        }
    }
    Err(InboxError::new("FILE_IO", "无法生成唯一文件名"))
}

/// 拆成（主干，含点的扩展名）。
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 16 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_invisible_format(c: char) -> bool {
    // 零宽字符、双向控制字符（可用来伪造扩展名）
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// 文件名清洗：只取最后一段；替换非法字符；去掉首尾的空格和点；处理 Windows 保留名；
/// 长度截断到 200 字节（保留扩展名）；空名字给默认值。
pub fn sanitize_filename(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = name
        .chars()
        .filter(|c| !is_invisible_format(*c))
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    let stem = s
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    if s.is_empty() {
        s = "file".into();
    }
    truncate_keep_ext(&s, MAX_NAME_BYTES)
}

fn truncate_keep_ext(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let (stem, ext) = split_ext(s);
    let ext = if ext.len() < max / 2 { ext } else { "" };
    let budget = max - ext.len();
    let mut end = budget.min(stem.len());
    while end > 0 && !stem.is_char_boundary(end) {
        end -= 1;
    }
    let out = format!("{}{}", &stem[..end], ext);
    let out = out.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    if out.is_empty() {
        "file".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_cases() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(r"C:\a\b.txt"), "b.txt");
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("nul"), "_nul");
        assert_eq!(sanitize_filename("com1.tar.gz"), "_com1.tar.gz");
        assert_eq!(sanitize_filename("a."), "a");
        assert_eq!(sanitize_filename(" a b . "), "a b");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename(".."), "file");
        assert_eq!(sanitize_filename("a:b*c?.png"), "a_b_c_.png");
        assert_eq!(sanitize_filename("evil\u{202E}gnp.exe"), "evilgnp.exe");
        assert_eq!(sanitize_filename("x\0y.txt"), "x_y.txt");
        // 普通中文名保持不变
        assert_eq!(sanitize_filename("截图 2026.png"), "截图 2026.png");
    }

    #[test]
    fn long_chinese_name_truncated_keeps_ext() {
        let name = format!("{}.png", "汉".repeat(300));
        let out = sanitize_filename(&name);
        assert!(out.len() <= MAX_NAME_BYTES, "len={}", out.len());
        assert!(out.ends_with(".png"));
        assert!(out.starts_with('汉'));
        // 无扩展名的超长名
        let out = sanitize_filename(&"a".repeat(500));
        assert_eq!(out.len(), MAX_NAME_BYTES);
    }

    fn sha(data: &[u8]) -> Vec<u8> {
        Sha256::digest(data).to_vec()
    }

    fn new_inbox(dir: &Path) -> Arc<Inbox> {
        Inbox::new(InboxConfig::new(dir.to_path_buf()))
    }

    async fn upload(
        s: &mut InboxSession,
        id: u64,
        name: &str,
        data: &[u8],
        hash: Vec<u8>,
    ) -> Result<pb::FileDone, InboxError> {
        s.begin(&pb::FileBegin {
            file_id: id,
            name: name.into(),
            size: data.len() as u64,
            mime: String::new(),
        })
        .await?;
        let mut off = 0usize;
        for part in data.chunks(32 * 1024) {
            s.chunk(&pb::FileChunk {
                file_id: id,
                offset: off as u64,
                data: part.to_vec(),
            })
            .await?;
            off += part.len();
        }
        s.end(&pb::FileEnd {
            file_id: id,
            sha256: hash,
        })
        .await?
        .ok_or_else(|| InboxError::new("BAD_REQUEST", "deferred"))
    }

    #[tokio::test]
    async fn upload_ok_and_hash_matches() {
        let tmp = tempfile::tempdir().expect("tmp");
        let inbox = new_inbox(tmp.path());
        let mut s = inbox.session();
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let done = upload(&mut s, 1, "../x/测试 文件.bin", &data, sha(&data))
            .await
            .expect("上传");
        let p = PathBuf::from(&done.remote_path);
        assert!(p.starts_with(tmp.path()));
        assert_eq!(std::fs::read(&p).expect("read"), data);
        assert!(p
            .file_name()
            .map(|n| n.to_string_lossy().ends_with("测试 文件.bin"))
            .unwrap_or(false));
        assert_eq!(s.path_of(1), Some(p));
        // 没有残留 .part
        let leftover = walk(tmp.path())
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "part"))
            .count();
        assert_eq!(leftover, 0);
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut st = vec![dir.to_path_buf()];
        while let Some(d) = st.pop() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    if e.path().is_dir() {
                        st.push(e.path());
                    } else {
                        out.push(e.path());
                    }
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn hash_mismatch_deletes_file() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut s = new_inbox(tmp.path()).session();
        let r = upload(&mut s, 1, "a.txt", b"hello", vec![0u8; 32]).await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_HASH_MISMATCH"));
        assert!(walk(tmp.path()).is_empty(), "校验失败后不应留下任何文件");
    }

    #[tokio::test]
    async fn limits_and_disable() {
        let tmp = tempfile::tempdir().expect("tmp");
        let inbox = new_inbox(tmp.path());
        inbox.set_limits(10, 25);
        let mut s = inbox.session();
        let r = s
            .begin(&pb::FileBegin {
                file_id: 1,
                name: "a".into(),
                size: 11,
                mime: String::new(),
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_TOO_LARGE"));
        // 总量：预留 10 + 10，第三个 10 超过 25
        assert!(s
            .begin(&pb::FileBegin {
                file_id: 2,
                name: "b".into(),
                size: 10,
                mime: String::new()
            })
            .await
            .is_ok());
        assert!(s
            .begin(&pb::FileBegin {
                file_id: 3,
                name: "c".into(),
                size: 10,
                mime: String::new()
            })
            .await
            .is_ok());
        let r = s
            .begin(&pb::FileBegin {
                file_id: 4,
                name: "d".into(),
                size: 10,
                mime: String::new(),
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_TOO_LARGE"));
        s.abort_all().await;
        assert_eq!(inbox.reserved.load(Ordering::Acquire), 0);
        inbox.set_enabled(false);
        let r = s
            .begin(&pb::FileBegin {
                file_id: 5,
                name: "e".into(),
                size: 1,
                mime: String::new(),
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_DISABLED"));
    }

    #[tokio::test]
    async fn bad_offset_and_oversize_cancel_file() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut s = new_inbox(tmp.path()).session();
        s.begin(&pb::FileBegin {
            file_id: 1,
            name: "a".into(),
            size: 10,
            mime: String::new(),
        })
        .await
        .expect("begin");
        let r = s
            .chunk(&pb::FileChunk {
                file_id: 1,
                offset: 5,
                data: vec![1; 3],
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_IO"));
        assert_eq!(s.in_progress(), 0);
        assert!(walk(tmp.path()).is_empty());
        s.begin(&pb::FileBegin {
            file_id: 2,
            name: "a".into(),
            size: 4,
            mime: String::new(),
        })
        .await
        .expect("begin");
        let r = s
            .chunk(&pb::FileChunk {
                file_id: 2,
                offset: 0,
                data: vec![1; 5],
            })
            .await;
        assert!(r.is_err());
        assert!(walk(tmp.path()).is_empty());
    }

    #[tokio::test]
    async fn cancel_and_drop_remove_part() {
        let tmp = tempfile::tempdir().expect("tmp");
        let inbox = new_inbox(tmp.path());
        let mut s = inbox.session();
        s.begin(&pb::FileBegin {
            file_id: 1,
            name: "a".into(),
            size: 10,
            mime: String::new(),
        })
        .await
        .expect("begin");
        s.chunk(&pb::FileChunk {
            file_id: 1,
            offset: 0,
            data: vec![1; 3],
        })
        .await
        .expect("chunk");
        assert!(!walk(tmp.path()).is_empty());
        s.cancel(1).await;
        assert!(walk(tmp.path()).is_empty());
        s.begin(&pb::FileBegin {
            file_id: 2,
            name: "b".into(),
            size: 10,
            mime: String::new(),
        })
        .await
        .expect("begin");
        drop(s);
        assert!(walk(tmp.path()).is_empty(), "丢弃会话后 .part 应被删除");
        assert_eq!(inbox.reserved.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn ack_every_256k_and_duplicate_names() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut s = new_inbox(tmp.path()).session();
        let data = vec![7u8; 600 * 1024];
        s.begin(&pb::FileBegin {
            file_id: 1,
            name: "a.bin".into(),
            size: data.len() as u64,
            mime: String::new(),
        })
        .await
        .expect("begin");
        let mut acks = 0;
        for (i, c) in data.chunks(32 * 1024).enumerate() {
            let r = s
                .chunk(&pb::FileChunk {
                    file_id: 1,
                    offset: (i * 32 * 1024) as u64,
                    data: c.to_vec(),
                })
                .await
                .expect("chunk");
            if matches!(r, ChunkOutcome::Ack(_)) {
                acks += 1;
            }
        }
        assert_eq!(acks, 2);
        s.end(&pb::FileEnd {
            file_id: 1,
            sha256: sha(&data),
        })
        .await
        .expect("end");
        // 同一秒内两个同名文件：序号区分
        let a = upload(&mut s, 2, "same.txt", b"1", sha(b"1"))
            .await
            .expect("a");
        let b = upload(&mut s, 3, "same.txt", b"2", sha(b"2"))
            .await
            .expect("b");
        assert_ne!(a.remote_path, b.remote_path);
    }

    #[tokio::test]
    async fn end_before_last_chunk_is_deferred() {
        // 交互队列优先于批量队列：FileEnd 可能抢在数据块前面到达
        let tmp = tempfile::tempdir().expect("tmp");
        let mut s = new_inbox(tmp.path()).session();
        let data = vec![5u8; 70_000];
        s.begin(&pb::FileBegin {
            file_id: 1,
            name: "late.bin".into(),
            size: data.len() as u64,
            mime: String::new(),
        })
        .await
        .expect("begin");
        s.chunk(&pb::FileChunk {
            file_id: 1,
            offset: 0,
            data: data[..32768].to_vec(),
        })
        .await
        .expect("c1");
        assert_eq!(
            s.end(&pb::FileEnd {
                file_id: 1,
                sha256: sha(&data)
            })
            .await,
            Ok(None)
        );
        s.chunk(&pb::FileChunk {
            file_id: 1,
            offset: 32768,
            data: data[32768..65536].to_vec(),
        })
        .await
        .expect("c2");
        let r = s
            .chunk(&pb::FileChunk {
                file_id: 1,
                offset: 65536,
                data: data[65536..].to_vec(),
            })
            .await
            .expect("c3");
        match r {
            ChunkOutcome::Done(d) => assert_eq!(std::fs::read(&d.remote_path).expect("read"), data),
            other => panic!("最后一块应触发收尾：{other:?}"),
        }
        // 延迟收尾时哈希错误同样被拒绝并删除文件
        s.begin(&pb::FileBegin {
            file_id: 2,
            name: "late2.bin".into(),
            size: 4,
            mime: String::new(),
        })
        .await
        .expect("begin");
        assert_eq!(
            s.end(&pb::FileEnd {
                file_id: 2,
                sha256: vec![1; 32]
            })
            .await,
            Ok(None)
        );
        let r = s
            .chunk(&pb::FileChunk {
                file_id: 2,
                offset: 0,
                data: vec![1, 2, 3, 4],
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_HASH_MISMATCH"));
        assert_eq!(walk(tmp.path()).len(), 1, "只剩第一个成功的文件");
    }

    #[test]
    fn cleanup_removes_old_files() {
        let tmp = tempfile::tempdir().expect("tmp");
        let day = tmp.path().join("20200101");
        std::fs::create_dir_all(&day).expect("mkdir");
        let old = day.join("old.txt");
        std::fs::write(&old, b"x").expect("write");
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(&old)
            .expect("open");
        let t = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        f.set_modified(t).expect("set_modified");
        drop(f);
        let fresh_day = tmp.path().join("20991231");
        std::fs::create_dir_all(&fresh_day).expect("mkdir");
        std::fs::write(fresh_day.join("new.txt"), b"y").expect("write");
        let inbox = new_inbox(tmp.path());
        assert_eq!(inbox.cleanup_expired(), 1);
        assert!(!old.exists());
        assert!(fresh_day.join("new.txt").exists());
        assert!(!day.exists(), "空目录应被删除");
    }
    /// 审查 L6：`x.png.part` 的最终名不能和 `x.png` 的临时名相同。
    #[tokio::test]
    async fn part_names_cannot_collide_with_other_final_names() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().to_path_buf();
        // 先建 `x.png.part`（最终名 T-x.png.part），再建 `x.png`
        let (final1, part1, _f1) = create_unique(&dir, "120000", "x.png.part")
            .await
            .expect("1");
        let (final2, part2, _f2) = create_unique(&dir, "120000", "x.png").await.expect("2");
        let all = [&final1, &part1, &final2, &part2];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a, b, "路径不能重复：{a:?}");
            }
        }
        assert_ne!(
            part2, final1,
            "x.png 的临时文件不能就是 x.png.part 的最终文件"
        );
        assert!(part1.extension().is_some_and(|e| e == "part"));
        assert!(part2.extension().is_some_and(|e| e == "part"));
    }

    /// 审查 L6：并发的 FileBegin 不能同时通过总量检查。
    #[tokio::test]
    async fn concurrent_begins_respect_total_quota() {
        let tmp = tempfile::tempdir().expect("tmp");
        let inbox = new_inbox(tmp.path());
        inbox.set_limits(10, 25);
        let mut tasks = Vec::new();
        for id in 0..12u64 {
            let inbox = inbox.clone();
            tasks.push(tokio::spawn(async move {
                let mut s = inbox.session();
                let r = s
                    .begin(&pb::FileBegin {
                        file_id: id,
                        name: format!("f{id}"),
                        size: 10,
                        mime: String::new(),
                    })
                    .await;
                // 成功的会话保持持有（不释放预留）
                (r.is_ok(), s)
            }));
        }
        let mut ok = 0;
        let mut keep = Vec::new();
        for t in tasks {
            let (success, s) = t.await.expect("join");
            ok += usize::from(success);
            keep.push(s);
        }
        assert_eq!(ok, 2, "总量 25、每个 10：最多 2 个能通过");
        assert!(inbox.reserved.load(Ordering::Acquire) <= 20);
    }

    /// 审查 L6：大小为 0 的文件不占配额，但文件数有上限。
    #[tokio::test]
    async fn file_count_is_capped() {
        let tmp = tempfile::tempdir().expect("tmp");
        let inbox = new_inbox(tmp.path());
        {
            let mut c = inbox.cfg.write().expect("lock");
            c.max_files = 3;
        }
        let mut s = inbox.session();
        for id in 0..3u64 {
            upload(&mut s, id, &format!("z{id}"), b"", sha(b""))
                .await
                .expect("空文件上传");
        }
        let r = s
            .begin(&pb::FileBegin {
                file_id: 9,
                name: "z9".into(),
                size: 0,
                mime: String::new(),
            })
            .await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_TOO_LARGE"));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_symlinked_dirs() {
        let tmp = tempfile::tempdir().expect("tmp");
        let outside = tempfile::tempdir().expect("outside");
        let victim = outside.path().join("old.txt");
        std::fs::write(&victim, b"x").expect("w");
        let old = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        let f = std::fs::File::options()
            .write(true)
            .open(&victim)
            .expect("open");
        f.set_modified(old).expect("mtime");
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("20200101")).expect("link");
        let inbox = new_inbox(tmp.path());
        inbox.cleanup_expired();
        assert!(victim.exists(), "不能跟随符号链接删除 inbox 之外的文件");
    }

    fn begin_req(id: u64, size: u64) -> pb::FileBegin {
        pb::FileBegin {
            file_id: id,
            name: format!("idle{id}.bin"),
            size,
            mime: String::new(),
        }
    }

    /// 审查 L6：只声明大小不发数据的 FileBegin，超时后回收预留并删除 .part。
    #[tokio::test]
    async fn idle_file_is_reaped_and_reservation_released() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut cfg = InboxConfig::new(tmp.path().to_path_buf());
        cfg.max_total = 1000;
        cfg.idle_timeout = Duration::from_millis(80);
        let inbox = Inbox::new(cfg);
        let mut a = inbox.session();
        a.begin(&begin_req(1, 1000)).await.expect("begin");
        // 预留占满：另一个会话进不来
        let mut b = inbox.session();
        assert_eq!(
            b.begin(&begin_req(1, 10)).await.err().map(|e| e.code),
            Some("FILE_TOO_LARGE")
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        // 另一个会话的 begin 触发回收，预留被释放
        b.begin(&begin_req(1, 10)).await.expect("回收后可再预留");
        assert_eq!(walk(tmp.path()).len(), 1, "过期的 .part 已删除");
        // 原会话继续发数据得到超时错误
        let r = a
            .chunk(&pb::FileChunk {
                file_id: 1,
                offset: 0,
                data: vec![0; 4],
            })
            .await;
        let e = r.expect_err("应超时");
        assert_eq!(e.code, "FILE_IO");
        assert_eq!(a.in_progress(), 0);
        // 预留没有被重复扣减
        assert_eq!(inbox.reserved.load(Ordering::Acquire), 10);
    }

    #[tokio::test]
    async fn active_uploads_are_not_reaped() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut cfg = InboxConfig::new(tmp.path().to_path_buf());
        cfg.idle_timeout = Duration::from_millis(300);
        let inbox = Inbox::new(cfg);
        let mut s = inbox.session();
        s.begin(&begin_req(1, 8)).await.expect("begin");
        for i in 0..4u64 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(inbox.reap_idle(), 0);
            s.chunk(&pb::FileChunk {
                file_id: 1,
                offset: i * 2,
                data: vec![1, 2],
            })
            .await
            .expect("chunk");
        }
    }

    #[tokio::test]
    async fn idle_reaping_still_respects_file_count_cap() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut cfg = InboxConfig::new(tmp.path().to_path_buf());
        cfg.max_files = 2;
        cfg.idle_timeout = Duration::from_secs(60);
        let inbox = Inbox::new(cfg);
        let mut s = inbox.session();
        s.begin(&begin_req(1, 0)).await.expect("b1");
        s.begin(&begin_req(2, 0)).await.expect("b2");
        let r = s.begin(&begin_req(3, 0)).await;
        assert_eq!(r.err().map(|e| e.code), Some("FILE_TOO_LARGE"));
    }
}
