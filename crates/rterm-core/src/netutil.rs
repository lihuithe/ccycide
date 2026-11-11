//! 网络工具：TLS 配置、代理解析、经 HTTP CONNECT 的 WebSocket 连接（信令和中继共用）。
//!
//! - TLS 用 rustls（ring 后端），默认使用内置根证书；`use_system_certs` 为真时改用系统证书库。
//! - 代理优先级：手动填写 > 环境变量（HTTPS_PROXY / ALL_PROXY / HTTP_PROXY）> Windows 系统代理（注册表）。
//! - 所有连接都有超时。
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rustls::ClientConfig;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::{client_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream};
use url::Url;

/// 网络选项。信令、中继、HTTP API 共用。
#[derive(Debug, Clone, Default)]
pub struct NetOptions {
    /// 手动代理，形如 `http://127.0.0.1:7890` 或 `user:pass@host:port`；None 表示自动（环境变量 / 系统）。
    /// 空字符串表示明确不使用代理。
    pub proxy: Option<String>,
    /// 使用系统证书库（企业网络做 TLS 解密时需要）。
    pub use_system_certs: bool,
}

/// 连接超时（TCP + 代理隧道 + TLS + WebSocket 升级）。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("地址无效: {0}")]
    BadUrl(String),
    #[error("连接超时")]
    Timeout,
    #[error("网络错误: {0}")]
    Io(String),
    #[error("代理错误: {0}")]
    Proxy(String),
    /// WebSocket 升级被拒绝（HTTP 状态码）
    #[error("服务器拒绝升级: HTTP {0}")]
    HttpStatus(u16),
    #[error("WebSocket 错误: {0}")]
    Ws(String),
}

/// 构造 rustls 客户端配置。
pub fn tls_config(use_system_certs: bool) -> Arc<ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    if use_system_certs {
        let res = rustls_native_certs::load_native_certs();
        for cert in res.certs {
            // 单个坏证书忽略
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            tracing::warn!("系统证书库为空，回退到内置根证书");
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder =
        match ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions() {
            Ok(b) => b,
            Err(e) => {
                // ring provider 与默认协议版本必然兼容；这里仅为不使用 unwrap
                tracing::error!("TLS 配置失败: {e}");
                return Arc::new(
                    ClientConfig::builder()
                        .with_root_certificates(roots)
                        .with_no_client_auth(),
                );
            }
        };
    Arc::new(builder.with_root_certificates(roots).with_no_client_auth())
}

/// 代理地址（已解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyAddr {
    pub host: String,
    pub port: u16,
    /// 已 base64 的 `user:pass`，用于 Proxy-Authorization: Basic
    pub basic_auth: Option<String>,
}

/// 解析代理字符串。接受 `http://u:p@host:port`、`host:port`、`user:pass@host:port`。
pub fn parse_proxy(s: &str) -> Option<ProxyAddr> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let u = Url::parse(&with_scheme).ok()?;
    let host = u.host_str()?.to_string();
    let port = u.port_or_known_default().unwrap_or(8080);
    let basic_auth = if !u.username().is_empty() {
        let raw = format!(
            "{}:{}",
            percent_decode(u.username()),
            percent_decode(u.password().unwrap_or(""))
        );
        Some(base64::engine::general_purpose::STANDARD.encode(raw))
    } else {
        None
    };
    Some(ProxyAddr {
        host,
        port,
        basic_auth,
    })
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

fn env_any(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
}

/// NO_PROXY 判断（逗号分隔，支持后缀匹配和 `*`）。
fn bypass(host: &str) -> bool {
    let Some(np) = env_any(&["NO_PROXY", "no_proxy"]) else {
        return false;
    };
    np.split(',')
        .map(|s| s.trim().trim_start_matches('.'))
        .filter(|s| !s.is_empty())
        .any(|p| {
            p == "*"
                || host.eq_ignore_ascii_case(p)
                || host
                    .to_ascii_lowercase()
                    .ends_with(&format!(".{}", p.to_ascii_lowercase()))
        })
}

