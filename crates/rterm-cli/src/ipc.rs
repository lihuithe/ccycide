//! 命令行与后台进程（`rterm-cli host`）之间的本机 IPC。
//!
//! 约定：
//! - 传输：`interprocess` 的本地套接字。Unix 是 `<配置目录>/rterm.sock`（权限 0600），Windows 是命名管道
//!   `rterm-ipc-<配置目录路径的哈希>`（同一台机器上用不同 `--data-dir` 可以同时跑多个实例）；
//! - 每个连接一问一答：客户端发一行 JSON（[`Request`]），服务端回一行 JSON（[`Response`]）后关闭；单行上限 64KB；
//! - 只有同一用户能连上（Unix 靠文件权限，Windows 靠命名管道的默认访问控制）。
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::{Listener as _, Stream as _};
use interprocess::local_socket::ListenerOptions;
use rterm_core::core::{format_device_code, Core};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

pub const MAX_LINE: u64 = 64 * 1024;
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Ping,
    Status,
    /// 显示当前临时密码
    PasswdShow,
    /// 刷新临时密码并返回新密码
    PasswdRandom,
    /// 设置固定密码；`password` 为 None 表示清除
    PasswdSet {
        password: Option<String>,
    },
    ConfigGet {
        key: String,
    },
    ConfigSet {
        key: String,
        value: String,
    },
    /// 接受 / 拒绝等待确认的来访连接；`session` 为空时作用于唯一的等待项
    Accept {
        session: Option<String>,
    },
    Reject {
        session: Option<String>,
    },
    /// 断开来访会话；`session` 为空且 `all` 为真断开全部
    Disconnect {
        session: Option<String>,
        all: bool,
    },
    /// 让后台进程优雅退出
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
}

impl Response {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            error: None,
            error_code: None,
            data,
        }
    }

    pub fn err(code: &str, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            error_code: Some(code.to_string()),
            data: serde_json::Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IncomingRow {
    pub session_id: String,
    pub from_code: String,
    pub platform: String,
    pub started_at: u64,
    pub pending_confirm: bool,
}

/// `status` 的返回内容。临时密码不在其中（用 `passwd` 查看）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusData {
    pub pid: u32,
    pub uptime_secs: u64,
    pub device_code: String,
    pub registered: bool,
    pub online: bool,
    pub last_error: Option<String>,
    pub app_version: String,
    pub platform: String,
    pub api_url: String,
    pub enabled: bool,
    pub require_confirm: bool,
    pub fixed_password_set: bool,
    pub locked_remaining_secs: Option<u64>,
    pub incoming: Vec<IncomingRow>,
}

/// 端点名：Unix 是套接字文件路径，Windows 是命名管道名。
pub fn endpoint_name(config_dir: &Path) -> String {
    #[cfg(unix)]
    {
        config_dir.join("rterm.sock").to_string_lossy().into_owned()
    }
    #[cfg(not(unix))]
    {
        // FNV-1a，保证同一目录得到同一个名字
        let s = config_dir
            .to_string_lossy()
            .to_lowercase()
            .replace('/', "\\");
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        format!("rterm-ipc-{h:016x}")
    }
}

#[cfg(unix)]
fn to_name(endpoint: &str) -> io::Result<interprocess::local_socket::Name<'static>> {
    use interprocess::local_socket::{GenericFilePath, ToFsName};
    endpoint.to_string().to_fs_name::<GenericFilePath>()
}

#[cfg(not(unix))]
fn to_name(endpoint: &str) -> io::Result<interprocess::local_socket::Name<'static>> {
    use interprocess::local_socket::{GenericNamespaced, ToNsName};
    endpoint.to_string().to_ns_name::<GenericNamespaced>()
}

