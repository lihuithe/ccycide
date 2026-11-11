//! 动作目录、执行器、启动参数映射（《实现方案.md》18.5–18.7，《开发指南.md》T36、T37、T39）。
//!
//! - 目录是数据：内置一份默认（`claude-catalog.json`），服务端可以下发更新；
//!   下发的目录先过 [`Catalog::validate`]，不合法的整份丢弃。
//! - 执行器 [`run_action`] 只依赖 [`ActionTarget`] 这个小接口，不直接碰 PTY，方便用假的目标做单元测试。
//! - 发给主控端的 `ActionCatalog` 不包含 `steps`（[`Catalog::to_pb`]）。
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use regex::Regex;
use rterm_proto::pb;
use serde::{Deserialize, Deserializer};

use crate::events::TermModes;
use crate::host::adapter::{self, AdapterRule, SubmitPlan};
use crate::host::shell::QuoteStyle;
use crate::host::status::BridgeArgs;

/// 步骤模板的长度上限（审查 H1：模板是下发的数据，会被写进 PTY）。
pub const MAX_TEMPLATE_CHARS: usize = 200;
pub const MAX_STEPS: usize = 10;
pub const MAX_STEP_WAIT_MS: u64 = 5000;
pub const MAX_ACTIONS: usize = 200;
pub const TEXT_PARAM_MAX_CHARS: usize = 2000;
/// 每个终端的执行队列长度上限，满了返回 `BUSY`。
pub const QUEUE_LIMIT: usize = 16;
/// 默认的自定义枚举值格式（目录里没写 `pattern` 时使用）。
/// 首字符必须是字母或数字，避免 `--help` 之类被当成命令行选项。
pub const DEFAULT_TOKEN_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9._:\-\[\]/]{0,79}$";
/// 目录里的步骤不允许使用的按键：会结束或挂起终端里的程序。
pub const FORBIDDEN_CATALOG_KEYS: &[&str] = &["ctrl+d", "ctrl+z"];

pub const ALLOWED_PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan", "auto"];
pub const ALLOWED_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

// ───────────────────────── 数据结构 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionItem {
    pub value: String,
    pub label: String,
}