/// 决定访问 `host` 时使用的代理。
pub fn resolve_proxy(opts: &NetOptions, host: &str, secure: bool) -> Option<ProxyAddr> {
    if let Some(p) = &opts.proxy {
        return parse_proxy(p); // 空字符串 -> None（明确不用代理）
    }
    if bypass(host) {
        return None;
    }
    let from_env = if secure {
        env_any(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
    } else {
        env_any(&[
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ])
    };
    if let Some(p) = from_env.as_deref().and_then(parse_proxy) {
        return Some(p);
    }
    system_proxy(secure)
}

#[cfg(windows)]
fn system_proxy(secure: bool) -> Option<ProxyAddr> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    parse_windows_proxy_server(&server, secure)
}

#[cfg(not(windows))]
fn system_proxy(_secure: bool) -> Option<ProxyAddr> {
    // macOS / Linux 的系统代理设置（scutil / gsettings）留待 M0 验证后补充；目前依赖环境变量
    None
}

/// Windows 的 ProxyServer 可能是 `host:port`，也可能是 `http=h:p;https=h:p;ftp=...`。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_windows_proxy_server(s: &str, secure: bool) -> Option<ProxyAddr> {
    if !s.contains('=') {
        return parse_proxy(s);
    }
    let want = if secure { "https" } else { "http" };
    let mut fallback = None;
    for part in s.split(';') {
        if let Some((scheme, addr)) = part.split_once('=') {
            if scheme.trim().eq_ignore_ascii_case(want) {
                return parse_proxy(addr);
            }
            if scheme.trim().eq_ignore_ascii_case("http") {
                fallback = parse_proxy(addr);
            }
        }
    }
    fallback
}

/// 经 HTTP CONNECT 建立到 `host:port` 的隧道。
async fn http_connect(proxy: &ProxyAddr, host: &str, port: u16) -> Result<TcpStream, ConnectError> {
    let mut s = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|e| ConnectError::Proxy(format!("连接代理失败: {e}")))?;
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let Some(a) = &proxy.basic_auth {
        req.push_str(&format!("Proxy-Authorization: Basic {a}\r\n"));
    }
    req.push_str("Proxy-Connection: Keep-Alive\r\n\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| ConnectError::Proxy(e.to_string()))?;
    // 逐字节读到空行为止（代理响应很短；逐字节避免多读走 TLS 数据）
    let mut head = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(ConnectError::Proxy("代理响应过长".into()));
        }
        let n = s
            .read(&mut b)
            .await
            .map_err(|e| ConnectError::Proxy(e.to_string()))?;
        if n == 0 {
            return Err(ConnectError::Proxy("代理提前关闭连接".into()));
        }
        head.push(b[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        return Err(ConnectError::Proxy(format!(
            "代理拒绝 CONNECT，状态码 {status}"
        )));
    }
    Ok(s)
}

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 开发开关：允许回环地址（127.0.0.1 / localhost / ::1）使用明文 `http://` / `ws://`。
/// debug 构建默认允许；发布构建需要显式设置环境变量 `RTERM_ALLOW_INSECURE_LOOPBACK=1`。
pub const ENV_ALLOW_INSECURE: &str = "RTERM_ALLOW_INSECURE_LOOPBACK";

pub fn allow_insecure_loopback() -> bool {
    cfg!(debug_assertions)
        || std::env::var(ENV_ALLOW_INSECURE)
            .map(|v| v == "1")
            .unwrap_or(false)
}

/// 主机是不是回环地址。只认字面的 `localhost` 和回环 IP，`127.0.0.1.evil.com` 之类不算。
pub fn is_loopback_host(u: &Url) -> bool {
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// 强制 TLS（审查 L11）：API、信令、中继地址必须是 `https://` / `wss://`。
/// 只有回环地址且 `allow_loopback_plain` 为真时才允许 `http://` / `ws://`。
/// 明文传输下 `/v1/config`、信令地址、一次性票据都可能被篡改或窃取。
pub fn check_secure_url(u: &Url, allow_loopback_plain: bool) -> Result<(), String> {
    match u.scheme() {
        "https" | "wss" => Ok(()),
        "http" | "ws" => {
            if is_loopback_host(u) && allow_loopback_plain {
                Ok(())
            } else if is_loopback_host(u) {
                Err(format!(
                    "{u} 使用明文传输；回环地址上的 http/ws 仅限开发（设置 {ENV_ALLOW_INSECURE}=1）"
                ))
            } else {
                Err(format!("{u} 使用明文传输，必须使用 https/wss"))
            }
        }
        other => Err(format!("不支持的协议 {other}")),
    }
}

/// 建立 WebSocket 连接（支持 ws/wss、代理、超时）。不启用压缩（tungstenite 本身不协商 permessage-deflate）。
pub async fn connect_ws(
    url: &str,
    opts: &NetOptions,
    max_message: usize,
) -> Result<WsStream, ConnectError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, connect_ws_inner(url, opts, max_message)).await {
        Ok(r) => r,
        Err(_) => Err(ConnectError::Timeout),
    }
}