/// 创建监听端。同一个目录已有实例在运行时返回 `AddrInUse`。
pub async fn bind(config_dir: &Path) -> io::Result<Listener> {
    let endpoint = endpoint_name(config_dir);
    if request(config_dir, &Request::Ping).await.is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "已经有一个 rterm-cli host 在运行（同一个数据目录）",
        ));
    }
    #[cfg(unix)]
    {
        use interprocess::os::unix::local_socket::ListenerOptionsExt;
        std::fs::create_dir_all(config_dir)?;
        // 上次异常退出遗留的套接字文件
        let _ = std::fs::remove_file(&endpoint);
        let mk = || -> io::Result<ListenerOptions<'static>> {
            Ok(ListenerOptions::new().name(to_name(&endpoint)?))
        };
        match mk()?.mode(0o600).create_tokio() {
            Ok(l) => Ok(l),
            Err(e) if e.kind() == io::ErrorKind::Unsupported => {
                let l = mk()?.create_tokio()?;
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600));
                Ok(l)
            }
            Err(e) => Err(e),
        }
    }
    #[cfg(not(unix))]
    {
        ListenerOptions::new()
            .name(to_name(&endpoint)?)
            .create_tokio()
    }
}

/// 退出时清理套接字文件（Windows 无事可做）。
pub fn cleanup(config_dir: &Path) {
    #[cfg(unix)]
    let _ = std::fs::remove_file(endpoint_name(config_dir));
    #[cfg(not(unix))]
    let _ = config_dir;
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> io::Result<String> {
    let mut line = String::new();
    let n = r.take(MAX_LINE).read_line(&mut line).await?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "连接已关闭"));
    }
    Ok(line)
}

/// 客户端：发一个请求，等回复。后台进程没运行时返回连接错误。
pub async fn request(config_dir: &Path, req: &Request) -> io::Result<Response> {
    let endpoint = endpoint_name(config_dir);
    let fut = async {
        let mut conn = Stream::connect(to_name(&endpoint)?).await?;
        let mut line = serde_json::to_vec(req).map_err(io::Error::other)?;
        line.push(b'\n');
        conn.write_all(&line).await?;
        conn.flush().await?;
        let mut rx = BufReader::new(conn);
        let resp = read_line(&mut rx).await?;
        serde_json::from_str::<Response>(&resp)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    };
    tokio::time::timeout(CLIENT_TIMEOUT, fut)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "后台进程没有响应"))?
}

