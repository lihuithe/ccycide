//! 全部 `#[tauri::command]`。命令名 snake_case，参数键 camelCase（Tauri 默认），
//! 错误统一成 `{ code, message }`（见 `error.rs`）。契约以 `apps/desktop/src/backend/types.ts` 为准。
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rterm_core::controller::TermSize;
use rterm_core::core::{ConnectParams, LocalInfo, OpenTermParams};
use rterm_core::dto::{
    ActionOutcomeDto, KnownHostDto, LaunchOptionsDto, TermInfoDto, TermOpenedDto, UploadStartedDto,
};
use rterm_core::settings::Settings;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::clipboard;
use crate::error::{CmdResult, CommandError};
use crate::events::RouterCmd;
use crate::state::{AppState, CancelTarget};
use crate::tray;

/// 前端没带 requestId 时自动生成。
static AUTO_REQUEST: AtomicU64 = AtomicU64::new(0);

/// 前端传来的 `FileId` 是十进制字符串。
fn parse_file_id(s: &str) -> CmdResult<u64> {
    s.trim()
        .parse::<u64>()
        .map_err(|_| CommandError::new("BAD_REQUEST", "无效的文件编号"))
}

// ———————————————————— 本机（被控）————————————————————

#[tauri::command]
pub async fn local_info(state: State<'_, AppState>) -> CmdResult<LocalInfo> {
    Ok(state.core().await?.local_info())
}

#[tauri::command]
pub async fn refresh_temp_password(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.core().await?.refresh_temp_password().await?)
}

#[tauri::command]
pub async fn set_fixed_password(
    state: State<'_, AppState>,
    password: Option<String>,
) -> CmdResult<()> {
    Ok(state
        .core()
        .await?
        .set_fixed_password(password.as_deref())
        .await?)
}

#[tauri::command]
pub async fn accept_incoming(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    Ok(state.core().await?.accept_incoming(&session_id)?)
}

