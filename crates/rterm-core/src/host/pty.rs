//! PTY 封装（《实现方案.md》5.5.1，《开发指南.md》T12）。
//!
//! 基于 `portable-pty`，对外是异步接口：
//! - 读线程：阻塞读 PTY，经有界通道（容量 64）送出。上层停止取数据，读线程就阻塞，
//!   系统管道写满后远端程序自然被阻塞——这是流控的底层机制。
//! - 写线程：串行执行写入 / 调整尺寸 / 关闭。
//! - 等待线程：`child.wait()`，返回后先发出退出码，再关闭 PTY，让读线程结束。
//!
//! Windows 专有：
//! - 作业对象（`KILL_ON_JOB_CLOSE`）：杀进程树，客户端退出或崩溃时不留孤儿进程。
//! - ConPTY 启动时会发 `ESC[6n`（查询光标位置）并等待回应；没有回应时子进程一直卡在初始化，
//!   约 40 秒后以 0xC0000142 退出。这就是《开发指南》S1 示例在 Win10 19044 上"卡住"的原因
//!   （详见 `docs/M0-验证结论.md`）。这里在读线程里代答一次 `ESC[1;1R`，并把这条查询从输出里剔除，
//!   避免主控端的 xterm.js 再答一次而把应答当作按键输入 shell。
//! - `conpty.dll` / `OpenConsole.exe`：`portable-pty` 会优先加载"可执行文件同目录"的 `conpty.dll`，
//!   所以安装包只要把两个文件放在可执行文件旁边即可，不需要额外代码。
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot};

/// 读线程到上层的有界通道容量。
pub const OUTPUT_CHANNEL_CAP: usize = 64;
/// 窗口尺寸变化的防抖时间。
pub const RESIZE_DEBOUNCE: Duration = Duration::from_millis(50);
/// Unix 上 SIGHUP 之后等多久再 SIGKILL。
pub const KILL_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("启动失败：{0}")]
    Spawn(String),
    #[error("PTY 已关闭")]
    Closed,
}

enum PtyInput {
    Write(Vec<u8>),
    Resize(u16, u16),
}

/// 一个 PTY 的输出与退出通知。控制接口见 [`PtyControl`]。
pub struct PtyHandle {
    /// PTY 的输出。读线程结束（PTY 关闭）后返回 `None`。
    pub output: mpsc::Receiver<Vec<u8>>,
    /// 子进程退出码（被信号终止时为 128+信号 或 -1）。
    pub exit: oneshot::Receiver<i32>,
    pub control: PtyControl,
}

#[derive(Clone)]
pub struct PtyControl {
    inner: Arc<ControlInner>,
}

struct ControlInner {
    input: mpsc::Sender<PtyInput>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    pending_size: Mutex<(u16, u16)>,
    resize_gen: AtomicU64,
    exited: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(windows)]
    job: Mutex<Option<job::Job>>,
}

impl PtyControl {
    /// 子进程（shell）的进程号。
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    pub fn has_exited(&self) -> bool {
        self.inner.exited.load(Ordering::Acquire)
    }

    /// 写入原始字节。写线程把它们依次写进 PTY。
    pub async fn write(&self, data: Vec<u8>) -> Result<(), PtyError> {
        self.inner
            .input
            .send(PtyInput::Write(data))
            .await
            .map_err(|_| PtyError::Closed)
    }

    /// 调整尺寸，带 50ms 防抖：窗口拖动时只有最后一次生效。必须在 tokio 运行时内调用。
    pub fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        if let Ok(mut p) = self.inner.pending_size.lock() {
            *p = (cols, rows);
        }
        let generation = self.inner.resize_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RESIZE_DEBOUNCE).await;
            if inner.resize_gen.load(Ordering::Acquire) != generation {
                return;
            }
            let (c, r) = inner
                .pending_size
                .lock()
                .map(|p| *p)
                .unwrap_or((cols, rows));
            let _ = inner.input.send(PtyInput::Resize(c, r)).await;
        });
    }

    /// 立刻强制结束。Windows 上终止整个作业对象（进程树）；Unix 上对进程组发 SIGKILL。
    pub fn kill(&self) {
        self.inner.kill_now();
    }

    /// 优雅关闭：Windows 直接终止进程树；Unix 先 SIGHUP，`grace` 内没退出再 SIGKILL。
    pub async fn close(&self, grace: Duration) {
        #[cfg(unix)]
        {
            self.inner.signal_group(libc::SIGHUP);
            let deadline = tokio::time::Instant::now() + grace;
            while tokio::time::Instant::now() < deadline {
                if self.has_exited() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.inner.kill_now();
        }
        #[cfg(not(unix))]
        {
            let _ = grace;
            self.inner.kill_now();
        }
    }
}