/// 服务端主循环。`stop` 被 `Request::Stop` 触发。
pub async fn serve(listener: Listener, core: Core, stop: Arc<Notify>, started: Instant) {
    loop {
        let conn = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!("ipc accept 失败：{e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let (core, stop) = (core.clone(), stop.clone());
        tokio::spawn(async move {
            let mut rx = BufReader::new(&conn);
            let resp = match tokio::time::timeout(Duration::from_secs(5), read_line(&mut rx)).await
            {
                Ok(Ok(line)) => match serde_json::from_str::<Request>(&line) {
                    Ok(req) => handle(&core, req, &stop, started).await,
                    Err(e) => Response::err("BAD_REQUEST", format!("无法解析请求：{e}")),
                },
                _ => return,
            };
            if let Ok(mut out) = serde_json::to_vec(&resp) {
                out.push(b'\n');
                let mut tx = &conn;
                let _ = tx.write_all(&out).await;
                let _ = tx.flush().await;
            }
        });
    }
}

fn core_err(e: rterm_core::error::CoreError) -> Response {
    Response::err(&e.code, e.message)
}

/// 把“不指定会话”解析成唯一一个候选。
fn pick_session(
    core: &Core,
    given: Option<String>,
    only_pending: bool,
) -> Result<String, Response> {
    if let Some(s) = given.filter(|s| !s.is_empty()) {
        return Ok(s);
    }
    let rows: Vec<_> = core
        .list_incoming()
        .into_iter()
        .filter(|r| !only_pending || r.pending_confirm)
        .collect();
    match rows.as_slice() {
        [one] => Ok(one.session_id.clone()),
        [] => Err(Response::err(
            "BAD_REQUEST",
            if only_pending {
                "没有等待确认的连接"
            } else {
                "没有来访会话"
            },
        )),
        _ => Err(Response::err("BAD_REQUEST", "有多个会话，请指定会话 id")),
    }
}

pub async fn handle(core: &Core, req: Request, stop: &Notify, started: Instant) -> Response {
    match req {
        Request::Ping => Response::ok(serde_json::json!({ "pid": std::process::id() })),
        Request::Status => {
            let info = core.local_info();
            let s = core.get_settings();
            let data = StatusData {
                pid: std::process::id(),
                uptime_secs: started.elapsed().as_secs(),
                device_code: info.device_code,
                registered: info.registered,
                online: info.online,
                last_error: info.last_error,
                app_version: info.app_version,
                platform: info.platform,
                api_url: core.api_url().to_string(),
                enabled: s.host.enabled,
                require_confirm: s.host.require_confirm,
                fixed_password_set: info.fixed_password_set,
                locked_remaining_secs: info.locked_remaining_secs,
                incoming: core
                    .list_incoming()
                    .into_iter()
                    .map(|r| IncomingRow {
                        session_id: r.session_id,
                        from_code: r.from_code,
                        platform: r.platform,
                        started_at: r.started_at,
                        pending_confirm: r.pending_confirm,
                    })
                    .collect(),
            };
            Response::ok(serde_json::to_value(data).unwrap_or_default())
        }
        Request::PasswdShow => {
            let info = core.local_info();
            if !info.registered {
                return Response::err("NOT_REGISTERED", "尚未连接到服务器，还没有密码");
            }
            Response::ok(serde_json::json!({ "temp_password": info.temp_password }))
        }
        Request::PasswdRandom => match core.refresh_temp_password().await {
            Ok(pw) => Response::ok(serde_json::json!({ "temp_password": pw })),
            Err(e) => core_err(e),
        },
        Request::PasswdSet { password } => match core.set_fixed_password(password.as_deref()).await
        {
            Ok(()) => Response::ok(serde_json::json!({ "fixed_password_set": password.is_some() })),
            Err(e) => core_err(e),
        },
        Request::ConfigGet { key } => match core.config_get(&key) {
            Ok(v) => Response::ok(v),
            Err(e) => core_err(e),
        },
        Request::ConfigSet { key, value } => match core.config_set(&key, &value).await {
            Ok(_) => match core.config_get(&key) {
                Ok(v) => Response::ok(v),
                Err(e) => core_err(e),
            },
            Err(e) => core_err(e),
        },
        Request::Accept { session } => match pick_session(core, session, true) {
            Ok(s) => core
                .accept_incoming(&s)
                .map(|_| Response::ok(serde_json::json!({ "session_id": s })))
                .unwrap_or_else(core_err),
            Err(r) => r,
        },
        Request::Reject { session } => match pick_session(core, session, true) {
            Ok(s) => core
                .reject_incoming(&s)
                .map(|_| Response::ok(serde_json::json!({ "session_id": s })))
                .unwrap_or_else(core_err),
            Err(r) => r,
        },
        Request::Disconnect { session, all } => {
            if all {
                core.disconnect_all_incoming();
                return Response::ok(serde_json::json!({ "all": true }));
            }
            match pick_session(core, session, false) {
                Ok(s) => {
                    core.disconnect_incoming(&s);
                    Response::ok(serde_json::json!({ "session_id": s }))
                }
                Err(r) => r,
            }
        }
        Request::Stop => {
            stop.notify_one();
            Response::ok(serde_json::Value::Null)
        }
    }
}

/// 人读的状态文本。
pub fn render_status(s: &StatusData) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "后台进程   运行中（pid {}，已运行 {}）\n",
        s.pid,
        human_secs(s.uptime_secs)
    ));
    if s.registered {
        out.push_str(&format!(
            "设备码     {}\n",
            format_device_code(&s.device_code)
        ));
    } else {
        out.push_str("设备码     （尚未注册）\n");
    }
    out.push_str(&format!("服务器     {}\n", s.api_url));
    out.push_str(&format!(
        "信令       {}\n",
        if s.online {
            "在线"
        } else {
            "离线（重连中）"
        }
    ));
    if let Some(e) = &s.last_error {
        out.push_str(&format!("提示       {e}\n"));
    }
    out.push_str(&format!(
        "允许连接   {}{}\n",
        if s.enabled {
            "是"
        } else {
            "否（已暂停）"
        },
        if s.require_confirm {
            "，连入需确认"
        } else {
            ""
        }
    ));
    out.push_str(&format!(
        "固定密码   {}\n",
        if s.fixed_password_set {
            "已设置"
        } else {
            "未设置"
        }
    ));
    if let Some(l) = s.locked_remaining_secs {
        out.push_str(&format!("锁定       剩余 {}\n", human_secs(l)));
    }
    if s.incoming.is_empty() {
        out.push_str("来访连接   无\n");
    } else {
        out.push_str(&format!("来访连接   {} 个\n", s.incoming.len()));
        for r in &s.incoming {
            out.push_str(&format!(
                "  {}  来自 {}（{}）{}\n",
                r.session_id,
                mask(&r.from_code),
                r.platform,
                if r.pending_confirm {
                    "  [等待确认]"
                } else {
                    ""
                }
            ));
        }
    }
    out
}

