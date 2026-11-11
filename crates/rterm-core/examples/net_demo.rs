//! 网络层联调示例：注册 -> 上线 -> connect -> 中继握手 -> 收发 Frame。
//! 主控端 / 被控端集成可以直接参考这里的调用顺序。
//!
//! 先起开发服务器：`cd server && npm run dev:all`（8080 信令/HTTP，8081 中继），然后：
//!
//! ```text
//! cargo run -p rterm-core --example net_demo -- both                      # 同一进程里跑被控端 + 主控端（正确密码 + 错误密码）
//! cargo run -p rterm-core --example net_demo -- host                      # 只跑被控端，打印设备码，等待连接
//! cargo run -p rterm-core --example net_demo -- connect <设备码> <密码>    # 只跑主控端
//! ```
//!
//! 可选参数：`--api http://127.0.0.1:8080`（默认）、`--dir <数据目录>`（默认临时目录，host / ctrl 各自独立）。
//! 临时密码固定为 `abc23456`（8 位，字符集内）。
use std::sync::Arc;
use std::time::Duration;

use rterm_core::api::{bootstrap, resolve_signal_url, ApiClient, Bootstrap, DeviceInfo};
use rterm_core::config::Paths;
use rterm_core::crypto::{derive_pw_key, password_kind_of};
use rterm_core::link::{HostPasswords, Link};
use rterm_core::netutil::NetOptions;
use rterm_core::relay::{
    establish_controller_ex, establish_host, ControllerParams, EstablishError, HostParams,
    PasswordInput,
};
use rterm_core::signal::{SignalClient, SignalConfig, SignalEvent};
use rterm_proto::pb::{frame::Body, Frame, Ping, Pong, TermInput, TermOutput};
use tokio::sync::mpsc::Receiver;

const TEMP_PASSWORD: &str = "abc23456";

struct DemoPasswords {
    temp: [u8; 32],
}

impl HostPasswords for DemoPasswords {
    fn pw_key(&self, kind: u32) -> Option<[u8; 32]> {
        (kind == 0).then_some(self.temp)
    }
}

/// 启动：读配置 -> 必要时注册 -> 连信令。返回身份和信令客户端。
async fn start_node(
    api_url: &str,
    dir: &std::path::Path,
) -> anyhow::Result<(Bootstrap, SignalClient, Receiver<SignalEvent>)> {
    let paths = Paths::from_root(dir);
    let info = DeviceInfo::detect("0.1.0-demo", "cli");
    let b = bootstrap(&paths, &info, Some(api_url)).await?;
    let cfg = b.config.get();
    let net = NetOptions {
        proxy: cfg.server.proxy.clone(),
        use_system_certs: cfg.server.use_system_certs,
    };
    let api = ApiClient::new(api_url, &net)?;
    let server_cfg = api.get_config().await.ok();
    let signal_url = resolve_signal_url(api_url, server_cfg.as_ref());
    let mut sc = SignalConfig::new(
        signal_url,
        b.device_id.clone(),
        b.identity.clone(),
        "0.1.0-demo",
        &info.platform,
    );
    sc.net = net;
    let (client, events) = SignalClient::start(sc);
    anyhow::ensure!(
        client.wait_online(Duration::from_secs(10)).await,
        "信令 10 秒内未上线"
    );
    println!("[{}] 已上线，设备码 {}", dir.display(), b.device_code);
    Ok((b, client, events))
}

/// 被控端：接受每个连接，握手成功后对 Ping 回 Pong、对 TermInput 回显大写的 TermOutput。
async fn run_host(b: Bootstrap, client: SignalClient, mut events: Receiver<SignalEvent>) {
    let passwords: Arc<dyn HostPasswords> = Arc::new(DemoPasswords {
        temp: derive_pw_key(TEMP_PASSWORD, &b.device_code).expect("kdf"),
    });
    while let Some(ev) = events.recv().await {
        let SignalEvent::Incoming(inc) = ev else {
            continue;
        };
        println!(
            "[host] 收到连接请求 {} 来自 {}",
            inc.session_id, inc.from.device_code
        );
        let (client, passwords, b) = (client.clone(), passwords.clone(), b.clone());
        tokio::spawn(async move {
            // 同意之后服务端才签发票据，accept 会等到 connect.go 并返回中继地址和票据
            let Ok(go) = client.accept(&inc.session_id).await else {
                return;
            };
            let params = HostParams {
                relay_url: go.relay_url.clone(),
                ticket: go.ticket.clone(),
                session_id: inc.session_id.clone(),
                identity: b.identity.clone(),
                host_code: b.device_code.clone(),
                controller_code: inc.from.device_code.clone(),
                controller_public_key: inc.from.public_key.clone(),
                controller_platform: inc.from.platform.clone(),
                passwords,
                net: NetOptions::default(),
            };
            match establish_host(params).await {
                Ok((mut link, mut handle)) => {
                    println!("[host] 握手成功（密码类别 {}）", handle.password_kind);
                    let _ = client
                        .session_report(&inc.session_id, "auth_ok", None)
                        .await;
                    while let Some(f) = link.rx.recv().await {
                        match f.body {
                            Some(Body::Ping(p)) => {
                                let _ = link
                                    .tx
                                    .send(Frame {
                                        channel: 0,
                                        body: Some(Body::Pong(Pong { ts: p.ts })),
                                    })
                                    .await;
                            }
                            Some(Body::TermInput(i)) => {
                                let up =
                                    String::from_utf8_lossy(&i.data).to_uppercase().into_bytes();
                                let _ = link
                                    .tx
                                    .send(Frame {
                                        channel: f.channel,
                                        body: Some(Body::TermOutput(TermOutput {
                                            seq: 0,
                                            data: up,
                                        })),
                                    })
                                    .await;
                            }
                            _ => {}
                        }
                    }
                    println!("[host] 会话结束: {:?}", handle.mux.wait_closed().await);
                    let _ = client.session_report(&inc.session_id, "closed", None).await;
                }
                Err(EstablishError::BadPassword) => {
                    println!("[host] 密码错误，上报 auth_failed");
                    let _ = client
                        .session_report(
                            &inc.session_id,
                            "auth_failed",
                            Some(serde_json::json!({ "reason": "bad_password" })),
                        )
                        .await;
                }
                Err(e) => println!("[host] 建立会话失败: {e}（可重试: {}）", e.is_retryable()),
            }
        });
    }
}