impl ControlInner {
    fn kill_now(&self) {
        #[cfg(windows)]
        {
            if let Ok(j) = self.job.lock() {
                if let Some(j) = j.as_ref() {
                    j.terminate();
                }
            }
        }
        #[cfg(unix)]
        {
            self.signal_group(libc::SIGKILL);
        }
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }

    #[cfg(unix)]
    fn signal_group(&self, sig: i32) {
        if let Some(pid) = self.pid {
            // portable-pty 在子进程里 setsid，shell 是新进程组的组长，组号 = pid。
            unsafe {
                libc::killpg(pid as i32, sig);
            }
        }
    }
}

impl Drop for ControlInner {
    fn drop(&mut self) {
        // 最后一个控制句柄消失：终端被丢弃，别留下进程。
        if !self.exited.load(Ordering::Acquire) {
            self.kill_now();
        }
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 作业对象：关闭句柄（包括本进程崩溃）时，作业内所有进程被系统终止。
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let e = std::io::Error::last_os_error();
                    CloseHandle(h);
                    return Err(e);
                }
                Ok(Job(h))
            }
        }

        pub fn assign(&self, process: RawHandle) -> std::io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, process as HANDLE) };
            if ok == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Windows：如果启动本进程的父进程把 Ctrl+C 设成了"忽略"，这个标志会被子进程继承，
/// shell 里的程序就收不到 Ctrl+C（实测：从某些工具外壳里启动时 `ping -t` 按 Ctrl+C 不会停）。
/// 在第一次启动 PTY 之前恢复默认处理。
#[cfg(windows)]
fn ensure_ctrl_c_enabled() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    });
}