async fn connect_ws_inner(
    url: &str,
    opts: &NetOptions,
    max_message: usize,
) -> Result<WsStream, ConnectError> {
    let u = Url::parse(url).map_err(|e| ConnectError::BadUrl(format!("{url}: {e}")))?;
    let secure = match u.scheme() {
        "wss" => true,
        "ws" => false,
        other => return Err(ConnectError::BadUrl(format!("不支持的协议 {other}"))),
    };
    check_secure_url(&u, allow_insecure_loopback()).map_err(ConnectError::BadUrl)?;
    let host = u
        .host_str()
        .ok_or_else(|| ConnectError::BadUrl("缺少主机名".into()))?
        .to_string();
    let port = u
        .port_or_known_default()
        .unwrap_or(if secure { 443 } else { 80 });

    let tcp = match resolve_proxy(opts, &host, secure) {
        Some(p) => {
            tracing::debug!("经代理 {}:{} 连接 {host}:{port}", p.host, p.port);
            http_connect(&p, &host, port).await?
        }
        None => TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| ConnectError::Io(e.to_string()))?,
    };
    let _ = tcp.set_nodelay(true);

    let cfg = WebSocketConfig::default()
        .max_message_size(Some(max_message))
        .max_frame_size(Some(max_message));
    let connector = if secure {
        Some(Connector::Rustls(tls_config(opts.use_system_certs)))
    } else {
        Some(Connector::Plain)
    };
    match client_async_tls_with_config(u.as_str(), tcp, Some(cfg), connector).await {
        Ok((ws, _resp)) => Ok(ws),
        Err(WsError::Http(resp)) => Err(ConnectError::HttpStatus(resp.status().as_u16())),
        Err(e) => Err(ConnectError::Ws(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_variants() {
        let p = parse_proxy("http://127.0.0.1:7890").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("127.0.0.1", 7890));
        assert!(p.basic_auth.is_none());
        let p = parse_proxy("user:pa%40ss@proxy.local:3128").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("proxy.local", 3128));
        assert_eq!(
            p.basic_auth.as_deref(),
            Some(
                base64::engine::general_purpose::STANDARD
                    .encode("user:pa@ss")
                    .as_str()
            )
        );
        assert!(parse_proxy("").is_none());
    }

    #[test]
    fn windows_proxy_server_forms() {
        let p = parse_windows_proxy_server("http=a:1;https=b:2", true).unwrap();
        assert_eq!((p.host.as_str(), p.port), ("b", 2));
        let p = parse_windows_proxy_server("http=a:1;ftp=c:3", true).unwrap();
        assert_eq!(p.host, "a");
        let p = parse_windows_proxy_server("x:9", false).unwrap();
        assert_eq!(p.port, 9);
    }

    #[test]
    fn manual_proxy_overrides_and_empty_disables() {
        let o = NetOptions {
            proxy: Some("h:1".into()),
            use_system_certs: false,
        };
        assert_eq!(resolve_proxy(&o, "example.com", true).unwrap().host, "h");
        let o = NetOptions {
            proxy: Some(String::new()),
            use_system_certs: false,
        };
        assert!(resolve_proxy(&o, "example.com", true).is_none());
    }

    #[tokio::test]
    async fn connect_via_http_connect_proxy() {
        use tokio::net::TcpListener;
        // 目标：普通 ws 服务（回显一条文本后关闭）
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tport = target.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = target.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            use futures_util::{SinkExt, StreamExt};
            if let Some(Ok(m)) = ws.next().await {
                let _ = ws.send(m).await;
            }
        });
        // 代理：读 CONNECT，回 200，然后双向拷贝
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pport = proxy.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut c, _) = proxy.accept().await.unwrap();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                c.read_exact(&mut b).await.unwrap();
                head.push(b[0]);
            }
            let _ = seen_tx.send(String::from_utf8_lossy(&head).to_string());
            let mut up = TcpStream::connect(("127.0.0.1", tport)).await.unwrap();
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        let opts = NetOptions {
            proxy: Some(format!("u:p@127.0.0.1:{pport}")),
            use_system_certs: false,
        };
        let mut ws = connect_ws(&format!("ws://127.0.0.1:{tport}/x"), &opts, 1 << 20)
            .await
            .unwrap();
        use futures_util::{SinkExt, StreamExt};
        ws.send(tokio_tungstenite::tungstenite::Message::Text("hi".into()))
            .await
            .unwrap();
        let m = ws.next().await.unwrap().unwrap();
        assert_eq!(m.into_text().unwrap().as_str(), "hi");
        let head = seen_rx.await.unwrap();
        assert!(head.starts_with(&format!("CONNECT 127.0.0.1:{tport} HTTP/1.1")));
        assert!(head.contains("Proxy-Authorization: Basic "));
    }

    #[tokio::test]
    async fn proxy_rejects_connect() {
        use tokio::net::TcpListener;
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pport = proxy.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = proxy.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = c.read(&mut buf).await;
            c.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                .await
                .unwrap();
        });
        let opts = NetOptions {
            proxy: Some(format!("127.0.0.1:{pport}")),
            use_system_certs: false,
        };
        let r = connect_ws("wss://example.invalid:443/x", &opts, 1 << 20).await;
        assert!(matches!(r, Err(ConnectError::Proxy(_))));
    }

    /// 审查 L11：明文传输只允许回环地址且需要开发开关。
    #[test]
    fn secure_url_policy() {
        let ok = |u: &str, allow: bool| check_secure_url(&Url::parse(u).unwrap(), allow).is_ok();
        for allow in [false, true] {
            assert!(ok("https://api.example.com", allow));
            assert!(ok("wss://signal.example.com/v1/signal", allow));
            assert!(ok("https://127.0.0.1:8443", allow), "回环上的 TLS 当然可以");
            // 非回环的明文永远不行，哪怕开了开发开关
            assert!(!ok("http://api.example.com", allow));
            assert!(!ok("ws://relay.example.com:8081", allow));
            assert!(!ok("http://10.0.0.5:8080", allow));
            assert!(
                !ok("ws://127.0.0.1.evil.com/", allow),
                "不能靠域名前缀冒充回环"
            );
            assert!(!ok("http://localhost.evil.com", allow));
            assert!(!ok("http://127.0.0.1@evil.com/", allow));
            assert!(!ok("ftp://127.0.0.1/", allow));
            assert!(!ok("file:///etc/passwd", allow));
        }
        // 回环明文：没有开发开关不行，有才行
        for u in [
            "http://127.0.0.1:8080",
            "ws://localhost:8081/x",
            "ws://[::1]:8080/v1/signal",
            "http://127.5.5.5",
            "http://LOCALHOST:1",
        ] {
            assert!(!ok(u, false), "{u} 没有开关应被拒绝");
            assert!(ok(u, true), "{u} 有开关应允许");
        }
    }

    #[tokio::test]
    async fn connect_ws_refuses_plaintext_to_remote_hosts() {
        let opts = NetOptions {
            proxy: Some(String::new()),
            use_system_certs: false,
        };
        // 即使在允许回环明文的 debug 构建里，远程主机的 ws:// 也在建立任何连接之前被拒绝
        let r = connect_ws("ws://example.com/v1/signal", &opts, 1 << 20).await;
        assert!(matches!(r, Err(ConnectError::BadUrl(_))), "得到 {r:?}");
        let r = connect_ws("ws://10.1.2.3:8081/v1/relay", &opts, 1 << 20).await;
        assert!(matches!(r, Err(ConnectError::BadUrl(_))));
    }
}
