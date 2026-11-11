//! HTTP API 客户端：注册设备、拉取配置、检查更新（《实现方案.md》4.2、6.7），以及首次启动流程（T9）。
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::{ConfigError, ConfigStore, Paths};
use crate::identity::Identity;
use crate::netutil::{resolve_proxy, tls_config, NetOptions};
use crate::secrets::{default_store, SecretError, SecretStore};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// 连不上服务器 / 超时。可稍后重试。
    #[error("网络错误: {0}")]
    Network(String),
    /// 服务器返回了错误（统一错误格式 `{error:{code,message,retry_after}}`）
    #[error("服务器错误 {status} {code}: {message}")]
    Server {
        status: u16,
        code: String,
        message: String,
        retry_after: Option<u64>,
    },
    #[error("响应格式错误: {0}")]
    Decode(String),
}

impl ApiError {
    /// 是否值得稍后重试（网络问题、5xx、限流）。
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Network(_) => true,
            ApiError::Server { status, .. } => *status >= 500 || *status == 429,
            ApiError::Decode(_) => false,
        }
    }

    /// 服务端错误码（如 `BAD_TIMESTAMP`、`RATE_LIMITED`）。
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Server { code, .. } => Some(code),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    /// windows | macos | linux
    pub platform: String,
    /// x86_64 | aarch64
    pub arch: String,
    pub os_version: String,
    pub app_version: String,
    /// desktop | cli
    pub kind: String,
}

impl DeviceInfo {
    pub fn detect(app_version: &str, kind: &str) -> Self {
        let platform = match std::env::consts::OS {
            "windows" => "windows",
            "macos" => "macos",
            _ => "linux",
        };
        Self {
            platform: platform.into(),
            arch: std::env::consts::ARCH.into(),
            os_version: detect_os_version(),
            app_version: app_version.into(),
            kind: kind.into(),
        }
    }
}

#[cfg(windows)]
fn detect_os_version() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
    else {
        return "unknown".into();
    };
    let major: u32 = k.get_value("CurrentMajorVersionNumber").unwrap_or(10);
    let minor: u32 = k.get_value("CurrentMinorVersionNumber").unwrap_or(0);
    let build: String = k.get_value("CurrentBuildNumber").unwrap_or_default();
    format!("{major}.{minor}.{build}")
}

#[cfg(not(windows))]
fn detect_os_version() -> String {
    std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegisterResp {
    pub device_id: String,
    pub device_code: String,
}

/// `GET /v1/config` 的内容（6.7）。所有字段可缺省。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub signal_url: Option<String>,
    pub min_app_version: Option<String>,
    pub latest_app_version: Option<String>,
    pub features: serde_json::Value,
    pub limits: serde_json::Value,
    pub adapters: Vec<serde_json::Value>,
    pub claude_catalog: Vec<serde_json::Value>,
    /// `adapters` 与 `claude_catalog` 的 Ed25519 签名（base64），见 `config_sig`。缺失或验签失败时这两项被忽略。
    pub config_sig: Option<String>,
    pub notice: Option<serde_json::Value>,
}

/// 更新信息（Tauri updater 格式）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub url: Option<String>,
    pub signature: Option<String>,
}

pub struct ApiClient {
    http: reqwest::Client,
    base: String,
}

