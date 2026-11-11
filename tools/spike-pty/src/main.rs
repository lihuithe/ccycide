//! S1 原型：开发指南原版示例，加了时间戳日志，并修复了“卡住”的问题。
//!
//! 原因：Win10 19044 的系统 ConPTY 启动时会输出 `ESC[6n`（查询光标位置）并一直等回应；原示例不应答，
//! 子进程卡在初始化，约 40 秒后以 0xC0000142 退出。修复：读线程里发现 `ESC[6n` 就写回 `ESC[1;1R`。
//! 对比：去掉下面读线程里的应答，`child.wait()` 约 40 秒才返回，且只读到这 4 个字节。
//! 正式实现见 crates/rterm-core/src/host/pty.rs。
use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    let t0 = Instant::now();
    let log = |s: &str| eprintln!("[{:>6}ms] {s}", t0.elapsed().as_millis());
    let prog = std::env::args().nth(1).unwrap_or_else(|| "cmd.exe".into());
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })?;
    let mut cmd = CommandBuilder::new(&prog);
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd)?;
    log("spawned");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let writer = std::sync::Arc::new(std::sync::Mutex::new(writer));
    let wr2 = writer.clone();
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf[..n].windows(4).any(|w| w == b"[6n") { eprintln!("got DSR, replying"); let _ = wr2.lock().unwrap().write_all(b"[1;1R"); }
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::sleep(Duration::from_millis(800));
    writer.lock().unwrap().write_all(b"echo RTERM_PTY_OK\r")?;
    writer.lock().unwrap().flush()?;
    std::thread::sleep(Duration::from_millis(800));
    pair.master.resize(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })?;
    writer.lock().unwrap().write_all(b"exit\r")?;
    writer.lock().unwrap().flush()?;
    log("exit written, calling child.wait()");
    let status = child.wait()?;
    log(&format!("子进程退出: {status:?}"));
    drop(writer);
    drop(pair.master);
    log("master dropped");
    let mut all = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => all.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    println!("共读到 {} 字节，读线程已结束 = {}", all.len(), reader_thread.is_finished());
    println!("{:?}", String::from_utf8_lossy(&all));
    Ok(())
}
