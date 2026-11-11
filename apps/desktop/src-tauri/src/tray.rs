//! 系统托盘：显示/隐藏窗口、状态、暂停被控、断开全部、退出；有人连入时图标变色。
use std::sync::atomic::{AtomicBool, Ordering};

use rterm_core::core::{format_device_code, Core};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::events::show_main;
use crate::state::AppState;

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray-active.png");

pub struct TrayHandles {
    tray: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    pause: CheckMenuItem<Wry>,
    idle: Image<'static>,
    active: Image<'static>,
    /// 当前显示的是否为“有连接”图标，避免重复设置造成闪烁
    showing_active: AtomicBool,
}

/// 切换主窗口显示状态。
fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        if visible {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

/// 创建托盘。失败（如 Linux 无托盘支持）时返回错误，由调用方降级。
pub fn build(app: &AppHandle) -> tauri::Result<TrayHandles> {
    let idle = Image::from_bytes(ICON_IDLE)?;
    let active = Image::from_bytes(ICON_ACTIVE)?;

    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏窗口", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "RTerm", false, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "暂停被控", true, false, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect_all", "断开全部连接", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &status, &sep1, &pause, &disconnect, &sep2, &quit],
    )?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(idle.clone())
        .tooltip("RTerm")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_main(app),
            "pause" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(core) = app.state::<AppState>().core_now() else {
                        return;
                    };
                    let mut s = core.get_settings();
                    s.host.enabled = !s.host.enabled;
                    if let Err(e) = core.set_settings(s).await {
                        tracing::warn!("托盘切换“暂停被控”失败：{e}");
                    }
                });
            }
            "disconnect_all" => {
                if let Some(core) = app.state::<AppState>().core_now() {
                    core.disconnect_all_incoming();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(TrayHandles {
        tray,
        status,
        pause,
        idle,
        active,
        showing_active: AtomicBool::new(false),
    })
}

/// 按核心库当前状态刷新托盘（图标、提示、状态行、暂停勾选）。
pub fn refresh(app: &AppHandle, core: &Core) {
    let state = app.state::<AppState>();
    let Some(h) = state.tray.get() else { return };

    let info = core.local_info();
    let enabled = core.get_settings().host.enabled;
    let conns = core
        .list_incoming()
        .iter()
        .filter(|i| !i.pending_confirm)
        .count();

    let line = if info.device_code.is_empty() {
        "尚未获得设备码".to_string()
    } else {
        let net = if info.online { "在线" } else { "离线" };
        let pause = if enabled { "" } else { " · 已暂停被控" };
        format!("{} · {net}{pause}", format_device_code(&info.device_code))
    };
    let status_text = if conns > 0 {
        format!("{line} · {conns} 个连接")
    } else {
        line
    };
    let _ = h.status.set_text(&status_text);
    let _ = h.pause.set_checked(!enabled);
    let _ = h.tray.set_tooltip(Some(format!("RTerm\n{status_text}")));

    let want_active = conns > 0;
    if h.showing_active.swap(want_active, Ordering::Relaxed) != want_active {
        let img = if want_active {
            h.active.clone()
        } else {
            h.idle.clone()
        };
        let _ = h.tray.set_icon(Some(img));
    }
}