/// 主控端：请求连接 -> 握手 -> 返回 Link。
async fn run_controller(
    b: &Bootstrap,
    client: &SignalClient,
    target: &str,
    password: &str,
) -> Result<Link, String> {
    let ok = client
        .connect_request(target)
        .await
        .map_err(|e| e.user_text())?;
    println!(
        "[ctrl] connect.ok session={} relay={}",
        ok.session_id, ok.relay_url
    );
    let params = ControllerParams {
        relay_url: ok.relay_url,
        ticket: ok.ticket,
        session_id: ok.session_id.clone(),
        identity: b.identity.clone(),
        controller_code: b.device_code.clone(),
        host_code: target.to_string(),
        host_public_key: ok.peer.public_key,
        host_platform: ok.peer.platform,
        // Plain 会在内部 spawn_blocking 做 Argon2id；重连时可缓存 `PasswordInput::derive` 的结果
        password: PasswordInput::Plain(password.to_string()),
        known_host_key: b
            .config
            .get()
            .known_host(target)
            .and_then(|h| rterm_core::identity::b64_decode(&h.public_key)),
        accept_key_change: false,
        net: NetOptions::default(),
    };
    println!("[ctrl] 密码类别推断: {}", password_kind_of(password));
    match establish_controller_ex(params).await {
        Ok((link, handle)) => {
            // 首次连接记住对端公钥
            let pk = rterm_core::identity::b64(&handle.peer_public_key);
            let _ = b.config.update(|c| c.remember_host(target, &pk, "now"));
            let _ = client.session_report(&ok.session_id, "auth_ok", None).await;
            Ok(link)
        }
        Err(e) => Err(format!("{e}（可重试: {}）", e.is_retryable())),
    }
}

async fn ping_pong(link: &mut Link) {
    let _ = link
        .tx
        .send(Frame {
            channel: 0,
            body: Some(Body::Ping(Ping { ts: 42 })),
        })
        .await;
    let _ = link
        .tx
        .send(Frame {
            channel: 1,
            body: Some(Body::TermInput(TermInput {
                data: b"hello rterm".to_vec(),
            })),
        })
        .await;
    for _ in 0..2 {
        match tokio::time::timeout(Duration::from_secs(5), link.rx.recv()).await {
            Ok(Some(f)) => println!("[ctrl] 收到 {:?}", f.body),
            other => println!("[ctrl] 等待回应失败: {other:?}"),
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut api = "http://127.0.0.1:8080".to_string();
    let mut dir: Option<std::path::PathBuf> = None;
    let mut pos = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--api" => api = it.next().cloned().unwrap_or(api),
            "--dir" => dir = it.next().map(Into::into),
            _ => pos.push(a.clone()),
        }
    }
    let base = dir
        .unwrap_or_else(|| std::env::temp_dir().join(format!("rterm-demo-{}", std::process::id())));
    match pos.first().map(String::as_str) {
        Some("host") => {
            let (b, client, events) = start_node(&api, &base.join("host")).await?;
            println!("临时密码: {TEMP_PASSWORD}，Ctrl+C 退出");
            run_host(b, client, events).await;
        }
        Some("connect") if pos.len() >= 3 => {
            let (b, client, _events) = start_node(&api, &base.join("ctrl")).await?;
            let mut link = run_controller(&b, &client, &pos[1], &pos[2])
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            ping_pong(&mut link).await;
        }
        Some("both") => {
            let (hb, hc, hev) = start_node(&api, &base.join("host")).await?;
            let host_code = hb.device_code.clone();
            tokio::spawn(run_host(hb, hc, hev));
            let (cb, cc, _cev) = start_node(&api, &base.join("ctrl")).await?;
            println!("--- 正确密码 ---");
            let mut link = run_controller(&cb, &cc, &host_code, TEMP_PASSWORD)
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            ping_pong(&mut link).await;
            drop(link);
            tokio::time::sleep(Duration::from_millis(300)).await;
            println!("--- 错误密码 ---");
            match run_controller(&cb, &cc, &host_code, "abc23457").await {
                Err(e) => println!("[ctrl] 预期的失败: {e}"),
                Ok(_) => anyhow::bail!("错误密码竟然成功了"),
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        _ => {
            println!("用法: net_demo both | host | connect <设备码> <密码> [--api URL] [--dir DIR]")
        }
    }
    Ok(())
}
