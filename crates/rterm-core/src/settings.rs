//! 用户设置（`Settings`）：界面和命令行看到的扁平结构，与 `config.json`（`config::Config`）互转。
//!
//! 字段名、嵌套结构与前端契约 `apps/desktop/src/backend/types.ts` 的 `Settings` 一致，序列化为 camelCase，
//! Tauri 层可以直接透传；多出来的字段（文件上限、终端上限、保留时长、默认 shell、代理等）前端可以不关心，
//! 但往返时必须原样带回（`set_settings` 收到的是完整对象）。
//!
//! 命令行的 `config get|set <项>`：项是点分路径（`host.requireConfirm`，也接受下划线写法 `host.require_confirm`）。
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::Config;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub host: HostSettings,
    pub controller: ControllerSettings,
    pub server: ServerSettings,
    pub app: AppSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostSettings {
    /// 允许被远程连接；false = “暂停被控”，信令上报 `accept:false`
    pub enabled: bool,
    pub require_confirm: bool,
    /// on_start | after_session | manual
    pub temp_password_policy: String,
    pub file_receive: bool,
    pub notify_on_connect: bool,
    pub prevent_sleep_when_connected: bool,
    /// 终端隔离（默认 true），热生效
    pub isolate_terminals: bool,
    pub claude_integration: bool,
    pub claude_statusline: bool,
    pub claude_integration_all: bool,
    /// 接收单个文件的上限（字节），热生效
    pub max_file_size: u64,
    /// 同时存在的终端上限，热生效
    pub max_terminals: u32,
    /// 无人附着的终端保留多少小时后自动关闭；0 = 永不
    pub detached_term_ttl_hours: u32,
    /// 默认 shell 的 id（None = 自动）；重启生效
    pub default_shell: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ControllerSettings {
    pub font_size: u32,
    /// auto | light | dark
    pub theme: String,
    pub notify_on_done: bool,
    pub notify_on_permission: bool,
    pub scrollback: u32,
    pub font_family: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSettings {
    pub use_system_certs: bool,
    /// 手动代理；None = 自动，空字符串 = 明确不用代理。重启生效
    pub proxy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub autostart: bool,
    pub close_to_tray: bool,
    /// stable | beta
    pub update_channel: String,
    pub crash_report: bool,
    pub safety_notice_acked: bool,
}

impl Default for HostSettings {
    fn default() -> Self {
        Settings::from_config(&Config::default()).host
    }
}

impl Default for ControllerSettings {
    fn default() -> Self {
        Settings::from_config(&Config::default()).controller
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Settings::from_config(&Config::default()).app
    }
}

/// 设置项不合法。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SettingsError(pub String);

impl Settings {
    pub fn from_config(c: &Config) -> Self {
        Settings {
            host: HostSettings {
                enabled: c.host.enabled,
                require_confirm: c.host.require_confirm,
                temp_password_policy: c.host.temp_password_policy.clone(),
                file_receive: c.host.file_receive,
                notify_on_connect: c.host.notify_on_connect,
                prevent_sleep_when_connected: c.host.prevent_sleep_when_connected,
                isolate_terminals: c.host.isolate_terminals,
                claude_integration: c.host.claude_integration,
                claude_statusline: c.host.claude_statusline,
                claude_integration_all: c.host.claude_integration_all,
                max_file_size: c.host.max_file_size,
                max_terminals: c.host.max_terminals,
                detached_term_ttl_hours: c.host.detached_term_ttl_hours,
                default_shell: c.host.default_shell.clone(),
            },
            controller: ControllerSettings {
                font_size: c.controller.font_size,
                theme: c.controller.theme.clone(),
                notify_on_done: c.controller.notify_on_done,
                notify_on_permission: c.controller.notify_on_permission,
                scrollback: c.controller.scrollback,
                font_family: c.controller.font_family.clone(),
            },
            server: ServerSettings {
                use_system_certs: c.server.use_system_certs,
                proxy: c.server.proxy.clone(),
            },
            app: AppSettings {
                autostart: c.app.autostart,
                close_to_tray: c.app.close_to_tray,
                update_channel: c.app.update_channel.clone(),
                crash_report: c.app.crash_report,
                safety_notice_acked: c.app.safety_notice_acked,
            },
        }
    }

    /// 校验取值范围。
    pub fn validate(&self) -> Result<(), SettingsError> {
        let bad = |m: &str| Err(SettingsError(m.to_string()));
        if !matches!(
            self.host.temp_password_policy.as_str(),
            "on_start" | "after_session" | "manual"
        ) {
            return bad("临时密码刷新策略只能是 on_start、after_session 或 manual");
        }
        if !matches!(self.controller.theme.as_str(), "auto" | "light" | "dark") {
            return bad("主题只能是 auto、light 或 dark");
        }
        if !matches!(self.app.update_channel.as_str(), "stable" | "beta") {
            return bad("更新通道只能是 stable 或 beta");
        }
        if !(8..=40).contains(&self.controller.font_size) {
            return bad("字号需在 8 到 40 之间");
        }
        if !(1..=64).contains(&self.host.max_terminals) {
            return bad("终端上限需在 1 到 64 之间");
        }
        if self.host.max_file_size < 1024 * 1024 {
            return bad("文件大小上限不能小于 1MB");
        }
        if !(100..=1_000_000).contains(&self.controller.scrollback) {
            return bad("回滚行数需在 100 到 1000000 之间");
        }
        Ok(())
    }

    /// 写回配置（不动 `device`、`known_hosts`、`fixed_password_set`、`cached_config`、`server.api_url`）。
    pub fn apply_to(&self, c: &mut Config) {
        c.host.enabled = self.host.enabled;
        c.host.require_confirm = self.host.require_confirm;
        c.host.temp_password_policy = self.host.temp_password_policy.clone();
        c.host.file_receive = self.host.file_receive;
        c.host.notify_on_connect = self.host.notify_on_connect;
        c.host.prevent_sleep_when_connected = self.host.prevent_sleep_when_connected;
        c.host.isolate_terminals = self.host.isolate_terminals;
        c.host.claude_integration = self.host.claude_integration;
        c.host.claude_statusline = self.host.claude_statusline;
        c.host.claude_integration_all = self.host.claude_integration_all;
        c.host.max_file_size = self.host.max_file_size;
        c.host.max_terminals = self.host.max_terminals;
        c.host.detached_term_ttl_hours = self.host.detached_term_ttl_hours;
        c.host.default_shell = self.host.default_shell.clone().filter(|s| !s.is_empty());
        c.controller.font_size = self.controller.font_size;
        c.controller.theme = self.controller.theme.clone();
        c.controller.notify_on_done = self.controller.notify_on_done;
        c.controller.notify_on_permission = self.controller.notify_on_permission;
        c.controller.scrollback = self.controller.scrollback;
        c.controller.font_family = self
            .controller
            .font_family
            .clone()
            .filter(|s| !s.is_empty());
        c.server.use_system_certs = self.server.use_system_certs;
        c.server.proxy = self.server.proxy.clone();
        c.app.autostart = self.app.autostart;
        c.app.close_to_tray = self.app.close_to_tray;
        c.app.update_channel = self.app.update_channel.clone();
        c.app.crash_report = self.app.crash_report;
        c.app.safety_notice_acked = self.app.safety_notice_acked;
    }

    /// 命令行 `config get`：按点分路径取值；路径为空返回整个对象。
    pub fn get_path(&self, path: &str) -> Result<Value, SettingsError> {
        let root = serde_json::to_value(self).map_err(|e| SettingsError(e.to_string()))?;
        let path = path.trim();
        if path.is_empty() {
            return Ok(root);
        }
        let mut cur = &root;
        for seg in path.split('.') {
            let key = to_camel(seg);
            cur = cur
                .get(&key)
                .ok_or_else(|| SettingsError(format!("没有这个设置项：{path}")))?;
        }
        Ok(cur.clone())
    }

    /// 命令行 `config set`：按点分路径设置。`raw` 先按 JSON 解析（`true`、`14`、`"x"`、`null`），
    /// 解析不了就当作字符串。返回新的设置（已校验）。
    pub fn with_path(&self, path: &str, raw: &str) -> Result<Settings, SettingsError> {
        let mut root = serde_json::to_value(self).map_err(|e| SettingsError(e.to_string()))?;
        let segs: Vec<String> = path.trim().split('.').map(to_camel).collect();
        if segs.is_empty() || segs.iter().any(|s| s.is_empty()) {
            return Err(SettingsError("设置项不能为空".into()));
        }
        let value: Value =
            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
        let mut cur = &mut root;
        for (i, seg) in segs.iter().enumerate() {
            let obj = cur
                .as_object_mut()
                .ok_or_else(|| SettingsError(format!("没有这个设置项：{path}")))?;
            if i + 1 == segs.len() {
                if !obj.contains_key(seg) {
                    return Err(SettingsError(format!("没有这个设置项：{path}")));
                }
                obj.insert(seg.clone(), value);
                break;
            }
            cur = obj
                .get_mut(seg)
                .ok_or_else(|| SettingsError(format!("没有这个设置项：{path}")))?;
        }
        let next: Settings = serde_json::from_value(root)
            .map_err(|e| SettingsError(format!("设置值类型不对：{e}")))?;
        next.validate()?;
        Ok(next)
    }
}

/// `require_confirm` -> `requireConfirm`；已是 camelCase 的原样返回。
fn to_camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for c in s.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_config_and_roundtrip() {
        let s = Settings::default();
        assert!(s.host.isolate_terminals);
        assert!(s.host.enabled);
        assert_eq!(s.host.temp_password_policy, "on_start");
        let mut c = Config::default();
        s.apply_to(&mut c);
        assert_eq!(Settings::from_config(&c), s);
        assert_eq!(c, Config::default());
    }

    #[test]
    fn json_is_camel_case_and_matches_frontend_shape() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["host"]["isolateTerminals"], true);
        assert_eq!(v["host"]["requireConfirm"], false);
        assert_eq!(v["controller"]["fontSize"], 14);
        assert_eq!(v["server"]["useSystemCerts"], false);
        assert_eq!(v["app"]["safetyNoticeAcked"], false);
        // 前端发来的对象缺少多余字段时用默认值
        let back: Settings = serde_json::from_value(serde_json::json!({
            "host": { "isolateTerminals": false }
        }))
        .unwrap();
        assert!(!back.host.isolate_terminals);
        assert_eq!(back.host.max_terminals, 16);
    }

    #[test]
    fn path_get_set_accepts_both_spellings() {
        let s = Settings::default();
        assert_eq!(s.get_path("host.require_confirm").unwrap(), false);
        assert_eq!(s.get_path("host.requireConfirm").unwrap(), false);
        assert!(s.get_path("host.nope").is_err());
        let n = s.with_path("host.require_confirm", "true").unwrap();
        assert!(n.host.require_confirm);
        let n = n.with_path("controller.fontSize", "18").unwrap();
        assert_eq!(n.controller.font_size, 18);
        let n = n.with_path("host.defaultShell", "bash").unwrap();
        assert_eq!(n.host.default_shell.as_deref(), Some("bash"));
        // 类型不对、取值越界、未知项
        assert!(s
            .with_path("host.requireConfirm", "\"yes please\"")
            .is_err());
        assert!(s.with_path("controller.fontSize", "2").is_err());
        assert!(s.with_path("host.tempPasswordPolicy", "sometimes").is_err());
        assert!(s.with_path("nope.x", "1").is_err());
    }
}