impl ApiClient {
    /// `api_url` 形如 `https://api.example.com`（不含 `/v1`）。
    pub fn new(api_url: &str, net: &NetOptions) -> Result<Self, ApiError> {
        let base = api_url.trim().trim_end_matches('/').to_string();
        let parsed =
            url::Url::parse(&base).map_err(|e| ApiError::Network(format!("api_url 无效: {e}")))?;
        // 强制 TLS：只有回环地址 + 开发开关才允许 http://（审查 L11）
        crate::netutil::check_secure_url(&parsed, crate::netutil::allow_insecure_loopback())
            .map_err(|e| ApiError::Network(format!("api_url 不安全: {e}")))?;
        let host = parsed.host_str().unwrap_or_default().to_string();
        let secure = parsed.scheme() == "https";

        let mut b = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("rterm-core/", env!("CARGO_PKG_VERSION")))
            .use_preconfigured_tls((*tls_config(net.use_system_certs)).clone());
        b = match resolve_proxy(net, &host, secure) {
            Some(p) => {
                let mut proxy = reqwest::Proxy::all(format!("http://{}:{}", p.host, p.port))
                    .map_err(|e| ApiError::Network(format!("代理设置无效: {e}")))?;
                if let Some(auth) = &p.basic_auth {
                    if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Basic {auth}"))
                    {
                        proxy = proxy.custom_http_auth(v);
                    }
                }
                b.proxy(proxy)
            }
            None => b.no_proxy(),
        };
        let http = b.build().map_err(|e| ApiError::Network(e.to_string()))?;
        Ok(Self { http, base })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1{}", self.base, path)
    }

    async fn error_from(resp: reqwest::Response) -> ApiError {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        #[derive(Deserialize)]
        struct Body {
            error: Inner,
        }
        #[derive(Deserialize)]
        struct Inner {
            #[serde(default)]
            code: String,
            #[serde(default)]
            message: String,
            retry_after: Option<u64>,
        }
        match serde_json::from_str::<Body>(&text) {
            Ok(b) => ApiError::Server {
                status,
                code: b.error.code,
                message: b.error.message,
                retry_after: b.error.retry_after,
            },
            Err(_) => ApiError::Server {
                status,
                code: "HTTP".into(),
                message: text.chars().take(200).collect(),
                retry_after: None,
            },
        }
    }

    async fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        rb: reqwest::RequestBuilder,
    ) -> Result<T, ApiError> {
        let resp = rb
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(Self::error_from(resp).await);
        }
        resp.json::<T>()
            .await
            .map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// 注册设备（幂等：同一公钥返回原设备码）。签名串见《开发指南.md》T3。
    pub async fn register(
        &self,
        id: &Identity,
        info: &DeviceInfo,
    ) -> Result<RegisterResp, ApiError> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let pk = id.public_key_b64();
        let signed = format!(
            "rterm-register-v1\n{pk}\n{}\n{}\n{}\n{ts}",
            info.platform, info.arch, info.kind
        );
        let sig = crate::identity::b64(&id.sign(signed.as_bytes()));
        let body = serde_json::json!({
            "public_key": pk,
            "platform": info.platform,
            "arch": info.arch,
            "os_version": info.os_version,
            "app_version": info.app_version,
            "kind": info.kind,
            "ts": ts,
            "signature": sig,
        });
        self.send_json(self.http.post(self.url("/devices/register")).json(&body))
            .await
    }

    pub async fn get_config(&self) -> Result<ServerConfig, ApiError> {
        self.send_json(self.http.get(self.url("/config"))).await
    }

    /// 检查更新。没有更新（HTTP 204）返回 None。
    pub async fn check_update(
        &self,
        target: &str,
        arch: &str,
        version: &str,
    ) -> Result<Option<UpdateInfo>, ApiError> {
        let resp = self
            .http
            .get(self.url(&format!("/update/{target}/{arch}/{version}")))
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        if resp.status().as_u16() == 204 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::error_from(resp).await);
        }
        resp.json::<UpdateInfo>()
            .await
            .map(Some)
            .map_err(|e| ApiError::Decode(e.to_string()))
    }

    pub async fn healthz(&self) -> Result<(), ApiError> {
        let resp = self
            .http
            .get(format!("{}/healthz", self.base))
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(Self::error_from(resp).await)
        }
    }
}

/// 信令地址：优先用服务端下发的 `signal_url`；没有时由 `api_url` 推导（http→ws，https→wss，路径 `/v1/signal`）。
pub fn resolve_signal_url(api_url: &str, cfg: Option<&ServerConfig>) -> String {
    if let Some(u) = cfg
        .and_then(|c| c.signal_url.clone())
        .filter(|u| !u.is_empty())
    {
        // 服务端下发的信令地址同样必须满足 TLS 要求，否则忽略，由 api_url 推导
        let secure = url::Url::parse(&u)
            .map_err(|e| e.to_string())
            .and_then(|p| {
                crate::netutil::check_secure_url(&p, crate::netutil::allow_insecure_loopback())
            });
        match secure {
            Ok(()) => return u,
            Err(e) => tracing::warn!("忽略服务端下发的不安全信令地址：{e}"),
        }
    }
    let base = api_url.trim().trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/v1/signal")
}

