//! “有连接时阻止睡眠”（`host.preventSleepWhenConnected`）。核心库不处理它，桌面端自己做：
//! - Windows：`SetThreadExecutionState`（只对调用线程生效，所以放在一个常驻线程里）；
//! - macOS：`caffeinate -i -w <本进程>`；
//! - Linux：`systemd-inhibit ... sleep infinity`，没有 systemd 时静默忽略。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

static WANT: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<()> = OnceLock::new();

/// 设置是否需要保持唤醒（幂等，可频繁调用）。
pub fn set_keep_awake(on: bool) {
    WANT.store(on, Ordering::Relaxed);
    STARTED.get_or_init(|| {
        if let Err(e) = std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(worker)
        {
            tracing::warn!("无法启动防睡眠线程：{e}");
        }
    });
}

#[cfg(windows)]
fn worker() {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let mut applied = false;
    loop {
        let want = WANT.load(Ordering::Relaxed);
        if want != applied {
            let flags = if want {
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            // SAFETY: 纯 Win32 调用，参数是合法的标志位
            unsafe {
                SetThreadExecutionState(flags);
            }
            applied = want;
            tracing::info!("防睡眠：{}", if want { "开启" } else { "关闭" });
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(not(windows))]
fn worker() {
    use std::process::{Child, Command, Stdio};
    let mut child: Option<Child> = None;
    loop {
        let want = WANT.load(Ordering::Relaxed);
        if want && child.is_none() {
            let spawned = if cfg!(target_os = "macos") {
                Command::new("caffeinate")
                    .args(["-i", "-w", &std::process::id().to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            } else {
                Command::new("systemd-inhibit")
                    .args([
                        "--what=idle:sleep",
                        "--who=RTerm",
                        "--why=有远程连接",
                        "sleep",
                        "infinity",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            };
            match spawned {
                Ok(c) => {
                    tracing::info!("防睡眠：开启");
                    child = Some(c);
                }
                Err(e) => {
                    tracing::warn!("无法开启防睡眠：{e}");
                    // 不重复尝试刷日志
                    WANT.store(false, Ordering::Relaxed);
                }
            }
        } else if !want {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
                tracing::info!("防睡眠：关闭");
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