#[tauri::command]
pub async fn reject_incoming(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let core = state.core().await?;
    core.reject_incoming(&session_id)?;
    state.mark_rejected(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_incoming(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let core = state.core().await?;
    // 对还在等待确认的来访，断开等同于拒绝
    if core
        .list_incoming()
        .iter()
        .any(|i| i.session_id == session_id && i.pending_confirm)
    {
        state.mark_rejected(&session_id);
    }
    core.disconnect_incoming(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_all_incoming(state: State<'_, AppState>) -> CmdResult<()> {
    let core = state.core().await?;
    for i in core.list_incoming().iter().filter(|i| i.pending_confirm) {
        state.mark_rejected(&i.session_id);
    }
    core.disconnect_all_incoming();
    Ok(())
}

#[tauri::command]
pub async fn list_known_hosts(state: State<'_, AppState>) -> CmdResult<Vec<KnownHostDto>> {
    Ok(state.core().await?.list_known_hosts())
}

#[tauri::command]
pub async fn remove_known_host(state: State<'_, AppState>, device_code: String) -> CmdResult<()> {
    Ok(state.core().await?.remove_known_host(&device_code)?)
}

// ———————————————————— 设置 ————————————————————

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    Ok(state.core().await?.get_settings())
}

/// 递归合并：`patch` 里有的键覆盖 `base`，没有的保留。
/// 前端的 `Settings` 类型只含界面关心的字段，核心库多出来的（文件上限、终端上限、代理等）
/// 不能因为前端没带回来就被重置成默认值。
fn merge_json(base: &mut serde_json::Value, patch: serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(b), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                match b.get_mut(&k) {
                    Some(slot) => merge_json(slot, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (slot, v) => *slot = v,
    }
}

#[tauri::command]
pub async fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> CmdResult<Settings> {
    let core = state.core().await?;
    let mut merged = serde_json::to_value(core.get_settings())
        .map_err(|e| CommandError::unknown(format!("设置序列化失败：{e}")))?;
    merge_json(&mut merged, settings);
    let next: Settings = serde_json::from_value(merged)
        .map_err(|e| CommandError::new("BAD_REQUEST", format!("设置格式不正确：{e}")))?;
    let saved = core.set_settings(next).await?;
    state
        .close_to_tray
        .store(saved.app.close_to_tray, Ordering::Relaxed);
    tray::refresh(&app, &core);
    Ok(saved)
}

// ———————————————————— 主控 ————————————————————

/// 连接被控端。对方设置了“连接确认”时会一直等到对方处理（没有超时），期间前端可用 `cancel_connect` 取消。
/// `request_id` 由前端生成；`accept_key_change` 是契约之外的可选参数（对方公钥变化、用户确认后带 true 重连）。
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    device_code: String,
    password: String,
    request_id: Option<String>,
    accept_key_change: Option<bool>,
) -> CmdResult<String> {
    let core = state.core().await?;
    let rid = request_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("auto-{}", AUTO_REQUEST.fetch_add(1, Ordering::Relaxed)));
    state.with_connects(|t| t.register(&rid));
    // 串行化“开始连接 → 拿到核心会话 ID”这一小段（见 ConnectTable 的说明）
    let gate = state.connect_gate.clone().lock_owned().await;
    let (release_tx, mut release_rx) = tokio::sync::oneshot::channel();
    if !state.with_connects(|t| t.begin(&rid, release_tx)) {
        state.with_connects(|t| t.finish(&rid, false));
        return Err(CommandError::new("CANCELLED", "已取消连接"));
    }
    let fut = core.connect_with(ConnectParams {
        device_code,
        password,
        accept_key_change: accept_key_change.unwrap_or(false),
    });
    tokio::pin!(fut);
    let mut gate = Some(gate);
    let res = loop {
        tokio::select! {
            r = &mut fut => break r,
            // 事件泵已绑定会话（或发送端被丢弃）：释放 gate，让别的 connect 开始
            _ = &mut release_rx, if gate.is_some() => { gate = None; }
        }
    };
    state.with_connects(|t| t.finish(&rid, res.is_ok()));
    drop(gate);
    Ok(res?)
}

/// 取消还没连上的 `connect`。`request_id` 不存在或已结束时静默成功；被取消的 `connect` 以 `CANCELLED` 失败。
#[tauri::command]
pub async fn cancel_connect(state: State<'_, AppState>, request_id: String) -> CmdResult<()> {
    let target = state.with_connects(|t| t.request_cancel(&request_id));
    if let CancelTarget::Session(sid) = target {
        if let Some(core) = state.core_now() {
            core.cancel_connect(&sid);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    Ok(state.core().await?.disconnect(&session_id).await?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_term(
    state: State<'_, AppState>,
    session_id: String,
    profile: String,
    shell_id: Option<String>,
    cwd: Option<String>,
    cols: u32,
    rows: u32,
    command: Option<String>,
    launch: Option<LaunchOptionsDto>,
    on_output: Channel<InvokeResponseBody>,
) -> CmdResult<TermOpenedDto> {
    let core = state.core().await?;
    let opened = core
        .open_term_ui(
            &session_id,
            OpenTermParams {
                profile,
                shell_id: shell_id.unwrap_or_default(),
                cwd: cwd.unwrap_or_default(),
                cols,
                rows,
                command: command.unwrap_or_default(),
                launch,
            },
        )
        .await?;
    // 终端刚打开时的输出可能已经到了路由，路由会暂存到这里登记为止
    state
        .router(RouterCmd::Register {
            key: (session_id, opened.term_id.clone()),
            channel: on_output,
            replay_pending: true,
        })
        .await;
    Ok(opened)
}

#[tauri::command]
pub async fn list_terms(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<TermInfoDto>> {
    Ok(state.core().await?.list_terms(&session_id).await?)
}

#[tauri::command]
pub async fn attach_term(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    cols: u32,
    rows: u32,
    last_seq: u64,
    on_output: Channel<InvokeResponseBody>,
) -> CmdResult<()> {
    let core = state.core().await?;
    let key = (session_id.clone(), term_id.clone());
    // 先登记再附着：回放数据可能在 attach_term 返回前就到了
    state
        .router(RouterCmd::Register {
            key: key.clone(),
            channel: on_output,
            replay_pending: false,
        })
        .await;
    if let Err(e) = core
        .attach_term_from(
            &session_id,
            &term_id,
            TermSize::new(cols.max(1), rows.max(1)),
            Some(last_seq),
        )
        .await
    {
        state.router(RouterCmd::Unregister { key }).await;
        return Err(e.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn term_input(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    data: Vec<u8>,
) -> CmdResult<()> {
    Ok(state
        .core()
        .await?
        .term_input(&session_id, &term_id, data)
        .await?)
}

#[tauri::command]
pub async fn term_submit(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    text: String,
    attachments: Vec<String>,
) -> CmdResult<()> {
    let ids = attachments
        .iter()
        .map(|s| parse_file_id(s))
        .collect::<CmdResult<Vec<u64>>>()?;
    state
        .core()
        .await?
        .term_submit(&session_id, &term_id, text, ids)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    Ok(state
        .core()
        .await?
        .term_resize(
            &session_id,
            &term_id,
            TermSize::new(cols.max(1), rows.max(1)),
        )
        .await?)
}

#[tauri::command]
pub async fn term_ack(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    consumed: u64,
) -> CmdResult<()> {
    // 流控确认：高频、同步、不等待核心启动
    if let Some(core) = state.core_now() {
        core.term_ack(&session_id, &term_id, consumed);
    }
    Ok(())
}

#[tauri::command]
pub async fn close_term(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
) -> CmdResult<()> {
    Ok(state
        .core()
        .await?
        .close_term(&session_id, &term_id)
        .await?)
}

// ———————————————————— 上传 ————————————————————

#[tauri::command]
pub async fn upload_path(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> CmdResult<UploadStartedDto> {
    Ok(state
        .core()
        .await?
        .upload_path(&session_id, Path::new(&path))
        .await?)
}

/// 原始请求体 = 文件字节；元数据在请求头 `x-session-id` / `x-name`（encodeURIComponent）/ `x-mime`。
#[tauri::command]
pub async fn upload_bytes(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> CmdResult<UploadStartedDto> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "BAD_REQUEST",
            "upload_bytes 需要原始字节请求体",
        ));
    };
    let header = |name: &str| -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let session_id = header("x-session-id")
        .ok_or_else(|| CommandError::new("BAD_REQUEST", "缺少 x-session-id"))?;
    let name_raw = header("x-name").unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(&name_raw)
        .decode_utf8_lossy()
        .into_owned();
    // 只取最后一段，防止带路径
    let name = decoded
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("粘贴文件")
        .to_string();
    let mime = header("x-mime")
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(state
        .core()
        .await?
        .upload_bytes(&session_id, &name, &mime, bytes.clone())
        .await?)
}

#[tauri::command]
pub async fn cancel_upload(
    state: State<'_, AppState>,
    session_id: String,
    file_id: String,
) -> CmdResult<()> {
    let id = parse_file_id(&file_id)?;
    state.core().await?.cancel_upload(&session_id, id);
    Ok(())
}

#[tauri::command]
pub async fn read_clipboard_files() -> CmdResult<Vec<String>> {
    clipboard::read_files().await
}

// ———————————————————— Claude Code 动作 ————————————————————

#[tauri::command]
pub async fn term_action(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
    action_id: String,
    args: Option<HashMap<String, String>>,
) -> CmdResult<ActionOutcomeDto> {
    Ok(state
        .core()
        .await?
        .term_action(&session_id, &term_id, &action_id, args.unwrap_or_default())
        .await?)
}

#[tauri::command]
pub async fn command_list_req(
    state: State<'_, AppState>,
    session_id: String,
    term_id: String,
) -> CmdResult<()> {
    Ok(state
        .core()
        .await?
        .command_list_req(&session_id, &term_id)
        .await?)
}

// ———————————————————— 更新 ————————————————————

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub version: String,
    pub notes: String,
}

/// 检查更新（Rust 侧版本）：更新地址用核心库当前使用的服务端地址 + 设置里的更新通道，
/// 与 `tauri.conf.json` 里写死的 endpoints 相比，开发/私有部署时不用改配置。
/// 前端目前直接用 updater 插件的 JS `check()`，这个命令供托盘/后台定时检查使用。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<UpdateInfoDto>> {
    let core = state.core().await?;
    let channel = core.get_settings().app.update_channel;
    let device = core.local_info().device_code;
    let url = format!(
        "{}/v1/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?kind=desktop&channel={}&device_id={}",
        core.api_url().trim_end_matches('/'),
        channel,
        device
    );
    let endpoint = url
        .parse()
        .map_err(|e| CommandError::unknown(format!("更新地址无效：{e}")))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| CommandError::unknown(format!("更新配置无效：{e}")))?
        .build()
        .map_err(|e| CommandError::unknown(format!("无法初始化更新器：{e}")))?;
    let found = updater
        .check()
        .await
        .map_err(|e| CommandError::new("NETWORK", format!("检查更新失败：{e}")))?;
    Ok(found.map(|u| UpdateInfoDto {
        version: u.version,
        notes: u.body.unwrap_or_default(),
    }))
}