// ---------------------------------------------------------------- 启动流程（T9）

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Secrets(#[from] SecretError),
    /// 注册失败（服务端不可用等）。身份和配置已保留，之后再调用 `bootstrap` 可重试。
    #[error("注册设备失败: {0}")]
    Api(#[from] ApiError),
}

/// 启动后得到的本机身份与配置。
#[derive(Clone)]
pub struct Bootstrap {
    pub identity: Arc<Identity>,
    pub device_id: String,
    pub device_code: String,
    pub config: Arc<ConfigStore>,
    pub secrets: Arc<dyn SecretStore>,
}

/// 启动流程：读配置 → 取/生成密钥 → 没有设备码则调注册接口 → 保存。
/// - 第二次运行不再注册，设备码不变。
/// - 配置丢了但密钥还在：用原密钥注册，服务端返回原设备码（幂等）。
/// - 密钥丢了（重新生成）：旧设备码作废，重新注册。
/// - 服务端不可用：返回 `BootstrapError::Api`，不崩溃，可重试。
///
/// `api_url_override`：不为 None 时覆盖配置里的 `server.api_url`（并保存），环境变量 `RTERM_API_URL` 同理。
pub async fn bootstrap(
    paths: &Paths,
    info: &DeviceInfo,
    api_url_override: Option<&str>,
) -> Result<Bootstrap, BootstrapError> {
    let config = Arc::new(ConfigStore::open(paths.config_file())?);
    let secrets = default_store(paths.secrets_dir());
    bootstrap_with(config, secrets, info, api_url_override).await
}

/// 同 `bootstrap`，但配置和机密存储由调用方提供（测试、嵌入）。
pub async fn bootstrap_with(
    config: Arc<ConfigStore>,
    secrets: Arc<dyn SecretStore>,
    info: &DeviceInfo,
    api_url_override: Option<&str>,
) -> Result<Bootstrap, BootstrapError> {
    let (identity, created) = Identity::load_or_create(secrets.as_ref())?;
    if created {
        tracing::info!("已生成新的设备密钥（存储: {}）", secrets.kind());
    }
    let env_url = std::env::var("RTERM_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(u) = api_url_override.map(str::to_string).or(env_url) {
        if config.get().server.api_url != u {
            config.update(|c| c.server.api_url = u)?;
        }
    }
    let identity = Arc::new(identity);

    let cur = config.get();
    if !created {
        if let (Some(id), Some(code)) = (&cur.device.device_id, &cur.device.device_code) {
            return Ok(Bootstrap {
                identity,
                device_id: id.clone(),
                device_code: code.clone(),
                config,
                secrets,
            });
        }
    }

    let net = NetOptions {
        proxy: cur.server.proxy.clone(),
        use_system_certs: cur.server.use_system_certs,
    };
    let api = ApiClient::new(&cur.server.api_url, &net)?;
    let resp = api.register(&identity, info).await?;
    config.update(|c| {
        c.device.device_id = Some(resp.device_id.clone());
        c.device.device_code = Some(resp.device_code.clone());
    })?;
    Ok(Bootstrap {
        identity,
        device_id: resp.device_id,
        device_code: resp.device_code,
        config,
        secrets,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    //! 手写的最小 HTTP 服务，仅用于测试。
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 启动一个对每个请求调用 `handler(method, path, body) -> (status, json)` 的服务，返回 (base_url, 请求计数)。
    pub async fn http_server<F>(handler: F) -> (String, Arc<AtomicUsize>)
    where
        F: Fn(&str, &str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let c2 = count.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else {
                    break;
                };
                let handler = handler.clone();
                let c2 = c2.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let (head_end, clen) = loop {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                            let clen = head
                                .lines()
                                .find_map(|l| {
                                    l.strip_prefix("content-length:")
                                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            break (pos + 4, clen);
                        }
                    };
                    while buf.len() < head_end + clen {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut it = head.lines().next().unwrap_or("").split_whitespace();
                    let method = it.next().unwrap_or("").to_string();
                    let path = it.next().unwrap_or("").to_string();
                    let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                    c2.fetch_add(1, Ordering::SeqCst);
                    let (status, json) = handler(&method, &path, &body);
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                        json.len()
                    );
                    let _ = s.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), count)
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::http_server;
    use super::*;
    use crate::identity::{b64_decode, verify_signature};
    use crate::secrets::MemoryStore;
    use std::sync::atomic::Ordering;

    fn info() -> DeviceInfo {
        DeviceInfo {
            platform: "windows".into(),
            arch: "x86_64".into(),
            os_version: "10.0".into(),
            app_version: "0.1.0".into(),
            kind: "cli".into(),
        }
    }

    fn no_proxy() -> NetOptions {
        NetOptions {
            proxy: Some(String::new()),
            use_system_certs: false,
        }
    }

    #[test]
    fn signal_url_resolution() {
        assert_eq!(
            resolve_signal_url("http://127.0.0.1:8080/", None),
            "ws://127.0.0.1:8080/v1/signal"
        );
        assert_eq!(
            resolve_signal_url("https://api.x.com", None),
            "wss://api.x.com/v1/signal"
        );
        let c = ServerConfig {
            signal_url: Some("wss://s.x.com/v1/signal".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_signal_url("https://api.x.com", Some(&c)),
            "wss://s.x.com/v1/signal"
        );
    }

    /// 审查 L11：非回环的 http:// API 地址不被接受；下发的明文信令地址被忽略。
    #[test]
    fn api_client_requires_tls_and_ignores_insecure_signal_url() {
        assert!(ApiClient::new("https://api.example.com", &no_proxy()).is_ok());
        for bad in [
            "http://api.example.com",
            "http://10.0.0.5:8080",
            "ftp://api.example.com",
            "http://127.0.0.1.evil.com",
        ] {
            let e = ApiClient::new(bad, &no_proxy()).err();
            assert!(matches!(e, Some(ApiError::Network(_))), "{bad} 应被拒绝");
        }
        let c = ServerConfig {
            signal_url: Some("ws://evil.example.com/v1/signal".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_signal_url("https://api.x.com", Some(&c)),
            "wss://api.x.com/v1/signal"
        );
        let c = ServerConfig {
            signal_url: Some("wss://signal.x.com/v1/signal".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_signal_url("https://api.x.com", Some(&c)),
            "wss://signal.x.com/v1/signal"
        );
    }

    #[tokio::test]
    async fn register_signs_and_parses() {
        let (url, _) = http_server(|m, p, body| {
            assert_eq!((m, p), ("POST", "/v1/devices/register"));
            let v: serde_json::Value = serde_json::from_str(body).unwrap();
            let pk = b64_decode(v["public_key"].as_str().unwrap()).unwrap();
            let signed = format!(
                "rterm-register-v1\n{}\n{}\n{}\n{}\n{}",
                v["public_key"].as_str().unwrap(),
                v["platform"].as_str().unwrap(),
                v["arch"].as_str().unwrap(),
                v["kind"].as_str().unwrap(),
                v["ts"]
            );
            let sig = b64_decode(v["signature"].as_str().unwrap()).unwrap();
            assert!(verify_signature(&pk, signed.as_bytes(), &sig));
            (
                200,
                r#"{"device_id":"01ABC","device_code":"482913675"}"#.into(),
            )
        })
        .await;
        let api = ApiClient::new(&url, &no_proxy()).unwrap();
        let r = api.register(&Identity::generate(), &info()).await.unwrap();
        assert_eq!(
            r,
            RegisterResp {
                device_id: "01ABC".into(),
                device_code: "482913675".into()
            }
        );
    }

    #[tokio::test]
    async fn server_error_format() {
        let (url, _) = http_server(|_, _, _| {
            (
                400,
                r#"{"error":{"code":"BAD_TIMESTAMP","message":"校准时间","retry_after":5}}"#.into(),
            )
        })
        .await;
        let api = ApiClient::new(&url, &no_proxy()).unwrap();
        let e = api
            .register(&Identity::generate(), &info())
            .await
            .unwrap_err();
        assert_eq!(e.code(), Some("BAD_TIMESTAMP"));
        assert!(!e.is_retryable());
    }

    #[tokio::test]
    async fn config_and_update() {
        let (url, _) = http_server(|_, p, _| match p {
            "/v1/config" => (200, r#"{"signal_url":"wss://s/v1/signal","min_app_version":"1.0.0","features":{"file_upload":true},"extra":1}"#.into()),
            "/v1/update/windows/x86_64/0.1.0" => (200, r#"{"version":"0.2.0","url":"http://x/y"}"#.into()),
            "/v1/update/windows/x86_64/0.2.0" => (204, String::new()),
            _ => (404, "{}".into()),
        })
        .await;
        let api = ApiClient::new(&url, &no_proxy()).unwrap();
        let c = api.get_config().await.unwrap();
        assert_eq!(c.signal_url.as_deref(), Some("wss://s/v1/signal"));
        assert_eq!(c.features["file_upload"], true);
        assert!(c.adapters.is_empty());
        assert_eq!(
            api.check_update("windows", "x86_64", "0.1.0")
                .await
                .unwrap()
                .unwrap()
                .version,
            "0.2.0"
        );
        assert!(api
            .check_update("windows", "x86_64", "0.2.0")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn bootstrap_first_second_and_lost_config() {
        let (url, count) = http_server(|_, _, _| {
            (
                200,
                r#"{"device_id":"01ABC","device_code":"482913675"}"#.into(),
            )
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("config.json");
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
        let open = || Arc::new(ConfigStore::open(&cfg_path).unwrap());
        let c = ConfigStore::open(&cfg_path).unwrap();
        c.update(|c| c.server.proxy = Some(String::new())).unwrap();

        // 第一次：注册
        let b1 = bootstrap_with(open(), secrets.clone(), &info(), Some(&url))
            .await
            .unwrap();
        assert_eq!(b1.device_code, "482913675");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(cfg_path.exists());

        // 第二次：不再注册
        let b2 = bootstrap_with(open(), secrets.clone(), &info(), None)
            .await
            .unwrap();
        assert_eq!(b2.device_code, b1.device_code);
        assert_eq!(b2.identity.public_key(), b1.identity.public_key());
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // 删除配置、保留密钥：用原密钥重新注册（服务端幂等）
        std::fs::remove_file(&cfg_path).unwrap();
        let c = ConfigStore::open(&cfg_path).unwrap();
        c.update(|c| c.server.proxy = Some(String::new())).unwrap();
        let b3 = bootstrap_with(open(), secrets.clone(), &info(), Some(&url))
            .await
            .unwrap();
        assert_eq!(b3.identity.public_key(), b1.identity.public_key());
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn bootstrap_server_down_is_error_and_retryable() {
        // 取一个空闲端口后关闭监听，模拟服务端不可用
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let dir = tempfile::tempdir().unwrap();
        let cfg = Arc::new(ConfigStore::open(dir.path().join("config.json")).unwrap());
        cfg.update(|c| c.server.proxy = Some(String::new()))
            .unwrap();
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
        let url = format!("http://127.0.0.1:{port}");
        let e = match bootstrap_with(cfg.clone(), secrets.clone(), &info(), Some(&url)).await {
            Err(e) => e,
            Ok(_) => panic!("应当失败"),
        };
        assert!(matches!(e, BootstrapError::Api(ApiError::Network(_))));
        // 密钥已保留；服务恢复后重试成功且公钥不变
        let pk1 = Identity::load_or_create(secrets.as_ref())
            .unwrap()
            .0
            .public_key();
        let (url2, _) = http_server(|_, _, _| {
            (
                200,
                r#"{"device_id":"01X","device_code":"111222333"}"#.into(),
            )
        })
        .await;
        let b = bootstrap_with(cfg, secrets, &info(), Some(&url2))
            .await
            .unwrap();
        assert_eq!(b.identity.public_key(), pk1);
    }
}