impl<'de> Deserialize<'de> for OptionItem {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(String),
            Full {
                value: String,
                #[serde(default)]
                label: String,
            },
        }
        Ok(match Raw::deserialize(d)? {
            Raw::Plain(s) => OptionItem {
                label: s.clone(),
                value: s,
            },
            Raw::Full { value, label } => {
                let label = if label.is_empty() {
                    value.clone()
                } else {
                    label
                };
                OptionItem { value, label }
            }
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct MatchRule {
    /// 适用的 Claude Code 版本范围（semver 写法）。缺省匹配任意版本。
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Submit,
    Keys,
    Interactive,
}

impl ActionKind {
    fn as_str(self) -> &'static str {
        match self {
            ActionKind::Submit => "submit",
            ActionKind::Keys => "keys",
            ActionKind::Interactive => "interactive",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    /// 整段交给输入适配器：写入，等待，回车
    Submit(String),
    /// 逐块写入文本，不包粘贴，不回车
    Type(String),
    /// 写入按键对应的字节
    Keys(Vec<String>),
    WaitMs(u64),
    /// 等到终端连续一段时间没有新输出，或超时
    WaitQuiet {
        ms: u64,
        timeout_ms: u64,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct StepsOverride {
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Param {
    pub name: String,
    #[serde(default)]
    pub label: String,
    /// enum | text | path
    #[serde(rename = "type", default = "default_param_type")]
    pub ptype: String,
    #[serde(default)]
    pub options_ref: String,
    #[serde(default)]
    pub allow_custom: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default, alias = "default")]
    pub default_value: String,
    #[serde(default)]
    pub pattern: Option<String>,
}

fn default_param_type() -> String {
    "text".into()
}
fn default_placement() -> String {
    "menu".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Action {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_placement")]
    pub placement: String,
    pub kind: ActionKind,
    #[serde(default)]
    pub params: Vec<Param>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub confirm: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub enabled_when: String,
    #[serde(default)]
    pub return_keys: Vec<String>,
    #[serde(default)]
    pub platform_overrides: HashMap<String, StepsOverride>,
    /// 不发给主控端的内部动作（权限卡片的按钮）
    #[serde(default)]
    pub hidden: bool,
}

impl Action {
    /// 按平台标签取步骤（`platform_overrides` 里有就用覆盖的）。
    pub fn steps_for(&self, tag: &str) -> &[Step] {
        self.platform_overrides
            .get(tag)
            .map(|o| o.steps.as_slice())
            .unwrap_or(&self.steps)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    pub catalog_ver: String,
    pub app: String,
    #[serde(default, rename = "match")]
    pub matcher: MatchRule,
    #[serde(default)]
    pub options: HashMap<String, Vec<OptionItem>>,
    pub actions: Vec<Action>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CatalogError {
    #[error("目录 JSON 解析失败：{0}")]
    Json(String),
    #[error("目录校验失败：{0}")]
    Invalid(String),
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, CatalogError> {
    Err(CatalogError::Invalid(msg.into()))
}

/// 模板里的 `{名字}` 占位符。
fn placeholders(tpl: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = tpl.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'{' {
            if let Some(rel) = tpl[i + 1..].find('}') {
                let name = &tpl[i + 1..i + 1 + rel];
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push(name.to_string());
                    i += rel + 2;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

impl Catalog {
    /// 内置默认目录（Claude Code）。
    pub fn builtin() -> Catalog {
        // 内置目录必须能解析并通过校验，单元测试保证这一点
        Catalog::from_json(include_str!("claude-catalog.json")).unwrap_or_else(|e| {
            tracing::error!("内置动作目录无效：{e}");
            Catalog {
                catalog_ver: "invalid".into(),
                app: "claude".into(),
                matcher: MatchRule::default(),
                options: HashMap::new(),
                actions: Vec::new(),
            }
        })
    }

    /// 解析并校验一份目录。
    pub fn from_json(json: &str) -> Result<Catalog, CatalogError> {
        let c: Catalog =
            serde_json::from_str(json).map_err(|e| CatalogError::Json(e.to_string()))?;
        c.validate()?;
        Ok(c)
    }

    pub fn action(&self, id: &str) -> Option<&Action> {
        self.actions.iter().find(|a| a.id == id)
    }

    /// 校验（《开发指南.md》T36 的表格）。下发的和内置的目录都要过。
    pub fn validate(&self) -> Result<(), CatalogError> {
        if self.catalog_ver.is_empty() || self.catalog_ver.len() > 64 {
            return invalid("catalog_ver 为空或过长");
        }
        if self.app.is_empty() {
            return invalid("app 为空");
        }
        if self.actions.is_empty() || self.actions.len() > MAX_ACTIONS {
            return invalid(format!("动作数量应在 1 到 {MAX_ACTIONS} 之间"));
        }
        if let Some(v) = &self.matcher.version {
            if semver::VersionReq::parse(v).is_err() {
                return invalid(format!("match.version 无效：{v}"));
            }
        }
        let token = Regex::new(DEFAULT_TOKEN_PATTERN)
            .map_err(|_| CatalogError::Invalid("内部错误".into()))?;
        for (name, list) in &self.options {
            if list.len() > 200 {
                return invalid(format!("选项表 {name} 过长"));
            }
            for o in list {
                // 选项值会被直接替换进步骤模板，必须是单个安全的 token；标签只用于显示，不能含控制字符
                if !token.is_match(&o.value) {
                    return invalid(format!("选项表 {name} 里的值 {:?} 格式不合法", o.value));
                }
                if o.label.chars().count() > 100 || o.label.chars().any(char::is_control) {
                    return invalid(format!("选项表 {name} 里的标签过长或含控制字符"));
                }
            }
        }
        let mut seen = HashSet::new();
        for a in &self.actions {
            self.validate_action(a)?;
            if !seen.insert(a.id.as_str()) {
                return invalid(format!("动作 id 重复：{}", a.id));
            }
        }
        Ok(())
    }

    fn validate_action(&self, a: &Action) -> Result<(), CatalogError> {
        let id = &a.id;
        if id.is_empty()
            || id.len() > 64
            || !id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_')
        {
            return invalid(format!("动作 id 只能含小写字母、数字、点、下划线：{id}"));
        }
        if a.title.is_empty() || a.title.chars().count() > 100 {
            return invalid(format!("{id}：title 为空或过长"));
        }
        // 这些文字会显示在主控端界面上，不能夹带控制字符（含 ESC）
        for (name, v) in [
            ("title", &a.title),
            ("group", &a.group),
            ("confirm", &a.confirm),
            ("note", &a.note),
            ("placement", &a.placement),
        ] {
            if v.chars().count() > 500 || v.chars().any(char::is_control) {
                return invalid(format!("{id}：{name} 过长或含控制字符"));
            }
        }
        if !["toolbar", "menu", "palette_only"].contains(&a.placement.as_str()) {
            return invalid(format!("{id}：placement 无效"));
        }
        if !["", "busy", "idle"].contains(&a.enabled_when.as_str()) {
            return invalid(format!("{id}：enabled_when 无效"));
        }
        let mut names = HashSet::new();
        for p in &a.params {
            if p.name.is_empty()
                || !p
                    .name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return invalid(format!("{id}：参数名无效"));
            }
            if !names.insert(p.name.as_str()) {
                return invalid(format!("{id}：参数名重复 {}", p.name));
            }
            if p.label.chars().any(char::is_control)
                || p.default_value.chars().any(char::is_control)
            {
                return invalid(format!("{id}：参数 {} 的标签或默认值含控制字符", p.name));
            }
            if !["enum", "text", "path"].contains(&p.ptype.as_str()) {
                return invalid(format!("{id}：参数类型无效 {}", p.ptype));
            }
            if !p.options_ref.is_empty() && !self.options.contains_key(&p.options_ref) {
                return invalid(format!(
                    "{id}：options_ref 指向的选项表不存在 {}",
                    p.options_ref
                ));
            }
            if p.ptype == "enum" && p.options_ref.is_empty() && !p.allow_custom {
                return invalid(format!("{id}：enum 参数没有选项来源"));
            }
            if let Some(pat) = &p.pattern {
                if pat.len() > 200 || Regex::new(pat).is_err() {
                    return invalid(format!("{id}：pattern 无效"));
                }
            }
        }
        let mut all_steps: Vec<&[Step]> = vec![a.steps.as_slice()];
        for o in a.platform_overrides.values() {
            all_steps.push(o.steps.as_slice());
        }
        for steps in all_steps {
            if steps.is_empty() || steps.len() > MAX_STEPS {
                return invalid(format!("{id}：步骤数应在 1 到 {MAX_STEPS} 之间"));
            }
            for s in steps {
                match s {
                    Step::Submit(t) | Step::Type(t) => {
                        if t.chars().count() > MAX_TEMPLATE_CHARS {
                            return invalid(format!("{id}：模板过长"));
                        }
                        // 模板会写进 PTY：不允许任何控制字符（ESC 序列、换行、回车等）
                        if t.chars().any(char::is_control) {
                            return invalid(format!("{id}：模板含控制字符"));
                        }
                        let first = t.trim_start().chars().next();
                        // Claude Code 里以 `!` 开头的输入直接执行 shell 命令
                        if first == Some('!') {
                            return invalid(format!("{id}：模板不能以 ! 开头"));
                        }
                        // 提交的内容只能是斜杠命令
                        if matches!(s, Step::Submit(_)) && first != Some('/') {
                            return invalid(format!("{id}：提交模板必须以 / 开头"));
                        }
                        for ph in placeholders(t) {
                            if !names.contains(ph.as_str()) {
                                return invalid(format!("{id}：占位符 {{{ph}}} 没有对应的参数"));
                            }
                        }
                    }
                    Step::Keys(keys) => {
                        if keys.is_empty() || keys.len() > 16 {
                            return invalid(format!("{id}：keys 数量无效"));
                        }
                        for k in keys {
                            if key_bytes(k, false).is_none() {
                                return invalid(format!("{id}：未知按键 {k}"));
                            }
                            if FORBIDDEN_CATALOG_KEYS.contains(&k.as_str()) {
                                return invalid(format!("{id}：不允许使用按键 {k}"));
                            }
                        }
                    }
                    Step::WaitMs(ms) => {
                        if *ms > MAX_STEP_WAIT_MS {
                            return invalid(format!("{id}：等待时间超过 {MAX_STEP_WAIT_MS} 毫秒"));
                        }
                    }
                    Step::WaitQuiet { ms, timeout_ms } => {
                        if *ms > MAX_STEP_WAIT_MS || *timeout_ms > MAX_STEP_WAIT_MS {
                            return invalid(format!(
                                "{id}：wait_quiet 时间超过 {MAX_STEP_WAIT_MS} 毫秒"
                            ));
                        }
                    }
                }
            }
        }
        for k in &a.return_keys {
            if key_bytes(k, false).is_none() || FORBIDDEN_CATALOG_KEYS.contains(&k.as_str()) {
                return invalid(format!("{id}：return_keys 里有未知或不允许的按键 {k}"));
            }
        }
        // 权限卡片的按钮是安全边界：步骤固定，不接受下发的数据改动
        if let Some(expect) = match id.as_str() {
            "permission.allow" => Some("enter"),
            "permission.deny" => Some("esc"),
            _ => None,
        } {
            let pinned = a.hidden
                && a.kind == ActionKind::Keys
                && a.platform_overrides.is_empty()
                && a.params.len() == 1
                && a.params[0].name == "notice_id"
                && matches!(a.steps.as_slice(), [Step::Keys(k)] if k.as_slice() == [expect]);
            if !pinned {
                return invalid(format!(
                    "{id}：权限按钮必须是隐藏的 keys 动作，只有一个 notice_id 参数，步骤固定为 {expect}"
                ));
            }
        }
        Ok(())
    }

    /// 转成发给主控端的消息：不包含 `steps`，也不包含 `hidden` 的内部动作。
    pub fn to_pb(&self) -> pb::ActionCatalog {
        pb::ActionCatalog {
            catalog_ver: self.catalog_ver.clone(),
            app: self.app.clone(),
            actions: self
                .actions
                .iter()
                .filter(|a| !a.hidden)
                .map(|a| pb::ActionDef {
                    id: a.id.clone(),
                    title: a.title.clone(),
                    group: a.group.clone(),
                    placement: a.placement.clone(),
                    kind: a.kind.as_str().into(),
                    params: a
                        .params
                        .iter()
                        .map(|p| pb::ActionParam {
                            name: p.name.clone(),
                            label: p.label.clone(),
                            r#type: p.ptype.clone(),
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
            options: self
                .options
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        pb::OptionList {
                            items: v
                                .iter()
                                .map(|o| pb::ParamOption {
                                    value: o.value.clone(),
                                    label: o.label.clone(),
                                })
                                .collect(),
                        },
                    )
                })
                .collect(),
        }
    }

    /// 本份目录是否适用于给定的 Claude Code 版本。
    pub fn matches_version(&self, claude_version: Option<&str>) -> bool {
        let Some(req) = &self.matcher.version else {
            return true;
        };
        let Ok(req) = semver::VersionReq::parse(req) else {
            return false;
        };
        claude_version
            .and_then(|v| semver::Version::parse(v).ok())
            .is_some_and(|v| req.matches(&v))
    }
}

/// 选择目录：从下发的列表里取第一份"通过校验且版本范围匹配"的，都不行用内置的。
/// `remote` 可以是一个目录对象，也可以是目录数组；每份单独校验，非法的整份丢弃并记日志。
pub fn pick_catalog(remote_json: Option<&str>, claude_version: Option<&str>) -> Catalog {
    if let Some(json) = remote_json {
        let values: Vec<serde_json::Value> = match serde_json::from_str::<serde_json::Value>(json) {
            Ok(serde_json::Value::Array(a)) => a,
            Ok(v @ serde_json::Value::Object(_)) => vec![v],
            _ => {
                tracing::warn!("下发的动作目录不是 JSON 对象或数组，已忽略");
                Vec::new()
            }
        };
        for v in values {
            match Catalog::from_json(&v.to_string()) {
                Ok(c) if c.matches_version(claude_version) => {
                    tracing::info!("使用下发的动作目录 {}", c.catalog_ver);
                    return c;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("丢弃下发的动作目录：{e}"),
            }
        }
    }
    Catalog::builtin()
}

// ───────────────────────── 按键表 ─────────────────────────

/// 按键名 -> 字节。`app_cursor` 为真时方向键用另一套编码。
pub fn key_bytes(name: &str, app_cursor: bool) -> Option<Vec<u8>> {
    let b: &[u8] = match name {
        "esc" => b"\x1b",
        "enter" => b"\r",
        "tab" => b"\t",
        "shift+tab" => b"\x1b[Z",
        "backspace" => b"\x7f",
        "up" => {
            if app_cursor {
                b"\x1bOA"
            } else {
                b"\x1b[A"
            }
        }
        "down" => {
            if app_cursor {
                b"\x1bOB"
            } else {
                b"\x1b[B"
            }
        }
        "right" => {
            if app_cursor {
                b"\x1bOC"
            } else {
                b"\x1b[C"
            }
        }
        "left" => {
            if app_cursor {
                b"\x1bOD"
            } else {
                b"\x1b[D"
            }
        }
        _ => {
            if let Some(c) = name.strip_prefix("ctrl+").and_then(single_lower) {
                return Some(vec![c as u8 - 96]);
            }
            if let Some(c) = name.strip_prefix("alt+").and_then(single_lower) {
                return Some(vec![0x1b, c as u8]);
            }
            return None;
        }
    };
    Some(b.to_vec())
}

fn single_lower(s: &str) -> Option<char> {
    let mut it = s.chars();
    match (it.next(), it.next()) {
        (Some(c), None) if c.is_ascii_lowercase() => Some(c),
        _ => None,
    }
}

// ───────────────────────── 参数校验与模板 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    Unsupported,
    BadRequest(String),
    AppNotRunning,
    Busy,
    TermNotFound,
    /// 写 PTY 失败（终端已关闭）
    Io,
}

impl ActionError {
    /// `TermActionResult.error` 里的错误码。
    pub fn code(&self) -> &'static str {
        match self {
            ActionError::Unsupported => "UNSUPPORTED",
            ActionError::BadRequest(_) => "BAD_REQUEST",
            ActionError::AppNotRunning => "APP_NOT_RUNNING",
            ActionError::Busy => "BUSY",
            ActionError::TermNotFound => "TERM_NOT_FOUND",
            ActionError::Io => "TERM_NOT_FOUND",
        }
    }
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionError::BadRequest(m) => write!(f, "BAD_REQUEST: {m}"),
            other => write!(f, "{}", other.code()),
        }
    }
}

fn strip_control(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

/// 按 18.5.4 校验并清洗一个参数值。
pub fn clean_param(
    p: &Param,
    raw: &str,
    cat: &Catalog,
    windows: bool,
) -> Result<String, ActionError> {
    let raw = if raw.is_empty() {
        p.default_value.as_str()
    } else {
        raw
    };
    if raw.is_empty() {
        return if p.required {
            Err(ActionError::BadRequest(format!("缺少必填参数 {}", p.name)))
        } else {
            Ok(String::new())
        };
    }
    match p.ptype.as_str() {
        "enum" => {
            let listed = cat
                .options
                .get(&p.options_ref)
                .is_some_and(|l| l.iter().any(|o| o.value == raw));
            if listed {
                return Ok(raw.to_string());
            }
            if !p.allow_custom {
                return Err(ActionError::BadRequest(format!(
                    "参数 {} 的值不在选项里",
                    p.name
                )));
            }
            // 无论目录里的 pattern 怎么写（下发的数据可能是 `.*`），控制字符一律拒绝
            if raw.chars().any(char::is_control) {
                return Err(ActionError::BadRequest(format!(
                    "参数 {} 含控制字符",
                    p.name
                )));
            }
            let pat = p.pattern.as_deref().unwrap_or(DEFAULT_TOKEN_PATTERN);
            let re = Regex::new(pat).map_err(|_| ActionError::BadRequest("pattern 无效".into()))?;
            if re.is_match(raw) {
                Ok(raw.to_string())
            } else {
                Err(ActionError::BadRequest(format!(
                    "参数 {} 的格式不合法",
                    p.name
                )))
            }
        }
        "path" => {
            let s = strip_control(raw);
            if s.is_empty() {
                return Err(ActionError::BadRequest(format!("参数 {} 为空", p.name)));
            }
            Ok(adapter::quote_path(&s, windows))
        }
        _ => {
            let s: String = strip_control(raw)
                .chars()
                .take(TEXT_PARAM_MAX_CHARS)
                .collect();
            if s.trim().is_empty() && p.required {
                return Err(ActionError::BadRequest(format!("缺少必填参数 {}", p.name)));
            }
            Ok(s.trim().to_string())
        }
    }
}

/// 模板替换。可选参数为空时占位符替换为空，并去掉末尾多余的空格。
pub fn fill_template(
    tpl: &str,
    action: &Action,
    args: &HashMap<String, String>,
    cat: &Catalog,
    windows: bool,
) -> Result<String, ActionError> {
    // 先校验并清洗所有参数，再单次扫描替换：参数值里即使出现 `{别的参数名}` 也不会被再次替换
    let mut vals: HashMap<&str, String> = HashMap::new();
    for p in &action.params {
        let raw = args.get(&p.name).map(String::as_str).unwrap_or("");
        vals.insert(p.name.as_str(), clean_param(p, raw, cat, windows)?);
    }
    let mut out = String::with_capacity(tpl.len() + 32);
    let mut rest = tpl;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) if vals.contains_key(&after[..end]) => {
                out.push_str(&vals[&after[..end]]);
                rest = &after[end + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out.trim_end().to_string())
}

// ───────────────────────── 执行器 ─────────────────────────

/// 目标终端里应用的状态快照。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppSnapshot {
    /// 终端里是否在运行 Claude Code（有状态回传时用它的结果，否则靠进程检测）
    pub running: bool,
    pub stateful: bool,
    /// idle | busy | waiting_permission
    pub activity: String,
    /// 当前未处理的权限请求编号
    pub pending_notice: Option<u64>,
    /// 当前权限请求的摘要被截断（远端看不到完整命令）：不允许远端"允许"
    pub pending_truncated: bool,
}

/// 执行器对终端的全部需求。
#[allow(async_fn_in_trait)]
pub trait ActionTarget {
    async fn write(&self, data: Vec<u8>) -> Result<(), ActionError>;
    fn modes(&self) -> TermModes;
    fn app(&self) -> AppSnapshot;
    async fn wait_quiet(&self, quiet: Duration, timeout: Duration);
    /// 输出流当前的末尾偏移
    fn output_mark(&self) -> u64;
    /// 偏移 `from` 之后的输出
    fn output_since(&self, from: u64) -> Vec<u8>;
    fn adapter_rule(&self) -> AdapterRule;
    /// 被控端是不是 Windows（决定路径引号写法）
    fn windows(&self) -> bool;
    /// `platform_overrides` 用的标签，如 `windows` / `windows_no_vt` / `unix`
    fn platform_tag(&self) -> String;
}

/// 动作执行成功后的信息。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionOutcome {
    pub passthrough: bool,
    pub return_keys: Vec<String>,
}

/// 写一份 `SubmitPlan`：分块写入（块之间让出执行权），等待，再回车。
pub async fn write_plan<T: ActionTarget>(t: &T, plan: SubmitPlan) -> Result<(), ActionError> {
    let n = plan.chunks.len();
    for (i, c) in plan.chunks.into_iter().enumerate() {
        let images = plan.image_waits.get(i).copied().unwrap_or(0);
        let mark = t.output_mark();
        t.write(c).await?;
        let pause = plan.pauses.get(i).copied().unwrap_or_default();
        if images > 0 {
            wait_image_marks(t, mark, images, pause.max(plan.image_wait)).await;
        } else if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        } else if i + 1 < n {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    if let Some(enter) = plan.enter {
        tokio::time::sleep(plan.delay_before_enter).await;
        t.write(enter).await?;
    }
    Ok(())
}

/// 等 `mark` 之后的输出里出现 `want` 个图片标记，最多等 `max`。
/// Claude Code 读取图片是异步的，标记出现前回车，消息里就只有文字、图片随后才进输入框。
async fn wait_image_marks<T: ActionTarget>(t: &T, mark: u64, want: usize, max: Duration) {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        if adapter::count_image_marks(&t.output_since(mark)) >= want {
            // 标记出现后留一点时间让输入框把这一帧画完
            tokio::time::sleep(Duration::from_millis(50)).await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            tracing::debug!("等待图片标记超时（期望 {want} 个）");
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 步骤解析后的形态：模板已经替换、按键已经解析，执行前先全部准备好，
/// 这样参数不合法时一个字节也不会写进终端。
enum Prepared {
    Submit(String),
    Type(String),
    Keys(Vec<String>),
    WaitMs(u64),
    WaitQuiet(u64, u64),
}

pub async fn run_action<T: ActionTarget>(
    catalog: &Catalog,
    target: &T,
    action_id: &str,
    args: &HashMap<String, String>,
) -> Result<ActionOutcome, ActionError> {
    // 1. 在目录里找到动作
    let action = catalog.action(action_id).ok_or(ActionError::Unsupported)?;
    // 2. 终端里要在运行 Claude Code
    let app = target.app();
    if !app.running {
        return Err(ActionError::AppNotRunning);
    }
    // 权限卡片的按钮：notice_id 必须仍是该终端当前未处理的权限请求，否则不发送任何按键
    if action_id == "permission.allow" || action_id == "permission.deny" {
        let id: u64 = args
            .get("notice_id")
            .and_then(|s| s.trim().parse().ok())
            .ok_or_else(|| ActionError::BadRequest("notice_id 无效".into()))?;
        if !(app.stateful && app.activity == "waiting_permission" && app.pending_notice == Some(id))
        {
            return Err(ActionError::BadRequest("该权限请求已失效".into()));
        }
        // 审查 M6：命令太长、卡片上显示不全时，远端不能一键允许（否则可以把恶意后半段藏在截断处之后）
        if action_id == "permission.allow" && app.pending_truncated {
            return Err(ActionError::BadRequest(
                "内容过长，远端无法看全，不能在这里允许；请回到终端查看并确认（仍可拒绝）".into(),
            ));
        }
    }
    if !action.enabled_when.is_empty() && app.stateful {
        let busy = app.activity != "idle";
        let ok = match action.enabled_when.as_str() {
            "busy" => busy,
            "idle" => !busy,
            _ => true,
        };
        if !ok {
            return Err(ActionError::BadRequest(format!(
                "当前状态下不能执行（需要 {}）",
                action.enabled_when
            )));
        }
    }
    // 3. 校验参数、准备步骤
    let windows = target.windows();
    let mut prepared = Vec::new();
    for step in action.steps_for(&target.platform_tag()) {
        prepared.push(match step {
            Step::Submit(t) => Prepared::Submit(fill_template(t, action, args, catalog, windows)?),
            Step::Type(t) => Prepared::Type(fill_template(t, action, args, catalog, windows)?),
            Step::Keys(k) => Prepared::Keys(k.clone()),
            Step::WaitMs(ms) => Prepared::WaitMs((*ms).min(MAX_STEP_WAIT_MS)),
            Step::WaitQuiet { ms, timeout_ms } => Prepared::WaitQuiet(
                (*ms).min(MAX_STEP_WAIT_MS),
                (*timeout_ms).min(MAX_STEP_WAIT_MS),
            ),
        });
    }
    // 4. 依次执行
    for p in prepared {
        match p {
            Prepared::Submit(text) => {
                let plan = adapter::build_submit(
                    &target.adapter_rule(),
                    &target.modes(),
                    &text,
                    &[],
                    true,
                    windows,
                );
                write_plan(target, plan).await?;
            }
            Prepared::Type(text) => {
                let clean = adapter::sanitize(&text).replace('\n', " ");
                for chunk in adapter::split_utf8(clean.as_bytes(), 64) {
                    target.write(chunk).await?;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
            Prepared::Keys(names) => {
                for n in names {
                    let bytes =
                        key_bytes(&n, target.modes().app_cursor).ok_or(ActionError::Unsupported)?;
                    target.write(bytes).await?;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            Prepared::WaitMs(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            Prepared::WaitQuiet(ms, timeout) => {
                target
                    .wait_quiet(Duration::from_millis(ms), Duration::from_millis(timeout))
                    .await;
            }
        }
    }
    // 5. interactive：交还键盘
    if action.kind == ActionKind::Interactive {
        let return_keys = if action.return_keys.is_empty() {
            vec!["enter".to_string(), "esc".to_string()]
        } else {
            action.return_keys.clone()
        };
        return Ok(ActionOutcome {
            passthrough: true,
            return_keys,
        });
    }
    Ok(ActionOutcome::default())
}

// ───────────────────────── 启动参数映射 ─────────────────────────

fn bad<T>(msg: impl Into<String>) -> Result<T, ActionError> {
    Err(ActionError::BadRequest(msg.into()))
}

/// 给参数值加引号。cmd 遇到双引号、百分号、控制字符直接拒绝，不尝试转义。
pub fn quote(style: QuoteStyle, value: &str) -> Result<String, ActionError> {
    if value.chars().any(|c| c.is_control()) {
        return bad("参数含控制字符");
    }
    match style {
        QuoteStyle::PowerShell => {
            // PowerShell 把弯引号也当作单引号，统一成 ASCII 单引号再加倍
            let v: String = value
                .chars()
                .map(|c| {
                    if matches!(c, '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                        '\''
                    } else {
                        c
                    }
                })
                .collect();
            Ok(format!("'{}'", v.replace('\'', "''")))
        }
        QuoteStyle::Posix => Ok(format!("'{}'", value.replace('\'', r"'\''"))),
        QuoteStyle::Cmd => {
            if value.contains('"') || value.contains('%') {
                return bad("cmd 下参数不能含双引号或百分号");
            }
            Ok(format!("\"{value}\""))
        }
    }
}

fn check_token(v: &str) -> Result<String, ActionError> {
    let re = Regex::new(DEFAULT_TOKEN_PATTERN)
        .map_err(|_| ActionError::BadRequest("内部错误".into()))?;
    if re.is_match(v) {
        Ok(v.to_string())
    } else {
        bad("参数格式不合法")
    }
}

fn check_enum(v: &str, allowed: &[&str]) -> Result<String, ActionError> {
    if allowed.contains(&v) {
        Ok(v.to_string())
    } else {
        bad(format!("不允许的取值 {v}"))
    }
}

/// 把新建对话框的选项拼成 `claude` 命令行（《实现方案.md》18.7，《开发指南.md》T39）。
/// 不提供跳过权限检查的模式：`bypassPermissions` 之类一律拒绝。
pub fn build_claude_command(
    style: QuoteStyle,
    launch: &pb::LaunchOptions,
    bridge: Option<&BridgeArgs>,
) -> Result<String, ActionError> {
    let mut parts: Vec<String> = vec!["claude".into()];
    if !launch.model.is_empty() {
        parts.push("--model".into());
        parts.push(quote(style, &check_token(&launch.model)?)?);
    }
    if !launch.permission_mode.is_empty() {
        parts.push("--permission-mode".into());
        parts.push(check_enum(
            &launch.permission_mode,
            ALLOWED_PERMISSION_MODES,
        )?);
    }
    if !launch.effort.is_empty() {
        parts.push("--effort".into());
        parts.push(check_enum(&launch.effort, ALLOWED_EFFORTS)?);
    }
    match launch.resume.as_str() {
        "" => {}
        "continue" => parts.push("--continue".into()),
        "pick" => parts.push("--resume".into()),
        other => return bad(format!("未知的 resume 取值 {other}")),
    }
    if !launch.session_name.is_empty() {
        let name: String = strip_control(&launch.session_name)
            .chars()
            .take(200)
            .collect();
        parts.push("--name".into());
        parts.push(quote(style, &name)?);
    }
    if let Some(b) = bridge {
        // 状态回传的参数：路径拼不出安全的引号时（cmd 下含百分号）就不附加，退化为无状态
        let mut extra = Vec::new();
        let plugin = quote(style, &b.plugin_dir);
        let settings = b.settings_file.as_ref().map(|s| quote(style, s));
        if let Ok(plugin) = plugin {
            extra.push("--plugin-dir".to_string());
            extra.push(plugin);
            if let Some(Ok(s)) = settings {
                extra.push("--settings".into());
                extra.push(s);
            }
            parts.extend(extra);
        }
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // ---- 目录 ----

    #[test]
    fn builtin_parses_and_validates() {
        let c = Catalog::builtin();
        assert_ne!(c.catalog_ver, "invalid");
        c.validate().expect("内置目录应通过校验");
        // §18.5.5 的 31 项（含重命名等）+ 2 个内部动作
        assert!(c.actions.len() >= 31, "动作数 {}", c.actions.len());
        for id in [
            "model.set",
            "effort.set",
            "mode.cycle",
            "interrupt",
            "fast.set",
            "thinking.toggle",
            "plan.enter",
            "model.menu",
            "session.clear",
            "session.compact",
            "context.show",
            "session.resume",
            "session.rewind",
            "session.rename",
            "dir.add",
            "dir.cd",
            "usage.show",
            "review.code",
            "diff.show",
            "project.init",
            "session.export",
            "permissions.show",
            "mcp.show",
            "config.show",
            "memory.show",
            "verbose.toggle",
            "background.run",
            "todos.toggle",
            "tasks.show",
            "account.login",
            "app.exit",
            "permission.allow",
            "permission.deny",
        ] {
            assert!(c.action(id).is_some(), "缺少动作 {id}");
        }
        assert!(!c
            .action("session.clear")
            .map(|a| a.confirm.is_empty())
            .unwrap_or(true));
        assert!(!c
            .action("app.exit")
            .map(|a| a.confirm.is_empty())
            .unwrap_or(true));
        assert_eq!(
            c.action("interrupt").map(|a| a.enabled_when.as_str()),
            Some("busy")
        );
        assert_eq!(
            c.action("model.menu").map(|a| a.kind),
            Some(ActionKind::Interactive)
        );
    }

    #[test]
    fn to_pb_has_no_steps_and_skips_hidden() {
        let c = Catalog::builtin();
        let pbc = c.to_pb();
        assert_eq!(pbc.app, "claude");
        assert_eq!(
            pbc.actions.len(),
            c.actions.iter().filter(|a| !a.hidden).count()
        );
        assert!(pbc.actions.iter().all(|a| !a.id.starts_with("permission.")));
        let model = pbc
            .actions
            .iter()
            .find(|a| a.id == "model.set")
            .expect("model.set");
        assert_eq!(model.kind, "submit");
        assert_eq!(model.params[0].options_ref, "models");
        assert!(model.params[0].allow_custom);
        assert_eq!(pbc.options["models"].items[0].value, "default");
        assert_eq!(pbc.options["efforts"].items.len(), 6);
        // 编码后的字节里没有任何步骤内容（命令模板）
        use prost::Message;
        let bytes = pbc.encode_to_vec();
        let s = String::from_utf8_lossy(&bytes);
        assert!(!s.contains("/model {model}"));
        assert!(!s.contains("/compact"));
    }

    fn base(actions: &str) -> String {
        format!(
            r#"{{"catalog_ver":"1","app":"claude","options":{{"m":["a","b"]}},"actions":[{actions}]}}"#
        )
    }

    #[test]
    fn rejects_invalid_catalogs() {
        let ok = r#"{"id":"a.b","title":"t","kind":"keys","steps":[{"keys":["esc"]}]}"#;
        assert!(Catalog::from_json(&base(ok)).is_ok());
        // 重复 id
        assert!(Catalog::from_json(&base(&format!("{ok},{ok}"))).is_err());
        // id 字符非法
        assert!(Catalog::from_json(&base(
            r#"{"id":"A-b","title":"t","kind":"keys","steps":[{"keys":["esc"]}]}"#
        ))
        .is_err());
        // 未知按键
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"keys","steps":[{"keys":["f13"]}]}"#
        ))
        .is_err());
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"keys","steps":[{"keys":["ctrl+1"]}]}"#
        ))
        .is_err());
        // 占位符没有对应参数
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"submit","steps":[{"submit":"/x {nope}"}]}"#
        ))
        .is_err());
        // 步骤过多
        let many = [r#"{"wait_ms":1}"#; 11].join(",");
        assert!(Catalog::from_json(&base(&format!(
            r#"{{"id":"a","title":"t","kind":"keys","steps":[{many}]}}"#
        )))
        .is_err());
        // 没有步骤
        assert!(
            Catalog::from_json(&base(r#"{"id":"a","title":"t","kind":"keys","steps":[]}"#))
                .is_err()
        );
        // 等待太久
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"keys","steps":[{"wait_ms":5001}]}"#
        ))
        .is_err());
        assert!(Catalog::from_json(&base(r#"{"id":"a","title":"t","kind":"keys","steps":[{"wait_quiet":{"ms":10,"timeout_ms":9000}}]}"#)).is_err());
        // 模板过长
        let long = "x".repeat(501);
        assert!(Catalog::from_json(&base(&format!(
            r#"{{"id":"a","title":"t","kind":"submit","steps":[{{"submit":"{long}"}}]}}"#
        )))
        .is_err());
        // options_ref 不存在
        assert!(Catalog::from_json(&base(r#"{"id":"a","title":"t","kind":"submit","params":[{"name":"p","type":"enum","options_ref":"zz"}],"steps":[{"submit":"/x {p}"}]}"#)).is_err());
        // 未知步骤类型 / 未知 kind
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"keys","steps":[{"shell":"rm -rf /"}]}"#
        ))
        .is_err());
        assert!(Catalog::from_json(&base(
            r#"{"id":"a","title":"t","kind":"exec","steps":[{"keys":["esc"]}]}"#
        ))
        .is_err());
        // pattern 非法
        assert!(Catalog::from_json(&base(r#"{"id":"a","title":"t","kind":"submit","params":[{"name":"p","type":"enum","options_ref":"m","pattern":"("}],"steps":[{"submit":"/x {p}"}]}"#)).is_err());
        // platform_overrides 里的坏按键也要查
        assert!(Catalog::from_json(&base(r#"{"id":"a","title":"t","kind":"keys","steps":[{"keys":["esc"]}],"platform_overrides":{"windows":{"steps":[{"keys":["nope"]}]}}}"#)).is_err());
    }

    #[test]
    fn version_matching_and_pick() {
        let c = Catalog::builtin();
        assert!(c.matches_version(Some("2.1.322")));
        assert!(!c.matches_version(Some("2.0.9")));
        assert!(!c.matches_version(None));

        let remote = r#"[{"catalog_ver":"bad","app":"claude","actions":[]},
               {"catalog_ver":"old","app":"claude","match":{"version":"<2.0.0"},"actions":[{"id":"a","title":"t","kind":"keys","steps":[{"keys":["esc"]}]}]},
               {"catalog_ver":"new","app":"claude","match":{"version":">=2.1.0"},"actions":[{"id":"a","title":"t","kind":"keys","steps":[{"keys":["esc"]}]}]}]"#;
        assert_eq!(
            pick_catalog(Some(remote), Some("2.1.322")).catalog_ver,
            "new"
        );
        assert_eq!(pick_catalog(Some(remote), Some("1.9.0")).catalog_ver, "old");
        // 都不匹配或整体坏掉：用内置
        assert_eq!(
            pick_catalog(Some(remote), Some("2.0.5")).catalog_ver,
            Catalog::builtin().catalog_ver
        );
        assert_eq!(
            pick_catalog(Some("not json"), Some("2.1.0")).catalog_ver,
            Catalog::builtin().catalog_ver
        );
        assert_eq!(
            pick_catalog(None, None).catalog_ver,
            Catalog::builtin().catalog_ver
        );
    }

    // ---- 按键 ----

    #[test]
    fn key_table() {
        assert_eq!(key_bytes("esc", false), Some(vec![0x1b]));
        assert_eq!(key_bytes("enter", false), Some(vec![b'\r']));
        assert_eq!(key_bytes("tab", false), Some(vec![b'\t']));
        assert_eq!(key_bytes("shift+tab", false), Some(b"\x1b[Z".to_vec()));
        assert_eq!(key_bytes("backspace", false), Some(vec![0x7f]));
        assert_eq!(key_bytes("up", false), Some(b"\x1b[A".to_vec()));
        assert_eq!(key_bytes("up", true), Some(b"\x1bOA".to_vec()));
        assert_eq!(key_bytes("left", true), Some(b"\x1bOD".to_vec()));
        assert_eq!(key_bytes("ctrl+o", false), Some(vec![0x0f]));
        assert_eq!(key_bytes("ctrl+c", false), Some(vec![0x03]));
        assert_eq!(key_bytes("alt+p", false), Some(b"\x1bp".to_vec()));
        for bad in [
            "", "ctrl+", "ctrl+O", "alt+1", "ctrl+ab", "f1", "meta+x", "Esc",
        ] {
            assert_eq!(key_bytes(bad, false), None, "{bad}");
        }
    }

    // ---- 模板 ----

    fn cat() -> Catalog {
        Catalog::builtin()
    }

    #[test]
    fn fill_template_rules() {
        let c = cat();
        let model = c.action("model.set").expect("model.set");
        let args = |k: &str, v: &str| HashMap::from([(k.to_string(), v.to_string())]);
        // 正常
        assert_eq!(
            fill_template("/model {model}", model, &args("model", "opus"), &c, false),
            Ok("/model opus".into())
        );
        // 允许自定义，格式合法
        assert_eq!(
            fill_template(
                "/model {model}",
                model,
                &args("model", "claude-opus-4-1-20250805"),
                &c,
                false
            ),
            Ok("/model claude-opus-4-1-20250805".into())
        );
        // 含空格或分号被拒绝
        for bad in [
            "opus; rm -rf /",
            "a b",
            "opus\n/clear",
            "a&b",
            "$(x)",
            "`x`",
        ] {
            assert!(
                matches!(
                    fill_template("/model {model}", model, &args("model", bad), &c, false),
                    Err(ActionError::BadRequest(_))
                ),
                "{bad}"
            );
        }
        // 缺必填
        assert!(matches!(
            fill_template("/model {model}", model, &HashMap::new(), &c, false),
            Err(ActionError::BadRequest(_))
        ));
        // 不允许自定义的枚举：值不在表里被拒绝
        let eff = c.action("effort.set").expect("effort.set");
        assert!(fill_template("/effort {level}", eff, &args("level", "high"), &c, false).is_ok());
        assert!(matches!(
            fill_template("/effort {level}", eff, &args("level", "ultra"), &c, false),
            Err(ActionError::BadRequest(_))
        ));
        // 文本：换行和控制字符被去掉；可选参数为空时没有多余空格
        let compact = c.action("session.compact").expect("compact");
        assert_eq!(
            fill_template(
                "/compact {instructions}",
                compact,
                &HashMap::new(),
                &c,
                false
            ),
            Ok("/compact".into())
        );
        assert_eq!(
            fill_template(
                "/compact {instructions}",
                compact,
                &args("instructions", "保留\n接口\x07说明"),
                &c,
                false
            ),
            Ok("/compact 保留接口说明".into())
        );
        let long = "字".repeat(3000);
        let out = fill_template(
            "/compact {instructions}",
            compact,
            &args("instructions", &long),
            &c,
            false,
        )
        .expect("ok");
        assert_eq!(
            out.chars().count(),
            "/compact ".len() + TEXT_PARAM_MAX_CHARS
        );
        // 路径：含空格加引号
        let cd = c.action("dir.cd").expect("dir.cd");
        assert_eq!(
            fill_template("/cd {path}", cd, &args("path", r"C:\My Dir\p"), &c, true),
            Ok(r#"/cd "C:\My Dir\p""#.into())
        );
        assert_eq!(
            fill_template("/cd {path}", cd, &args("path", "/tmp/x"), &c, false),
            Ok("/cd /tmp/x".into())
        );
        assert!(matches!(
            fill_template("/cd {path}", cd, &HashMap::new(), &c, false),
            Err(ActionError::BadRequest(_))
        ));
    }

    // ---- 执行器 ----

    struct Mock {
        writes: Mutex<Vec<Vec<u8>>>,
        app: AppSnapshot,
        windows: bool,
        tag: String,
        modes: TermModes,
    }
    impl Mock {
        fn running() -> Mock {
            Mock {
                writes: Mutex::new(Vec::new()),
                app: AppSnapshot {
                    running: true,
                    stateful: false,
                    activity: String::new(),
                    pending_notice: None,
                    pending_truncated: false,
                },
                windows: false,
                tag: "unix".into(),
                modes: TermModes {
                    bracketed_paste: true,
                    ..Default::default()
                },
            }
        }
        fn all(&self) -> Vec<u8> {
            self.writes.lock().map(|w| w.concat()).unwrap_or_default()
        }
    }
    impl ActionTarget for Mock {
        async fn write(&self, data: Vec<u8>) -> Result<(), ActionError> {
            if let Ok(mut w) = self.writes.lock() {
                w.push(data);
            }
            Ok(())
        }
        fn modes(&self) -> TermModes {
            self.modes.clone()
        }
        fn app(&self) -> AppSnapshot {
            self.app.clone()
        }
        async fn wait_quiet(&self, _q: Duration, _t: Duration) {}
        fn output_mark(&self) -> u64 {
            0
        }
        fn output_since(&self, _from: u64) -> Vec<u8> {
            Vec::new()
        }
        fn adapter_rule(&self) -> AdapterRule {
            let mut r = adapter::AdapterRules::builtin().select(&adapter::MatchCtx {
                profile: "CLAUDE",
                claude_version: None,
            });
            r.submit_delay_ms = 1;
            r
        }
        fn windows(&self) -> bool {
            self.windows
        }
        fn platform_tag(&self) -> String {
            self.tag.clone()
        }
    }

    fn a(k: &str, v: &str) -> HashMap<String, String> {
        HashMap::from([(k.to_string(), v.to_string())])
    }

    #[tokio::test]
    async fn run_submit_action() {
        let c = cat();
        let t = Mock::running();
        let r = run_action(&c, &t, "model.set", &a("model", "opus"))
            .await
            .expect("ok");
        assert_eq!(r, ActionOutcome::default());
        assert_eq!(t.all(), b"\x1b[200~/model opus\x1b[201~\r");
    }

    #[tokio::test]
    async fn run_keys_and_platform_override() {
        let c = cat();
        let mut t = Mock::running();
        run_action(&c, &t, "mode.cycle", &HashMap::new())
            .await
            .expect("ok");
        assert_eq!(t.all(), b"\x1b[Z");
        t.writes = Mutex::new(Vec::new());
        t.tag = "windows_no_vt".into();
        run_action(&c, &t, "mode.cycle", &HashMap::new())
            .await
            .expect("ok");
        assert_eq!(t.all(), b"\x1bm");
        // 应用光标模式不影响这些键；ctrl+o
        t.writes = Mutex::new(Vec::new());
        run_action(&c, &t, "verbose.toggle", &HashMap::new())
            .await
            .expect("ok");
        assert_eq!(t.all(), vec![0x0f]);
    }

    #[tokio::test]
    async fn interactive_returns_passthrough() {
        let c = cat();
        let t = Mock::running();
        let r = run_action(&c, &t, "session.resume", &HashMap::new())
            .await
            .expect("ok");
        assert!(r.passthrough);
        assert_eq!(r.return_keys, vec!["enter", "esc"]);
        assert_eq!(t.all(), b"\x1b[200~/resume\x1b[201~\r");
    }

    #[tokio::test]
    async fn not_running_writes_nothing() {
        let c = cat();
        let mut t = Mock::running();
        t.app.running = false;
        assert_eq!(
            run_action(&c, &t, "interrupt", &HashMap::new()).await,
            Err(ActionError::AppNotRunning)
        );
        assert!(t.all().is_empty());
        let t = Mock::running();
        assert_eq!(
            run_action(&c, &t, "no.such", &HashMap::new()).await,
            Err(ActionError::Unsupported)
        );
    }

    #[tokio::test]
    async fn bad_params_write_nothing() {
        let c = cat();
        let t = Mock::running();
        let r = run_action(&c, &t, "model.set", &a("model", "x; rm -rf /")).await;
        assert!(matches!(r, Err(ActionError::BadRequest(_))));
        assert!(t.all().is_empty());
    }

    #[tokio::test]
    async fn enabled_when_checked_only_with_state() {
        let c = cat();
        let mut t = Mock::running();
        // 无状态：不检查，放行
        assert!(run_action(&c, &t, "interrupt", &HashMap::new())
            .await
            .is_ok());
        t.writes = Mutex::new(Vec::new());
        t.app = AppSnapshot {
            running: true,
            stateful: true,
            activity: "idle".into(),
            pending_notice: None,
            pending_truncated: false,
        };
        assert!(matches!(
            run_action(&c, &t, "interrupt", &HashMap::new()).await,
            Err(ActionError::BadRequest(_))
        ));
        assert!(t.all().is_empty());
        t.app.activity = "busy".into();
        assert!(run_action(&c, &t, "interrupt", &HashMap::new())
            .await
            .is_ok());
        assert_eq!(t.all(), vec![0x1b]);
    }

    #[tokio::test]
    async fn permission_buttons_check_notice_id() {
        let c = cat();
        let mut t = Mock::running();
        t.app = AppSnapshot {
            running: true,
            stateful: true,
            activity: "waiting_permission".into(),
            pending_notice: Some(7),
            pending_truncated: false,
        };
        // 错误的 notice_id：不发送任何按键
        assert!(matches!(
            run_action(&c, &t, "permission.allow", &a("notice_id", "6")).await,
            Err(ActionError::BadRequest(_))
        ));
        assert!(matches!(
            run_action(&c, &t, "permission.allow", &HashMap::new()).await,
            Err(ActionError::BadRequest(_))
        ));
        assert!(matches!(
            run_action(&c, &t, "permission.deny", &a("notice_id", "abc")).await,
            Err(ActionError::BadRequest(_))
        ));
        assert!(t.all().is_empty());
        run_action(&c, &t, "permission.allow", &a("notice_id", "7"))
            .await
            .expect("ok");
        assert_eq!(t.all(), b"\r");
        run_action(&c, &t, "permission.deny", &a("notice_id", "7"))
            .await
            .expect("ok");
        assert_eq!(t.all(), b"\r\x1b");
        // 请求已失效（Claude 已继续运行）
        t.writes = Mutex::new(Vec::new());
        t.app.activity = "busy".into();
        assert!(matches!(
            run_action(&c, &t, "permission.allow", &a("notice_id", "7")).await,
            Err(ActionError::BadRequest(_))
        ));
        assert!(t.all().is_empty());
        // 无状态回传时一律拒绝
        t.app = AppSnapshot {
            running: true,
            stateful: false,
            activity: String::new(),
            pending_notice: None,
            pending_truncated: false,
        };
        assert!(run_action(&c, &t, "permission.allow", &a("notice_id", "7"))
            .await
            .is_err());
    }

    /// 审查 M6：摘要被截断（命令太长，远端看不全）时，不能从远端点"允许"，只能拒绝。
    #[tokio::test]
    async fn m6_truncated_permission_cannot_be_allowed_remotely() {
        let c = cat();
        let mut t = Mock::running();
        t.app = AppSnapshot {
            running: true,
            stateful: true,
            activity: "waiting_permission".into(),
            pending_notice: Some(7),
            pending_truncated: true,
        };
        let r = run_action(&c, &t, "permission.allow", &a("notice_id", "7")).await;
        match r {
            Err(ActionError::BadRequest(m)) => assert!(m.contains("内容过长"), "{m}"),
            other => panic!("应返回 BAD_REQUEST，得到 {other:?}"),
        }
        assert!(t.all().is_empty(), "一个按键都不能发");
        // 拒绝照常可用
        run_action(&c, &t, "permission.deny", &a("notice_id", "7"))
            .await
            .expect("deny ok");
        assert_eq!(t.all(), b"\x1b");
        // 没截断时允许照常
        let mut t2 = Mock::running();
        t2.app = AppSnapshot {
            running: true,
            stateful: true,
            activity: "waiting_permission".into(),
            pending_notice: Some(7),
            pending_truncated: false,
        };
        run_action(&c, &t2, "permission.allow", &a("notice_id", "7"))
            .await
            .expect("allow ok");
        assert_eq!(t2.all(), b"\r");
    }

    #[tokio::test]
    async fn type_step_writes_plain_chunks_without_enter() {
        let json = base(
            r#"{"id":"t.type","title":"t","kind":"submit","params":[{"name":"p","type":"text"}],"steps":[{"type":"/x {p}"},{"wait_ms":1},{"keys":["enter"]}]}"#,
        );
        let c = Catalog::from_json(&json).expect("valid");
        let t = Mock::running();
        run_action(&c, &t, "t.type", &a("p", "hello"))
            .await
            .expect("ok");
        assert_eq!(t.all(), b"/x hello\r");
        assert!(!t.all().windows(4).any(|w| w == b"\x1b[20"));
    }

    // ---- 启动参数 ----

    fn lo(model: &str, mode: &str, effort: &str, resume: &str, name: &str) -> pb::LaunchOptions {
        pb::LaunchOptions {
            model: model.into(),
            permission_mode: mode.into(),
            effort: effort.into(),
            resume: resume.into(),
            session_name: name.into(),
        }
    }

    #[test]
    fn launch_command_basic() {
        let cmd = build_claude_command(
            QuoteStyle::Posix,
            &lo("sonnet", "plan", "high", "continue", "我的 任务"),
            None,
        )
        .expect("ok");
        assert_eq!(cmd, "claude --model 'sonnet' --permission-mode plan --effort high --continue --name '我的 任务'");
        let cmd =
            build_claude_command(QuoteStyle::Posix, &lo("", "", "", "pick", ""), None).expect("ok");
        assert_eq!(cmd, "claude --resume");
        assert_eq!(
            build_claude_command(QuoteStyle::Cmd, &lo("", "", "", "", ""), None).expect("ok"),
            "claude"
        );
    }

    #[test]
    fn launch_command_rejects_unsafe() {
        for style in [QuoteStyle::PowerShell, QuoteStyle::Posix, QuoteStyle::Cmd] {
            assert!(build_claude_command(style, &lo("opus;calc", "", "", "", ""), None).is_err());
            assert!(
                build_claude_command(style, &lo("", "bypassPermissions", "", "", ""), None)
                    .is_err()
            );
            assert!(build_claude_command(style, &lo("", "dontAsk", "", "", ""), None).is_err());
            assert!(build_claude_command(style, &lo("", "", "ultra", "", ""), None).is_err());
            assert!(build_claude_command(style, &lo("", "", "", "weird", ""), None).is_err());
            assert!(build_claude_command(style, &lo("a b", "", "", "", ""), None).is_err());
        }
        assert!(build_claude_command(QuoteStyle::Cmd, &lo("", "", "", "", "a\"b"), None).is_err());
        assert!(build_claude_command(QuoteStyle::Cmd, &lo("", "", "", "", "100%"), None).is_err());
        // 会话名里的换行和控制字符被清掉，不报错
        assert_eq!(
            build_claude_command(QuoteStyle::Posix, &lo("", "", "", "", "a\nb"), None).as_deref(),
            Ok("claude --name 'ab'")
        );
    }

    #[test]
    fn quoting_styles() {
        assert_eq!(
            quote(QuoteStyle::PowerShell, "it's").as_deref(),
            Ok("'it''s'")
        );
        assert_eq!(
            quote(QuoteStyle::PowerShell, "it\u{2019}s").as_deref(),
            Ok("'it''s'")
        );
        assert_eq!(
            quote(QuoteStyle::Posix, "it's").as_deref(),
            Ok(r"'it'\''s'")
        );
        assert_eq!(
            quote(QuoteStyle::Cmd, "my dir").as_deref(),
            Ok("\"my dir\"")
        );
        assert!(quote(QuoteStyle::Cmd, "a\"b").is_err());
    }

    #[test]
    fn launch_command_with_bridge() {
        let b = BridgeArgs {
            plugin_dir: "/home/u/my dir/plugin".into(),
            settings_file: Some("/home/u/my dir/s.json".into()),
        };
        let cmd =
            build_claude_command(QuoteStyle::Posix, &lo("", "", "", "", ""), Some(&b)).expect("ok");
        assert_eq!(
            cmd,
            "claude --plugin-dir '/home/u/my dir/plugin' --settings '/home/u/my dir/s.json'"
        );
        let b2 = BridgeArgs {
            plugin_dir: "C:/Users/100%/p".into(),
            settings_file: None,
        };
        // cmd 下含百分号：不附加参数，命令仍然有效
        let cmd =
            build_claude_command(QuoteStyle::Cmd, &lo("", "", "", "", ""), Some(&b2)).expect("ok");
        assert_eq!(cmd, "claude");
        let b3 = BridgeArgs {
            plugin_dir: r"C:\Users\用户 名\plugin".into(),
            settings_file: None,
        };
        let cmd = build_claude_command(
            QuoteStyle::PowerShell,
            &lo("opus", "", "", "", ""),
            Some(&b3),
        )
        .expect("ok");
        assert_eq!(
            cmd,
            r"claude --model 'opus' --plugin-dir 'C:\Users\用户 名\plugin'"
        );
    }
    // ---- 审查 H1：下发目录的语义校验 ----

    fn one_step(step: &str) -> Result<Catalog, CatalogError> {
        Catalog::from_json(&base(&format!(
            r#"{{"id":"a.b","title":"t","kind":"submit","steps":[{step}]}}"#
        )))
    }

    #[test]
    fn h1_catalog_rejects_dangerous_templates() {
        assert!(one_step(r#"{"submit":"/clear"}"#).is_ok());
        assert!(one_step(r#"{"type":"/clear"}"#).is_ok());
        // Claude Code 里以 ! 开头的输入会直接执行 shell 命令
        assert!(one_step(r#"{"submit":"!id"}"#).is_err());
        assert!(one_step(r#"{"submit":"  !id"}"#).is_err());
        assert!(one_step(r#"{"type":"!id"}"#).is_err());
        // 提交模板必须是斜杠命令
        assert!(one_step(r#"{"submit":"hello"}"#).is_err());
        assert!(one_step(r#"{"submit":"{x}"}"#).is_err());
        // 任何控制字符（ESC、CR、LF、TAB、DEL、C1）一律拒绝
        for bad in [
            r"/x\u001b[201~calc",
            r"/x\u001b",
            r"/x\nrm",
            r"/x\rrm",
            r"/x\ty",
            r"/x\u007fy",
            r"/x\u009by",
        ] {
            assert!(
                one_step(&format!(r#"{{"submit":"{bad}"}}"#)).is_err(),
                "{bad} 应被拒绝"
            );
            assert!(
                one_step(&format!(r#"{{"type":"{bad}"}}"#)).is_err(),
                "type {bad} 应被拒绝"
            );
        }
        // 长度上限
        let long = format!("/{}", "a".repeat(MAX_TEMPLATE_CHARS));
        assert!(one_step(&format!(r#"{{"submit":"{long}"}}"#)).is_err());
        const { assert!(MAX_TEMPLATE_CHARS <= 200) };
    }

    #[test]
    fn h1_catalog_rejects_dangerous_keys() {
        let keys = |k: &str| {
            Catalog::from_json(&base(&format!(
                r#"{{"id":"a.b","title":"t","kind":"keys","steps":[{{"keys":["{k}"]}}]}}"#
            )))
        };
        assert!(keys("ctrl+o").is_ok());
        assert!(keys("esc").is_ok());
        assert!(keys("ctrl+c").is_ok());
        // 会结束或挂起终端里程序的组合键
        assert!(keys("ctrl+d").is_err());
        assert!(keys("ctrl+z").is_err());
    }

    #[test]
    fn h1_permission_actions_are_pinned() {
        let perm = |id: &str, step: &str, extra: &str| {
            Catalog::from_json(&base(&format!(
                r#"{{"id":"{id}","title":"t","kind":"keys","hidden":true,
                   "params":[{{"name":"notice_id","type":"text","required":true}}],
                   "steps":[{step}]{extra}}}"#
            )))
        };
        assert!(perm("permission.allow", r#"{"keys":["enter"]}"#, "").is_ok());
        assert!(perm("permission.deny", r#"{"keys":["esc"]}"#, "").is_ok());
        // 步骤被换成别的按键 / 文本 / 多余步骤
        assert!(perm("permission.allow", r#"{"keys":["ctrl+c"]}"#, "").is_err());
        assert!(perm("permission.allow", r#"{"keys":["esc"]}"#, "").is_err());
        assert!(perm("permission.deny", r#"{"keys":["enter"]}"#, "").is_err());
        assert!(perm("permission.allow", r#"{"submit":"/clear"}"#, "").is_err());
        assert!(perm("permission.allow", r#"{"keys":["enter","enter"]}"#, "").is_err());
        assert!(perm(
            "permission.allow",
            r#"{"keys":["enter"]}"#,
            r#","platform_overrides":{"unix":{"steps":[{"keys":["ctrl+c"]}]}}"#
        )
        .is_err());
        // 不隐藏就会出现在主控端菜单里
        assert!(Catalog::from_json(&base(
            r#"{"id":"permission.allow","title":"t","kind":"keys","steps":[{"keys":["enter"]}]}"#
        ))
        .is_err());
    }

    #[test]
    fn h1_option_values_are_tokens_and_text_has_no_controls() {
        // 选项值会被替换进模板，必须是单个 token
        for bad in [r"a\nb", "a b", r"!id", r"a\u001bb", ""] {
            let j = format!(
                r#"{{"catalog_ver":"1","app":"claude","options":{{"m":["{bad}"]}},"actions":[
                   {{"id":"a.b","title":"t","kind":"keys","steps":[{{"keys":["esc"]}}]}}]}}"#
            );
            assert!(Catalog::from_json(&j).is_err(), "选项值 {bad:?} 应被拒绝");
        }
        // 面向主控端显示的文字里也不允许控制字符
        for field in ["title", "group", "confirm", "note"] {
            let a = format!(
                r#"{{"id":"a.b","title":"t","kind":"keys","steps":[{{"keys":["esc"]}},],"{field}":"x\u001b[2Jy"}}"#
            )
            .replace("},],", "}],");
            assert!(
                Catalog::from_json(&base(&a)).is_err(),
                "{field} 含 ESC 应被拒绝"
            );
        }
    }

    #[test]
    fn h1_custom_pattern_cannot_smuggle_newlines() {
        let cat = Catalog::from_json(&base(
            r#"{"id":"a.b","title":"t","kind":"submit",
                "params":[{"name":"m","type":"enum","allow_custom":true,"pattern":".*","required":true}],
                "steps":[{"submit":"/model {m}"}]}"#,
        ))
        .expect("pattern 合法");
        let p = &cat.actions[0].params[0];
        assert!(clean_param(p, "opus", &cat, false).is_ok());
        for bad in ["x\n!id", "x\r!id", "x\u{1b}[201~y"] {
            assert!(
                clean_param(p, bad, &cat, false).is_err(),
                "{bad:?} 应被拒绝"
            );
        }
    }

    #[test]
    fn token_pattern_must_start_with_alnum() {
        let re = Regex::new(DEFAULT_TOKEN_PATTERN).expect("regex");
        assert!(re.is_match("opus[1m]"));
        assert!(re.is_match("claude-3.5:x/y"));
        assert!(!re.is_match("--help"));
        assert!(!re.is_match("-x"));
        assert!(check_token("--help").is_err());
    }

    #[test]
    fn fill_template_is_single_pass() {
        let cat = Catalog::from_json(&base(
            r#"{"id":"a.b","title":"t","kind":"submit",
                "params":[{"name":"a","type":"text"},{"name":"b","type":"text"}],
                "steps":[{"submit":"/x {a} {b}"}]}"#,
        ))
        .expect("ok");
        let act = &cat.actions[0];
        let mut args = HashMap::new();
        args.insert("a".to_string(), "{b}".to_string());
        args.insert("b".to_string(), "Z".to_string());
        // 第一个参数的值里的 {b} 不应再被替换
        assert_eq!(
            fill_template("/x {a} {b}", act, &args, &cat, false).as_deref(),
            Ok("/x {b} Z")
        );
    }
}
