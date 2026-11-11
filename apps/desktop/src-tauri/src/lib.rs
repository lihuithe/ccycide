//! RTerm 桌面端：Tauri 2 外壳。核心逻辑全部在 `rterm-core`，这里只做命令转发、事件转发、
//! 终端输出通道、托盘、系统通知和插件装配。
mod clipboard;
mod commands;
mod error;
mod events;
mod output;
mod power;
mod state;
mod tray;

use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

use rterm_core::config::Paths;
use rterm_core::core::{Core, CoreKind, CoreOptions};
use rterm_core::logging::LogGuard;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::StateFlags;
use tokio::sync::mpsc;

use crate::error::CommandError;
use crate::state::AppState;

/// 日志守卫要活到进程结束，否则退出前的日志可能没落盘。
static LOG_GUARD: OnceLock<LogGuard> = OnceLock::new();

fn init_logging() {
    let Some(paths) = Paths::standard() else {
        eprintln!("无法确定数据目录，日志只输出到控制台");
        return;
    };
    let dir = paths.logs_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("无法创建日志目录 {}：{e}", dir.display());
        return;
    }
    if let Some(g) = rterm_core::logging::init(&dir, cfg!(debug_assertions)) {
        let _ = LOG_GUARD.set(g);
    }
}

/// 从配置文件里读设备 ID（首次启动时还没有，返回 None）。updater 请求带上它，服务端按它做灰度分桶。
fn read_device_id() -> Option<String> {
    let path = Paths::standard()?.config_file();
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["device"]["device_id"].as_str().map(str::to_string)
}

/// Windows：确认随包的新版 ConPTY（conpty.dll、OpenConsole.exe）在可执行文件同目录。
/// 缺失时只记日志，终端会降级到系统自带的 ConPTY（老系统上按键/粘贴/重绘可能有问题）。
fn check_conpty() {
    if !cfg!(windows) {
        return;
    }
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let missing: Vec<&str> = ["conpty.dll", "OpenConsole.exe"]
        .into_iter()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    if missing.is_empty() {
        tracing::info!("已找到随包的 ConPTY：{}", dir.display());
    } else if cfg!(debug_assertions) {
        tracing::info!("开发构建：未找到 {missing:?}，使用系统 ConPTY");
    } else {
        tracing::warn!("缺少随包的 {missing:?}，降级到系统 ConPTY");
    }
}

/// 让系统的开机自启状态与设置一致（设置是唯一事实来源）。
fn reconcile_autostart(app: &AppHandle, want: bool) {
    let m = app.autolaunch();
    match m.is_enabled() {
        Ok(cur) if cur != want => {
            let r = if want { m.enable() } else { m.disable() };
            match r {
                Ok(()) => tracing::info!("开机自启已同步为 {want}"),
                Err(e) => tracing::warn!("同步开机自启失败：{e}"),
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("读取开机自启状态失败：{e}"),
    }
}

fn updater_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry, tauri_plugin_updater::Config> {
    let mut b = tauri_plugin_updater::Builder::new();
    if let Some(id) = read_device_id() {
        match b.header("X-Device-Id", id) {
            Ok(nb) => return nb.build(),
            Err(e) => {
                tracing::warn!("无法设置更新请求头：{e}");
                b = tauri_plugin_updater::Builder::new();
            }
        }
    }
    b.build()
}

pub fn run() {
    init_logging();
    // 命令层 -> 事件泵：登记终端输出通道，有界
    let (router_tx, router_rx) = mpsc::channel(256);
    let start_minimized = std::env::args().any(|a| a == "--minimized");

    let built = tauri::Builder::default()
        // 单实例必须最先注册
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            events::show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(updater_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // 不记“是否可见”：启动时的显示与否由 --minimized 决定
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new(router_tx))
        .invoke_handler(tauri::generate_handler![
            commands::local_info,
            commands::refresh_temp_password,
            commands::set_fixed_password,
            commands::accept_incoming,
            commands::reject_incoming,
            commands::disconnect_incoming,
            commands::disconnect_all_incoming,
            commands::list_known_hosts,
            commands::remove_known_host,
            commands::get_settings,
            commands::set_settings,
            commands::connect,
            commands::cancel_connect,
            commands::disconnect,
            commands::open_term,
            commands::list_terms,
            commands::attach_term,
            commands::term_input,
            commands::term_submit,
            commands::term_resize,
            commands::term_ack,
            commands::close_term,
            commands::upload_path,
            commands::upload_bytes,
            commands::cancel_upload,
            commands::read_clipboard_files,
            commands::term_action,
            commands::command_list_req,
            commands::check_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            check_conpty();

            match tray::build(&handle) {
                Ok(h) => {
                    let _ = state.tray.set(h);
                    state.tray_ok.store(true, Ordering::Relaxed);
                }
                Err(e) => tracing::warn!("系统托盘不可用，关闭窗口将改为最小化：{e}"),
            }

            // 自启动带 --minimized：藏在托盘里（没有托盘时仍要显示，否则用户找不到）
            if let Some(w) = app.get_webview_window("main") {
                if !(start_minimized && state.tray_ok.load(Ordering::Relaxed)) {
                    let _ = w.show();
                }
            }

            // 核心库启动可能要联网注册，放后台，窗口先出来；命令会等它就绪
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let mut opts = CoreOptions::new(CoreKind::Desktop, env!("CARGO_PKG_VERSION"));
                // 状态回传 hook 用的 rterm-cli；不设置时核心库找本程序同目录下的 rterm-cli
                if let Ok(p) = std::env::var("RTERM_CLI") {
                    if !p.trim().is_empty() {
                        opts.rterm_cli = Some(p.into());
                    }
                }
                match Core::start(opts).await {
                    Ok((core, ev_rx)) => {
                        let s = core.get_settings();
                        state
                            .close_to_tray
                            .store(s.app.close_to_tray, Ordering::Relaxed);
                        reconcile_autostart(&handle, s.app.autostart);
                        state.set_core(core.clone());
                        events::run_pump(handle.clone(), core, ev_rx, router_rx).await;
                    }
                    Err(e) => {
                        tracing::error!("核心库启动失败：{e}");
                        state.set_failed(CommandError::from(e));
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let st = window.app_handle().state::<AppState>();
                if st.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    if st.tray_ok.load(Ordering::Relaxed) {
                        let _ = window.hide();
                    } else {
                        let _ = window.minimize();
                    }
                }
            }
        })
        .build(tauri::generate_context!());

    let app = match built {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("应用构建失败：{e}");
            eprintln!("RTerm 启动失败：{e}");
            std::process::exit(1);
        }
    };

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let st = app.state::<AppState>();
            if !st.shutting_down.swap(true, Ordering::Relaxed) {
                if let Some(core) = st.core_now() {
                    // 优雅退出：断开来访与主控会话、关闭终端
                    tauri::async_runtime::block_on(async {
                        let _ = tokio::time::timeout(Duration::from_secs(3), core.shutdown()).await;
                    });
                }
                power::set_keep_awake(false);
            }
        }
    });
}