/// 找 `ESC[6n` 的位置。
fn find_dsr(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\x1b[6n")
}

/// 启动 PTY 与子进程。必须在 tokio 运行时内调用（用到 `tokio::sync` 的阻塞接口，线程本身是普通线程）。
pub fn spawn_pty(spec: SpawnSpec) -> Result<PtyHandle, PtyError> {
    #[cfg(windows)]
    ensure_ctrl_c_enabled();
    let size = PtySize {
        rows: spec.rows.max(1),
        cols: spec.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    let mut cmd = CommandBuilder::new(&spec.program);
    for a in &spec.args {
        cmd.arg(a);
    }
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| PtyError::Spawn(e.to_string()))?;
    // 必须丢掉从端，否则子进程退出后读不到结束标志
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();

    #[cfg(windows)]
    let job = {
        let j = job::Job::new().ok();
        if let (Some(j), Some(h)) = (j.as_ref(), child.as_raw_handle()) {
            if let Err(e) = j.assign(h) {
                tracing::warn!("加入作业对象失败：{e}");
            }
        }
        j
    };

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| PtyError::Spawn(e.to_string()))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| PtyError::Spawn(e.to_string()))?;
    let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(Mutex::new(Some(pair.master)));

    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_CHANNEL_CAP);
    let (in_tx, mut in_rx) = mpsc::channel::<PtyInput>(256);
    let (exit_tx, exit_rx) = oneshot::channel::<i32>();
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // 读线程
    let dsr_reply = in_tx.clone();
    std::thread::Builder::new()
        .name("pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 32 * 1024];
            let mut dsr_pending = cfg!(windows);
            let mut bytes_seen = 0usize;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut chunk = buf[..n].to_vec();
                        if dsr_pending {
                            bytes_seen += n;
                            if let Some(pos) = find_dsr(&chunk) {
                                // 代答一次，并从输出中剔除
                                chunk.drain(pos..pos + 4);
                                let _ =
                                    dsr_reply.blocking_send(PtyInput::Write(b"\x1b[1;1R".to_vec()));
                                dsr_pending = false;
                            } else if bytes_seen > 4096 {
                                dsr_pending = false;
                            }
                        }
                        if chunk.is_empty() {
                            continue;
                        }
                        if out_tx.blocking_send(chunk).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    // 写线程
    let master_w = master.clone();
    std::thread::Builder::new()
        .name("pty-write".into())
        .spawn(move || {
            while let Some(msg) = in_rx.blocking_recv() {
                match msg {
                    PtyInput::Write(data) => {
                        if writer.write_all(&data).is_err() || writer.flush().is_err() {
                            break;
                        }
                    }
                    PtyInput::Resize(cols, rows) => {
                        if let Ok(g) = master_w.lock() {
                            if let Some(m) = g.as_ref() {
                                let _ = m.resize(PtySize {
                                    rows,
                                    cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                });
                            }
                        }
                    }
                }
            }
        })
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    // 等待线程：Windows 上 ConPTY 在子进程退出后不一定关闭输出管道，必须主动关闭 PTY，读线程才会返回。
    let exited_w = exited.clone();
    std::thread::Builder::new()
        .name("pty-wait".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(st) => st.exit_code() as i32,
                Err(_) => -1,
            };
            exited_w.store(true, Ordering::Release);
            let _ = exit_tx.send(code);
            // 关闭 PTY（ClosePseudoConsole / 关闭 master），读线程随后读到 EOF
            if let Ok(mut g) = master.lock() {
                g.take();
            }
        })
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    let control = PtyControl {
        inner: Arc::new(ControlInner {
            input: in_tx,
            killer: Mutex::new(killer),
            pid,
            pending_size: Mutex::new((size.cols, size.rows)),
            resize_gen: AtomicU64::new(0),
            exited,
            #[cfg(windows)]
            job: Mutex::new(job),
        }),
    };
    Ok(PtyHandle {
        output: out_rx,
        exit: exit_rx,
        control,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_spec() -> SpawnSpec {
        if cfg!(windows) {
            SpawnSpec {
                program: "cmd.exe".into(),
                args: vec!["/K".into(), "chcp 65001 >nul".into()],
                cols: 100,
                rows: 30,
                ..Default::default()
            }
        } else {
            SpawnSpec {
                program: "/bin/sh".into(),
                cols: 100,
                rows: 30,
                ..Default::default()
            }
        }
    }

    async fn read_until(h: &mut PtyHandle, needle: &str, secs: u64) -> String {
        let mut all = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), h.output.recv()).await {
                Ok(Some(c)) => {
                    all.extend_from_slice(&c);
                    if String::from_utf8_lossy(&all).contains(needle) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {}
            }
        }
        String::from_utf8_lossy(&all).into_owned()
    }

    #[tokio::test]
    async fn echo_and_exit() {
        let mut h = spawn_pty(shell_spec()).expect("spawn");
        h.control
            .write(b"echo hello_pty\r".to_vec())
            .await
            .unwrap_or_default();
        let s = read_until(&mut h, "hello_pty", 10).await;
        assert!(s.contains("hello_pty"), "输出里没有 hello_pty：{s:?}");
        h.control
            .write(b"exit\r".to_vec())
            .await
            .unwrap_or_default();
        let code = tokio::time::timeout(Duration::from_secs(10), &mut h.exit)
            .await
            .expect("等退出码超时")
            .expect("退出通道关闭");
        assert_eq!(code, 0);
        // 输出通道在 PTY 关闭后结束
        let end = tokio::time::timeout(Duration::from_secs(10), async {
            while h.output.recv().await.is_some() {}
        })
        .await;
        assert!(end.is_ok(), "输出通道没有关闭（读线程未返回）");
    }

    #[tokio::test]
    async fn kill_ends_all_threads() {
        let mut h = spawn_pty(shell_spec()).expect("spawn");
        let _ = read_until(&mut h, ">", 5).await;
        h.control.kill();
        let r = tokio::time::timeout(Duration::from_secs(10), &mut h.exit).await;
        assert!(r.is_ok(), "kill 后没有收到退出");
        let end = tokio::time::timeout(Duration::from_secs(10), async {
            while h.output.recv().await.is_some() {}
        })
        .await;
        assert!(end.is_ok(), "kill 后输出通道没有关闭");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn kill_takes_descendants() {
        // 在 shell 里启动一个长时间运行的子进程，kill 之后确认它也没了
        let mut h = spawn_pty(shell_spec()).expect("spawn");
        let _ = read_until(&mut h, ">", 5).await;
        h.control
            .write(b"ping -n 120 127.0.0.1 > nul\r".to_vec())
            .await
            .unwrap_or_default();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let shell_pid = h.control.pid().expect("pid");
        let count = |pid: u32| crate::host::procs::descendants(pid).len();
        assert!(count(shell_pid) >= 1, "shell 下应有 ping 子进程");
        h.control.kill();
        let _ = tokio::time::timeout(Duration::from_secs(10), &mut h.exit).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(count(shell_pid), 0, "kill 之后仍有残留进程");
    }

    #[tokio::test]
    async fn backpressure_does_not_lose_data() {
        // 不读取 output 时 shell 大量输出：读线程在有界通道上阻塞，之后开始读取数据完整
        let mut h = spawn_pty(shell_spec()).expect("spawn");
        let _ = read_until(&mut h, ">", 5).await;
        let cmd: &[u8] = if cfg!(windows) {
            b"for /L %i in (1,1,3000) do @echo line_%i_END\r"
        } else {
            b"i=1; while [ $i -le 3000 ]; do echo line_${i}_END; i=$((i+1)); done\r"
        };
        h.control.write(cmd.to_vec()).await.unwrap_or_default();
        tokio::time::sleep(Duration::from_secs(3)).await; // 不读
        let s = read_until(&mut h, "line_3000_END", 20).await;
        assert!(s.contains("line_3000_END"), "没读到最后一行");
        assert!(
            s.contains("line_1_END") || s.contains("line_2_END"),
            "开头的输出丢了"
        );
    }
}
