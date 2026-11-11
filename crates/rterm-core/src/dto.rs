//! 给界面层的数据结构：与前端契约 `apps/desktop/src/backend/types.ts` 一一对应（camelCase）。
//!
//! Tauri 薄封装直接把这些结构（和 [`UiEvent`]）序列化给前端即可，不需要再手写转换。
//! `FileId`（u64）在 JSON 里一律是十进制字符串。
use rterm_proto::pb;
use serde::{Deserialize, Serialize};

use crate::events::{CoreEvent, SessionState, TermModes};

/// u64 <-> 十进制字符串。
pub mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfoDto {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostInfoDto {
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
    pub home_dir: String,
    pub shells: Vec<ShellInfoDto>,
    pub claude_available: bool,
    pub claude_version: String,
    pub max_file_size: u64,
}

impl From<&pb::HostInfo> for HostInfoDto {
    fn from(h: &pb::HostInfo) -> Self {
        Self {
            platform: h.platform.clone(),
            arch: h.arch.clone(),
            hostname: h.hostname.clone(),
            username: h.username.clone(),
            home_dir: h.home_dir.clone(),
            shells: h
                .shells
                .iter()
                .map(|s| ShellInfoDto {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    path: s.path.clone(),
                    is_default: s.is_default,
                })
                .collect(),
            claude_available: h.claude_available,
            claude_version: h.claude_version.clone(),
            max_file_size: h.max_file_size,
        }
    }
}

pub fn profile_str(p: i32) -> &'static str {
    match pb::Profile::try_from(p) {
        Ok(pb::Profile::Claude) => "claude",
        Ok(pb::Profile::Custom) => "custom",
        _ => "shell",
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermInfoDto {
    pub term_id: String,
    pub title: String,
    /// shell | claude | custom
    pub profile: String,
    pub shell: String,
    /// 正被另一个设备使用（不可抢占）
    pub attached_by_other: bool,
}

impl TermInfoDto {
    pub fn from_pb(t: &pb::TermInfo, shell: String) -> Self {
        Self {
            term_id: t.term_id.clone(),
            title: t.title.clone(),
            profile: profile_str(t.profile).to_string(),
            shell,
            attached_by_other: t.attached_by_other,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermOpenedDto {
    pub term_id: String,
    pub title: String,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadStartedDto {
    #[serde(with = "u64_string")]
    pub file_id: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcomeDto {
    pub passthrough: bool,
    pub return_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermModesDto {
    pub bracketed_paste: bool,
    pub alt_screen: bool,
    pub app_cursor: bool,
    pub mouse: bool,
    pub title: String,
}

impl From<&TermModes> for TermModesDto {
    fn from(m: &TermModes) -> Self {
        Self {
            bracketed_paste: m.bracketed_paste,
            alt_screen: m.alt_screen,
            app_cursor: m.app_cursor,
            mouse: m.mouse,
            title: m.title.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParamOptionDto {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionParamDto {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub options_ref: String,
    pub allow_custom: bool,
    pub required: bool,
    pub default_value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefDto {
    pub id: String,
    pub title: String,
    pub group: String,
    pub placement: String,
    pub kind: String,
    pub params: Vec<ActionParamDto>,
    pub confirm: String,
    pub note: String,
    pub enabled_when: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionCatalogDto {
    pub catalog_ver: String,
    pub app: String,
    pub actions: Vec<ActionDefDto>,
    pub options: std::collections::BTreeMap<String, Vec<ParamOptionDto>>,
}

impl From<&pb::ActionCatalog> for ActionCatalogDto {
    fn from(c: &pb::ActionCatalog) -> Self {
        Self {
            catalog_ver: c.catalog_ver.clone(),
            app: c.app.clone(),
            actions: c
                .actions
                .iter()
                .map(|a| ActionDefDto {
                    id: a.id.clone(),
                    title: a.title.clone(),
                    group: a.group.clone(),
                    placement: a.placement.clone(),
                    kind: a.kind.clone(),
                    params: a
                        .params
                        .iter()
                        .map(|p| ActionParamDto {
                            name: p.name.clone(),
                            label: p.label.clone(),
                            kind: p.r#type.clone(),
                            options_ref: p.options_ref.clone(),
                            allow_custom: p.allow_custom,
                            required: p.required,
                            default_value: p.default_value.clone(),
                        })
                        .collect(),
                    confirm: a.confirm.clone(),
                    note: a.note.clone(),
                    enabled_when: a.enabled_when.clone(),
                })
                .collect(),
            options: c
                .options
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.items
                            .iter()
                            .map(|o| ParamOptionDto {
                                value: o.value.clone(),
                                label: o.label.clone(),
                            })
                            .collect(),
                    )
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    pub app: String,
    pub running: bool,
    pub stateful: bool,
    pub version: String,
    pub activity: String,
    pub model: String,
    pub model_id: String,
    pub effort: String,
    pub fast_mode: bool,
    pub thinking: bool,
    pub context_used_pct: u32,
    pub has_context: bool,
    pub cwd: String,
    pub session_id: String,
    pub session_name: String,
    pub cost_usd: f64,
}

impl From<&pb::AppState> for AppStateDto {
    fn from(s: &pb::AppState) -> Self {
        Self {
            app: s.app.clone(),
            running: s.running,
            stateful: s.stateful,
            version: s.version.clone(),
            activity: if s.activity.is_empty() {
                "idle".into()
            } else {
                s.activity.clone()
            },
            model: s.model.clone(),
            model_id: s.model_id.clone(),
            effort: s.effort.clone(),
            fast_mode: s.fast_mode,
            thinking: s.thinking,
            context_used_pct: s.context_used_pct,
            has_context: s.has_context,
            cwd: s.cwd.clone(),
            session_id: s.session_id.clone(),
            session_name: s.session_name.clone(),
            cost_usd: s.cost_usd,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppNoticeDto {
    pub kind: String,
    pub title: String,
    pub text: String,
    /// u64 的十进制字符串
    pub notice_id: String,
    pub tool_name: String,
    pub tool_summary: String,
    pub resolved: bool,
}

impl From<&pb::AppNotice> for AppNoticeDto {
    fn from(n: &pb::AppNotice) -> Self {
        Self {
            kind: n.kind.clone(),
            title: n.title.clone(),
            text: n.text.clone(),
            notice_id: n.notice_id.to_string(),
            tool_name: n.tool_name.clone(),
            tool_summary: n.tool_summary.clone(),
            resolved: n.resolved,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandDto {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandListDto {
    pub commands: Vec<CustomCommandDto>,
}

impl From<&pb::CommandList> for CommandListDto {
    fn from(l: &pb::CommandList) -> Self {
        Self {
            commands: l
                .commands
                .iter()
                .map(|c| CustomCommandDto {
                    name: c.name.clone(),
                    description: c.description.clone(),
                    argument_hint: c.argument_hint.clone(),
                    source: c.source.clone(),
                })
                .collect(),
        }
    }
}

/// 前端 `LaunchOptions`（空字符串 = 不指定）。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchOptionsDto {
    pub model: String,
    pub permission_mode: String,
    pub effort: String,
    pub resume: String,
    pub session_name: String,
}

impl From<LaunchOptionsDto> for pb::LaunchOptions {
    fn from(l: LaunchOptionsDto) -> Self {
        pb::LaunchOptions {
            model: l.model,
            permission_mode: l.permission_mode,
            effort: l.effort,
            resume: l.resume,
            session_name: l.session_name,
        }
    }
}

/// 前端 `KnownHost`。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostDto {
    pub device_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected: Option<String>,
}

/// 来访会话（前端 `IncomingSession`）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingSessionDto {
    pub session_id: String,
    pub from_code: String,
    pub platform: String,
    pub started_at: u64,
    pub pending_confirm: bool,
}

/// 前端 `CoreEvent`（`type` 为标签的联合）。不含终端输出（输出走单独的通道，见 `Core` 文档）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UiEvent {
    SignalState {
        online: bool,
    },
    IncomingSession {
        session_id: String,
        from_code: String,
        platform: String,
        started_at: u64,
        pending_confirm: bool,
    },
    IncomingClosed {
        session_id: String,
    },
    SessionState {
        session_id: String,
        /// connecting | awaitingApproval | ready | reconnecting | closed
        state: String,
        /// reconnecting 时：第几次重试（从 1 开始）
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
        /// reconnecting 时：距下次重试的毫秒数
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_in_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason_code: Option<String>,
    },
    Latency {
        session_id: String,
        ms: u64,
    },
    HostInfo {
        session_id: String,
        info: HostInfoDto,
        features: Vec<String>,
    },
    TermState {
        session_id: String,
        term_id: String,
        state: TermModesDto,
    },
    TermExit {
        session_id: String,
        term_id: String,
        code: i32,
    },
    UploadProgress {
        session_id: String,
        #[serde(with = "u64_string")]
        file_id: u64,
        sent: u64,
        total: u64,
    },
    UploadDone {
        session_id: String,
        #[serde(with = "u64_string")]
        file_id: u64,
        remote_path: String,
    },
    UploadFailed {
        session_id: String,
        #[serde(with = "u64_string")]
        file_id: u64,
        reason: String,
    },
    ActionCatalog {
        session_id: String,
        catalog: ActionCatalogDto,
    },
    AppState {
        session_id: String,
        term_id: String,
        state: AppStateDto,
    },
    AppNotice {
        session_id: String,
        term_id: String,
        notice: AppNoticeDto,
    },
    CommandList {
        session_id: String,
        term_id: String,
        list: CommandListDto,
    },
    SettingsChanged {
        settings: Box<crate::settings::Settings>,
    },
    LocalInfoChanged {
        info: Box<crate::core::LocalInfo>,
    },
    /// 前端契约之外新增：服务端公告 / 被踢下线 / 认证错误。`level`：info | warn | error
    Notice {
        level: String,
        code: String,
        text: String,
    },
    /// 前端契约之外新增：本机版本低于服务端要求的最低版本，应阻止使用并引导升级
    UpgradeRequired {
        min_version: String,
        current_version: String,
        latest_version: Option<String>,
    },
}

/// `CoreEvent` -> `UiEvent`。
///
/// - `TermOutput` 返回 None（走输出通道）；`ActionResult` 返回 None（由 `Core::term_action` 的返回值承载）；
/// - `SessionState(Closed)` 返回 None，由紧随其后的 `SessionClosed` 带上原因码；
/// - `HostInfo` 需要对端能力列表，用 `features` 传入（`Core::ui_event` 会从会话里取）。
pub fn to_ui_event(ev: &CoreEvent, features: impl FnOnce(&str) -> Vec<String>) -> Option<UiEvent> {
    Some(match ev {
        CoreEvent::SignalState { online } => UiEvent::SignalState { online: *online },
        CoreEvent::IncomingSession {
            session,
            from_code,
            platform,
            started_at_ms,
            pending_confirm,
        } => UiEvent::IncomingSession {
            session_id: session.clone(),
            from_code: from_code.clone(),
            platform: platform.clone(),
            started_at: *started_at_ms,
            pending_confirm: *pending_confirm,
        },
        CoreEvent::IncomingClosed { session } => UiEvent::IncomingClosed {
            session_id: session.clone(),
        },
        CoreEvent::SessionState { session, state } => {
            let (name, reason) = match state {
                SessionState::Connecting => ("connecting", None),
                SessionState::AwaitingApproval => ("awaitingApproval", None),
                SessionState::Ready => ("ready", None),
                SessionState::Reconnecting => ("reconnecting", None),
                SessionState::Closed(_) => return None,
            };
            UiEvent::SessionState {
                session_id: session.clone(),
                state: name.into(),
                reason,
                reason_code: None,
                attempt: None,
                retry_in_ms: None,
            }
        }
        CoreEvent::SessionClosed {
            session,
            code,
            reason,
        } => UiEvent::SessionState {
            session_id: session.clone(),
            state: "closed".into(),
            reason: Some(reason.clone()),
            reason_code: Some(code.clone()),
            attempt: None,
            retry_in_ms: None,
        },
        CoreEvent::ReconnectInfo {
            session,
            attempt,
            retry_in_ms,
        } => UiEvent::SessionState {
            session_id: session.clone(),
            state: "reconnecting".into(),
            reason: None,
            reason_code: None,
            attempt: Some(*attempt),
            retry_in_ms: Some(*retry_in_ms),
        },
        CoreEvent::Latency { session, ms } => UiEvent::Latency {
            session_id: session.clone(),
            ms: *ms,
        },
        CoreEvent::HostInfo { session, info } => UiEvent::HostInfo {
            session_id: session.clone(),
            info: info.into(),
            features: features(session),
        },
        CoreEvent::TermOutput { .. } | CoreEvent::ActionResult { .. } => return None,
        CoreEvent::TermState {
            session,
            term,
            state,
        } => UiEvent::TermState {
            session_id: session.clone(),
            term_id: term.clone(),
            state: state.into(),
        },
        CoreEvent::TermExit {
            session,
            term,
            code,
        } => UiEvent::TermExit {
            session_id: session.clone(),
            term_id: term.clone(),
            code: *code,
        },
        CoreEvent::UploadProgress {
            session,
            file,
            sent,
            total,
        } => UiEvent::UploadProgress {
            session_id: session.clone(),
            file_id: *file,
            sent: *sent,
            total: *total,
        },
        CoreEvent::UploadDone {
            session,
            file,
            remote_path,
        } => UiEvent::UploadDone {
            session_id: session.clone(),
            file_id: *file,
            remote_path: remote_path.clone(),
        },
        CoreEvent::UploadFailed {
            session,
            file,
            reason,
        } => UiEvent::UploadFailed {
            session_id: session.clone(),
            file_id: *file,
            reason: reason.clone(),
        },
        CoreEvent::ActionCatalog { session, catalog } => UiEvent::ActionCatalog {
            session_id: session.clone(),
            catalog: catalog.into(),
        },
        CoreEvent::AppState {
            session,
            term,
            state,
        } => UiEvent::AppState {
            session_id: session.clone(),
            term_id: term.clone(),
            state: state.into(),
        },
        CoreEvent::AppNotice {
            session,
            term,
            notice,
        } => UiEvent::AppNotice {
            session_id: session.clone(),
            term_id: term.clone(),
            notice: notice.into(),
        },
        CoreEvent::CommandList {
            session,
            term,
            list,
        } => UiEvent::CommandList {
            session_id: session.clone(),
            term_id: term.clone(),
            list: list.into(),
        },
        CoreEvent::SettingsChanged { settings } => UiEvent::SettingsChanged {
            settings: settings.clone(),
        },
        CoreEvent::LocalInfoChanged { info } => UiEvent::LocalInfoChanged { info: info.clone() },
        CoreEvent::Notice { level, code, text } => UiEvent::Notice {
            level: level.clone(),
            code: code.clone(),
            text: text.clone(),
        },
        CoreEvent::UpgradeRequired {
            min_version,
            current_version,
            latest_version,
        } => UiEvent::UpgradeRequired {
            min_version: min_version.clone(),
            current_version: current_version.clone(),
            latest_version: latest_version.clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_event_json_shapes() {
        let ev = CoreEvent::UploadDone {
            session: "S1".into(),
            file: 7,
            remote_path: "/tmp/a.png".into(),
        };
        let v = serde_json::to_value(to_ui_event(&ev, |_| vec![]).unwrap()).unwrap();
        assert_eq!(v["type"], "uploadDone");
        assert_eq!(v["sessionId"], "S1");
        assert_eq!(v["fileId"], "7");
        assert_eq!(v["remotePath"], "/tmp/a.png");

        let ev = CoreEvent::SessionClosed {
            session: "S1".into(),
            code: "PASSWORD_WRONG".into(),
            reason: "密码错误".into(),
        };
        let v = serde_json::to_value(to_ui_event(&ev, |_| vec![]).unwrap()).unwrap();
        assert_eq!(v["type"], "sessionState");
        assert_eq!(v["state"], "closed");
        assert_eq!(v["reasonCode"], "PASSWORD_WRONG");

        // 不进事件流的
        assert!(to_ui_event(
            &CoreEvent::SessionState {
                session: "S1".into(),
                state: SessionState::Closed("x".into())
            },
            |_| vec![]
        )
        .is_none());
        assert!(to_ui_event(
            &CoreEvent::TermOutput {
                session: "S1".into(),
                term: "T".into(),
                seq: 0,
                data: vec![]
            },
            |_| vec![]
        )
        .is_none());
    }

    #[test]
    fn app_state_defaults_to_idle() {
        let s = AppStateDto::from(&pb::AppState::default());
        assert_eq!(s.activity, "idle");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["contextUsedPct"], 0);
    }
}