pub fn mask(code: &str) -> String {
    rterm_core::logging::mask_code(code)
}

pub fn human_secs(s: u64) -> String {
    if s >= 3600 {
        format!("{} 小时 {} 分", s / 3600, s % 3600 / 60)
    } else if s >= 60 {
        format!("{} 分 {} 秒", s / 60, s % 60)
    } else {
        format!("{s} 秒")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_json_shape() {
        let r = Request::PasswdSet {
            password: Some("x".into()),
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(s, r#"{"cmd":"passwd_set","password":"x"}"#);
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"cmd":"status"}"#).unwrap(),
            Request::Status
        );
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"nope"}"#).is_err());
    }

    #[test]
    fn endpoint_is_stable_per_dir() {
        let a = endpoint_name(Path::new("C:/data/a"));
        assert_eq!(a, endpoint_name(Path::new("C:/data/a")));
        assert_ne!(a, endpoint_name(Path::new("C:/data/b")));
    }

    #[tokio::test]
    async fn roundtrip_over_local_socket_and_single_instance() {
        let dir = tempfile::tempdir().unwrap();
        // 没有服务端时是连接错误
        assert!(request(dir.path(), &Request::Ping).await.is_err());

        let listener = bind(dir.path()).await.unwrap();
        let task = tokio::spawn(async move {
            // 一个只会回 ping 的最小服务端（不依赖 Core）
            loop {
                let Ok(conn) = listener.accept().await else {
                    break;
                };
                let mut rx = BufReader::new(&conn);
                let Ok(line) = read_line(&mut rx).await else {
                    continue;
                };
                let req: Request = serde_json::from_str(&line).unwrap();
                let resp = match req {
                    Request::Ping => Response::ok(serde_json::json!({ "pid": 1 })),
                    _ => Response::err("BAD_REQUEST", "x"),
                };
                let mut out = serde_json::to_vec(&resp).unwrap();
                out.push(b'\n');
                let mut tx = &conn;
                tx.write_all(&out).await.unwrap();
            }
        });
        let r = request(dir.path(), &Request::Ping).await.unwrap();
        assert!(r.ok);
        assert_eq!(r.data["pid"], 1);
        let r = request(dir.path(), &Request::Status).await.unwrap();
        assert!(!r.ok);
        assert_eq!(r.error_code.as_deref(), Some("BAD_REQUEST"));
        // 同一目录第二个实例不能再监听
        let e = bind(dir.path()).await.err().unwrap();
        assert_eq!(e.kind(), io::ErrorKind::AddrInUse);
        task.abort();
        cleanup(dir.path());
    }

    #[test]
    fn status_text_contains_key_facts() {
        let s = StatusData {
            pid: 42,
            uptime_secs: 3700,
            device_code: "123456789".into(),
            registered: true,
            online: true,
            last_error: None,
            app_version: "0.1.0".into(),
            platform: "linux".into(),
            api_url: "http://x".into(),
            enabled: true,
            require_confirm: true,
            fixed_password_set: false,
            locked_remaining_secs: Some(90),
            incoming: vec![IncomingRow {
                session_id: "S1".into(),
                from_code: "987654321".into(),
                platform: "windows".into(),
                started_at: 0,
                pending_confirm: true,
            }],
        };
        let t = render_status(&s);
        assert!(t.contains("123 456 789"));
        assert!(t.contains("*****4321"));
        assert!(t.contains("等待确认"));
        assert!(t.contains("1 小时 1 分"));
    }
}
