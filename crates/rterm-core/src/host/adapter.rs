//! 输入适配器：把一条 `TermSubmit` 变成写入 PTY 的字节（《实现方案.md》5.5.4，《开发指南.md》T16）。
//!
//! 规则驱动：内置默认规则，也可以用 `/config` 下发的 JSON 整体替换（`AdapterRules::from_json`）。
//! 本模块全是纯函数，不碰 PTY；片段之间的等待、回车前的等待由调用方（term.rs 的执行队列）完成。
use std::time::Duration;

use serde::Deserialize;

use crate::events::TermModes;

/// 每次写入 PTY 的最大字节数。一次写太多，Windows 上可能丢输入。
pub const WRITE_CHUNK: usize = 2048;
/// 附件占位符。
pub const PLACEHOLDER: char = '\u{FFFC}';

/// 规则里会原样写进 PTY 的三个字符串（`newline_in_paste`、`submit_key`、`fallback_newline`）只允许这几种取值：
/// CR、LF、CRLF、反斜杠加 CR（Claude Code 的续行写法）。
/// 下发的规则是"数据"，任何别的取值（如 `"\r;id>x;\r"`、`"\u{1b}[20"`）都等于在被控端注入输入（安全审查 H1）。
pub const NEWLINE_WHITELIST: [&str; 4] = ["\r", "\n", "\r\n", "\\\r"];
/// 规则里所有毫秒数的上限。
pub const MAX_RULE_MS: u64 = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PasteMode {
    /// 总是用 bracketed paste 包裹
    Bracketed,
    /// 从不包裹
    Raw,
    /// 远端程序开启了 `?2004` 才包裹
    #[default]
    Auto,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RuleMatch {
    /// `SHELL` / `CLAUDE` / `CUSTOM`；缺省匹配任意
    pub profile: Option<String>,
    /// Claude Code 版本范围（semver 写法，如 `>=2.1.0`）；缺省匹配任意
    pub version: Option<String>,
}

fn d_newline() -> String {
    "\r".into()
}
fn d_delay() -> u64 {
    30
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AdapterRule {
    pub id: String,
    #[serde(rename = "match")]
    pub matcher: RuleMatch,
    pub paste: PasteMode,
    /// bracketed paste 内部的换行写法
    pub newline_in_paste: String,
    pub submit_delay_ms: u64,
    pub submit_key: String,
    /// bracketed paste 不可用时，多行消息的换行方式
    pub fallback_newline: String,
    /// 远端进入备用屏幕时，建议主控端自动进入直通。主控端据此读取，被控端本身不强制。
    pub auto_passthrough_on_alt_screen: bool,
    /// 附件路径单独作为一次粘贴写入（实测：Claude Code 只在"整个粘贴就是图片路径"时才把它变成
    /// `[Image #n]`；路径夹在一大段文字里的粘贴不会被识别）。仅在使用 bracketed paste 时生效。
    pub attach_separate: bool,
    /// 单独粘贴路径之后等多久再写后面的内容（实测：0ms 时图片标记会被异步追加到末尾、顺序错乱，100ms 正常）
    pub attach_gap_ms: u64,
}

impl Default for AdapterRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            matcher: RuleMatch::default(),
            paste: PasteMode::Auto,
            newline_in_paste: d_newline(),
            submit_delay_ms: d_delay(),
            submit_key: "\r".into(),
            fallback_newline: "\r".into(),
            auto_passthrough_on_alt_screen: false,
            attach_separate: false,
            attach_gap_ms: 150,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdapterRules {
    pub adapters: Vec<AdapterRule>,
}

/// 选规则时用的上下文。
#[derive(Debug, Clone, Copy, Default)]
pub struct MatchCtx<'a> {
    /// `SHELL` / `CLAUDE` / `CUSTOM`
    pub profile: &'a str,
    pub claude_version: Option<&'a str>,
}

#[derive(Debug, thiserror::Error)]
pub enum RulesError {
    #[error("规则 JSON 解析失败：{0}")]
    Json(String),
    #[error("规则无效：{0}")]
    Invalid(String),
}

impl AdapterRules {
    /// 内置默认规则。数值以 `docs/M0-验证结论.md` 的实测为准。
    pub fn builtin() -> Self {
        Self {
            adapters: vec![
                AdapterRule {
                    id: "claude-code".into(),
                    matcher: RuleMatch {
                        profile: Some("CLAUDE".into()),
                        version: None,
                    },
                    paste: PasteMode::Bracketed,
                    // 实测：粘贴内部用 CR 会被 Claude Code 当成回车而提前提交，LF 才是输入框里的换行
                    newline_in_paste: "\n".into(),
                    submit_delay_ms: 80,
                    submit_key: "\r".into(),
                    fallback_newline: "\\\r".into(),
                    auto_passthrough_on_alt_screen: false,
                    attach_separate: true,
                    attach_gap_ms: 150,
                },
                AdapterRule {
                    id: "generic".into(),
                    matcher: RuleMatch::default(),
                    paste: PasteMode::Auto,
                    newline_in_paste: "\r".into(),
                    submit_delay_ms: 30,
                    submit_key: "\r".into(),
                    fallback_newline: "\r".into(),
                    auto_passthrough_on_alt_screen: true,
                    attach_separate: false,
                    attach_gap_ms: 150,
                },
            ],
        }
    }

    /// 解析并校验下发的规则。校验不通过返回错误（调用方继续使用旧规则）。
    pub fn from_json(json: &str) -> Result<Self, RulesError> {
        let rules: AdapterRules =
            serde_json::from_str(json).map_err(|e| RulesError::Json(e.to_string()))?;
        rules.validate()?;
        Ok(rules)
    }

    pub fn validate(&self) -> Result<(), RulesError> {
        if self.adapters.is_empty() || self.adapters.len() > 32 {
            return Err(RulesError::Invalid("规则数量应在 1 到 32 之间".into()));
        }
        for r in &self.adapters {
            if r.id.is_empty() || r.id.chars().count() > 64 || r.id.chars().any(char::is_control) {
                return Err(RulesError::Invalid("规则 id 为空、过长或含控制字符".into()));
            }
            for (name, ms) in [
                ("submit_delay_ms", r.submit_delay_ms),
                ("attach_gap_ms", r.attach_gap_ms),
            ] {
                if ms > MAX_RULE_MS {
                    return Err(RulesError::Invalid(format!(
                        "{}：{name} 超过 {MAX_RULE_MS}",
                        r.id
                    )));
                }
            }
            for (name, v) in [
                ("newline_in_paste", &r.newline_in_paste),
                ("submit_key", &r.submit_key),
                ("fallback_newline", &r.fallback_newline),
            ] {
                // 这些字符串会原样写进 PTY：只接受白名单取值，不做"过滤危险序列"式的黑名单
                if !NEWLINE_WHITELIST.contains(&v.as_str()) {
                    return Err(RulesError::Invalid(format!(
                        "{}：{name} 只允许 CR、LF、CRLF、反斜杠加 CR",
                        r.id
                    )));
                }
            }
            if let Some(profile) = &r.matcher.profile {
                if !["SHELL", "CLAUDE", "CUSTOM"].contains(&profile.as_str()) {
                    return Err(RulesError::Invalid(format!(
                        "{}：未知 profile {profile}",
                        r.id
                    )));
                }
            }
            if let Some(v) = &r.matcher.version {
                semver::VersionReq::parse(v)
                    .map_err(|e| RulesError::Invalid(format!("{}：version 无效：{e}", r.id)))?;
            }
        }
        Ok(())
    }

    /// 取第一条匹配的规则；没有匹配的退回内置的通用规则。
    pub fn select(&self, ctx: &MatchCtx<'_>) -> AdapterRule {
        for r in &self.adapters {
            if r.matcher
                .profile
                .as_deref()
                .is_some_and(|p| p != ctx.profile)
            {
                continue;
            }
            if let Some(req) = &r.matcher.version {
                let Ok(req) = semver::VersionReq::parse(req) else {
                    continue;
                };
                let Some(v) = ctx
                    .claude_version
                    .and_then(|v| semver::Version::parse(v).ok())
                else {
                    continue;
                };
                if !req.matches(&v) {
                    continue;
                }
            }
            return r.clone();
        }
        AdapterRules::builtin().adapters.pop().unwrap_or_default()
    }
}

/// 写入计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitPlan {
    /// 依次写入的片段，每片不超过 2KB 且是完整的 UTF-8
    pub chunks: Vec<Vec<u8>>,
    /// 与 `chunks` 等长：写完对应片段之后额外等待的时间（附件路径单独粘贴后要等 Claude Code 异步识别）
    pub pauses: Vec<Duration>,
    /// 最后一个片段之后、回车之前的等待
    pub delay_before_enter: Duration,
    /// 回车（`press_enter` 为假时为 None）
    pub enter: Option<Vec<u8>>,
}

/// 清洗：去掉粘贴结束序列和除制表符、换行以外的控制字符；换行统一成 `\n`。
pub fn sanitize(s: &str) -> String {
    let mut t = s.replace("\r\n", "\n").replace('\r', "\n");
    // 反复去除，防止 `ESC[2` + `ESC[201~` + `01~` 这样的拼接再次生成序列
    loop {
        let before = t.len();
        t = t.replace("\x1b[201~", "").replace("\x1b[200~", "");
        if t.len() == before {
            break;
        }
    }
    t.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

/// 路径是否需要加引号。
fn needs_quote(path: &str, windows: bool) -> bool {
    let special: &str = if windows {
        " \t&()[]{}^=;!'+,`~%"
    } else {
        " \t&()[]{}^=;!'\"+,`~%$#*?<>|\\"
    };
    path.chars().any(|c| special.contains(c))
}

/// 附件路径的写法：Windows 用双引号，Unix 用单引号。
pub fn quote_path(path: &str, windows: bool) -> String {
    if !needs_quote(path, windows) {
        return path.to_string();
    }
    if windows {
        format!("\"{}\"", path.replace('"', ""))
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// 把第 n 个占位符换成第 n 个附件路径；多出来的路径用空格追加到末尾；多出来的占位符删掉。
pub fn fill_attachments(text: &str, paths: &[String], windows: bool) -> String {
    let quoted: Vec<String> = paths.iter().map(|p| quote_path(p, windows)).collect();
    let mut out = String::with_capacity(text.len() + 64);
    let mut idx = 0;
    for c in text.chars() {
        if c == PLACEHOLDER {
            if let Some(p) = quoted.get(idx) {
                out.push_str(p);
            }
            idx += 1;
        } else {
            out.push(c);
        }
    }
    for p in quoted.iter().skip(idx) {
        if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
            out.push(' ');
        }
        out.push_str(p);
    }
    out
}

/// 按字节上限切分，保证每片都是完整的 UTF-8。
pub fn split_utf8(bytes: &[u8], max: usize) -> Vec<Vec<u8>> {
    let max = max.max(4);
    let mut out = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        let mut end = (start + max).min(bytes.len());
        if end < bytes.len() {
            // 回退到字符边界：continuation byte 的高两位是 10
            while end > start && (bytes[end] & 0xC0) == 0x80 {
                end -= 1;
            }
            if end == start {
                end = (start + max).min(bytes.len());
            }
        }
        out.push(bytes[start..end].to_vec());
        start = end;
    }
    out
}

/// 构造写入计划。`windows` 决定附件路径的引号写法（取被控端所在平台）。
pub fn build_submit(
    rule: &AdapterRule,
    modes: &TermModes,
    text: &str,
    paths: &[String],
    press_enter: bool,
    windows: bool,
) -> SubmitPlan {
    let text = sanitize(text);
    let use_bracketed = match rule.paste {
        PasteMode::Bracketed => true,
        PasteMode::Raw => false,
        PasteMode::Auto => modes.bracketed_paste,
    };
    if rule.attach_separate && use_bracketed && !paths.is_empty() {
        return build_segmented(rule, &text, paths, press_enter, windows);
    }
    let text = fill_attachments(&text, paths, windows);
    let body = if text.is_empty() {
        String::new()
    } else if use_bracketed {
        format!(
            "\x1b[200~{}\x1b[201~",
            text.replace('\n', &rule.newline_in_paste)
        )
    } else if text.contains('\n') {
        text.replace('\n', &rule.fallback_newline)
    } else {
        text
    };
    let chunks = split_utf8(body.as_bytes(), WRITE_CHUNK);
    SubmitPlan {
        pauses: vec![Duration::ZERO; chunks.len()],
        chunks,
        delay_before_enter: Duration::from_millis(rule.submit_delay_ms),
        enter: press_enter.then(|| rule.submit_key.clone().into_bytes()),
    }
}

fn bracket(text: &str, newline: &str) -> String {
    format!("\x1b[200~{}\x1b[201~", text.replace('\n', newline))
}

/// 附件路径各自单独粘贴：文字段、路径段交替，每个路径段后面等 `attach_gap_ms`。
fn build_segmented(
    rule: &AdapterRule,
    text: &str,
    paths: &[String],
    press_enter: bool,
    windows: bool,
) -> SubmitPlan {
    // (内容, 是不是路径)
    let mut segs: Vec<(String, bool)> = Vec::new();
    let mut cur = String::new();
    let mut idx = 0;
    for c in text.chars() {
        if c == PLACEHOLDER {
            if !cur.is_empty() {
                segs.push((std::mem::take(&mut cur), false));
            }
            if let Some(p) = paths.get(idx) {
                segs.push((quote_path(p, windows), true));
            }
            idx += 1;
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        segs.push((cur, false));
    }
    // 没有对应占位符的附件追加到末尾，合并成一次粘贴（空格分隔）
    let extras: Vec<String> = paths
        .iter()
        .skip(idx)
        .map(|p| quote_path(p, windows))
        .collect();
    if !extras.is_empty() {
        if let Some((last, false)) = segs.last_mut() {
            if !last.ends_with(char::is_whitespace) {
                last.push(' ');
            }
        }
        segs.push((extras.join(" "), true));
    }
    // 相邻的路径合并成一次粘贴，用空格分隔（实测两个路径一次粘贴会得到两个图片标记）
    let mut merged: Vec<(String, bool)> = Vec::new();
    for (s, is_path) in segs {
        match merged.last_mut() {
            Some((prev, true)) if is_path => {
                prev.push(' ');
                prev.push_str(&s);
            }
            _ => merged.push((s, is_path)),
        }
    }
    let gap = Duration::from_millis(rule.attach_gap_ms);
    let mut chunks = Vec::new();
    let mut pauses = Vec::new();
    for (s, is_path) in &merged {
        let parts = split_utf8(bracket(s, &rule.newline_in_paste).as_bytes(), WRITE_CHUNK);
        let n = parts.len();
        for (i, p) in parts.into_iter().enumerate() {
            chunks.push(p);
            pauses.push(if i + 1 == n && *is_path {
                gap
            } else {
                Duration::ZERO
            });
        }
    }
    SubmitPlan {
        chunks,
        pauses,
        delay_before_enter: Duration::from_millis(rule.submit_delay_ms),
        enter: press_enter.then(|| rule.submit_key.clone().into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> AdapterRule {
        AdapterRules::builtin().select(&MatchCtx {
            profile: "CLAUDE",
            claude_version: None,
        })
    }
    fn generic() -> AdapterRule {
        AdapterRules::builtin().select(&MatchCtx {
            profile: "SHELL",
            claude_version: None,
        })
    }
    fn joined(p: &SubmitPlan) -> Vec<u8> {
        p.chunks.concat()
    }

    #[test]
    fn single_line_bracketed() {
        let m = TermModes {
            bracketed_paste: true,
            ..Default::default()
        };
        let p = build_submit(&generic(), &m, "hello", &[], true, false);
        assert_eq!(joined(&p), b"\x1b[200~hello\x1b[201~");
        assert_eq!(p.enter.as_deref(), Some(&b"\r"[..]));
        assert_eq!(p.delay_before_enter, Duration::from_millis(30));
    }

    #[test]
    fn multi_line_bracketed_newline_per_rule() {
        let m = TermModes::default();
        // Claude Code 规则：粘贴内部的换行用 LF
        let p = build_submit(&claude(), &m, "a\nb\r\nc", &[], true, false);
        assert_eq!(joined(&p), b"\x1b[200~a\nb\nc\x1b[201~");
        assert_eq!(p.delay_before_enter, Duration::from_millis(80));
        // 通用规则（远端开启粘贴模式时）沿用 CR
        let m = TermModes {
            bracketed_paste: true,
            ..Default::default()
        };
        let p = build_submit(&generic(), &m, "a\nb", &[], true, false);
        assert_eq!(joined(&p), b"\x1b[200~a\rb\x1b[201~");
    }

    #[test]
    fn auto_without_bracketed_plain() {
        let m = TermModes::default();
        let p = build_submit(&generic(), &m, "ls -l", &[], true, false);
        assert_eq!(joined(&p), b"ls -l");
        let p = build_submit(&generic(), &m, "a\nb", &[], true, false);
        assert_eq!(joined(&p), b"a\rb");
    }

    #[test]
    fn raw_multiline_uses_fallback_newline() {
        let mut r = claude();
        r.paste = PasteMode::Raw;
        let p = build_submit(&r, &TermModes::default(), "a\nb", &[], true, false);
        assert_eq!(joined(&p), b"a\\\rb");
    }

    #[test]
    fn strips_paste_end_and_controls() {
        let m = TermModes {
            bracketed_paste: true,
            ..Default::default()
        };
        let p = build_submit(&generic(), &m, "x\x1b[201~y\x03z\x07", &[], false, false);
        assert_eq!(joined(&p), b"\x1b[200~xyz\x1b[201~");
        assert!(p.enter.is_none());
        // 拼接式构造也被清除
        assert_eq!(sanitize("a\x1b[2\x1b[201~01~b"), "ab");
        // C1 控制字符（0x9B 是 8 位 CSI）也去掉
        assert_eq!(sanitize("a\u{9b}31mb"), "a31mb");
        assert_eq!(sanitize("tab\there"), "tab\there");
    }

    #[test]
    fn chinese_5000_chars_split_valid_utf8() {
        let text: String = "汉".repeat(5000);
        let m = TermModes::default();
        let p = build_submit(&claude(), &m, &text, &[], true, false);
        assert!(p.chunks.len() > 1);
        for c in &p.chunks {
            assert!(c.len() <= WRITE_CHUNK);
            assert!(std::str::from_utf8(c).is_ok(), "切到了字符中间");
        }
        let all = String::from_utf8(joined(&p)).unwrap_or_default();
        assert_eq!(all, format!("\x1b[200~{text}\x1b[201~"));
    }

    #[test]
    fn emoji_boundaries() {
        let text = "😀".repeat(1000);
        for c in split_utf8(text.as_bytes(), 2047) {
            assert!(std::str::from_utf8(&c).is_ok());
        }
    }

    #[test]
    fn two_placeholders_two_paths() {
        let paths = vec!["/a/1.png".to_string(), "/a/2.png".to_string()];
        let s = fill_attachments("see \u{FFFC} and \u{FFFC}!", &paths, false);
        assert_eq!(s, "see /a/1.png and /a/2.png!");
    }

    #[test]
    fn extra_attachment_appended_and_extra_placeholder_dropped() {
        let paths = vec!["/a/1.png".to_string(), "/a/2.png".to_string()];
        assert_eq!(
            fill_attachments("look \u{FFFC}", &paths, false),
            "look /a/1.png /a/2.png"
        );
        assert_eq!(
            fill_attachments("a\u{FFFC}b\u{FFFC}c", &paths[..1], false),
            "a/a/1.pngbc"
        );
        assert_eq!(fill_attachments("", &paths, false), "/a/1.png /a/2.png");
    }

    #[test]
    fn claude_rule_pastes_each_attachment_separately() {
        let m = TermModes::default();
        let paths = vec![r"C:\a b\1.png".to_string(), r"C:\2.png".to_string()];
        let p = build_submit(
            &claude(),
            &m,
            "what is \u{FFFC} and \u{FFFC}!",
            &paths,
            true,
            true,
        );
        let segs: Vec<String> = p
            .chunks
            .iter()
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect();
        assert_eq!(
            segs,
            vec![
                "\x1b[200~what is \x1b[201~".to_string(),
                "\x1b[200~\"C:\\a b\\1.png\"\x1b[201~".to_string(),
                "\x1b[200~ and \x1b[201~".to_string(),
                "\x1b[200~C:\\2.png\x1b[201~".to_string(),
                "\x1b[200~!\x1b[201~".to_string(),
            ]
        );
        let gap = Duration::from_millis(150);
        assert_eq!(
            p.pauses,
            vec![Duration::ZERO, gap, Duration::ZERO, gap, Duration::ZERO]
        );
        assert_eq!(p.enter.as_deref(), Some(&b"\r"[..]));
    }

    #[test]
    fn attachments_without_placeholders_are_merged_into_one_paste() {
        let m = TermModes::default();
        let paths = vec!["/a/1.png".to_string(), "/a/2.png".to_string()];
        let p = build_submit(&claude(), &m, "look", &paths, true, false);
        let segs: Vec<String> = p
            .chunks
            .iter()
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect();
        assert_eq!(
            segs,
            vec![
                "\x1b[200~look \x1b[201~".to_string(),
                "\x1b[200~/a/1.png /a/2.png\x1b[201~".to_string()
            ]
        );
        // 两个相邻占位符也合并
        let p = build_submit(&claude(), &m, "\u{FFFC}\u{FFFC}", &paths, false, false);
        assert_eq!(p.chunks.len(), 1);
        assert_eq!(
            String::from_utf8_lossy(&p.chunks[0]),
            "\x1b[200~/a/1.png /a/2.png\x1b[201~"
        );
        assert!(p.enter.is_none());
        // 只有附件、没有文字
        let p = build_submit(&claude(), &m, "", &paths[..1], true, false);
        assert_eq!(p.chunks.len(), 1);
    }

    #[test]
    fn generic_rule_keeps_attachments_inline() {
        let m = TermModes {
            bracketed_paste: true,
            ..Default::default()
        };
        let paths = vec!["/a/1.png".to_string()];
        let p = build_submit(&generic(), &m, "see \u{FFFC}", &paths, true, false);
        assert_eq!(joined(&p), b"\x1b[200~see /a/1.png\x1b[201~");
        assert_eq!(p.pauses.len(), p.chunks.len());
    }

    #[test]
    fn path_quoting() {
        assert_eq!(quote_path(r"C:\Users\me\a.png", true), r"C:\Users\me\a.png");
        assert_eq!(
            quote_path(r"C:\Users\my name\a.png", true),
            r#""C:\Users\my name\a.png""#
        );
        assert_eq!(
            quote_path("/home/u/my pic.png", false),
            "'/home/u/my pic.png'"
        );
        assert_eq!(
            quote_path("/home/u/it's.png", false),
            r"'/home/u/it'\''s.png'"
        );
        // 中文路径无空格时不需要引号
        assert_eq!(quote_path("/home/用户/图.png", false), "/home/用户/图.png");
    }

    #[test]
    fn rules_json_roundtrip_and_validation() {
        let json = r#"{"adapters":[
            {"id":"claude-new","match":{"profile":"CLAUDE","version":">=2.1.0"},"paste":"bracketed","submit_delay_ms":150},
            {"id":"generic","match":{}}
        ]}"#;
        let rules = AdapterRules::from_json(json).expect("valid");
        let r = rules.select(&MatchCtx {
            profile: "CLAUDE",
            claude_version: Some("2.1.322"),
        });
        assert_eq!(r.id, "claude-new");
        assert_eq!(r.submit_delay_ms, 150);
        let r = rules.select(&MatchCtx {
            profile: "CLAUDE",
            claude_version: Some("2.0.9"),
        });
        assert_eq!(r.id, "generic");
        let r = rules.select(&MatchCtx {
            profile: "CLAUDE",
            claude_version: None,
        });
        assert_eq!(r.id, "generic");
        assert!(AdapterRules::from_json("{}").is_err());
        assert!(AdapterRules::from_json(r#"{"adapters":[]}"#).is_err());
        assert!(
            AdapterRules::from_json(r#"{"adapters":[{"id":"x","submit_delay_ms":99999}]}"#)
                .is_err()
        );
        assert!(
            AdapterRules::from_json(r#"{"adapters":[{"id":"x","match":{"version":"abc"}}]}"#)
                .is_err()
        );
        assert!(AdapterRules::from_json(r#"{"adapters":[{"id":"x","paste":"weird"}]}"#).is_err());
    }

    #[test]
    fn builtin_selection() {
        let rules = AdapterRules::builtin();
        assert_eq!(
            rules
                .select(&MatchCtx {
                    profile: "CLAUDE",
                    claude_version: None
                })
                .id,
            "claude-code"
        );
        assert_eq!(
            rules
                .select(&MatchCtx {
                    profile: "SHELL",
                    claude_version: None
                })
                .id,
            "generic"
        );
        assert!(rules.validate().is_ok());
    }
    // ---- 审查 H1：下发规则只允许白名单取值 ----

    fn rule_json(fields: &str) -> String {
        format!(r#"{{"adapters":[{{"id":"x","match":{{}},{fields}}}]}}"#)
    }

    #[test]
    fn h1_remote_rules_reject_report_exploits() {
        // 报告复现点 1：fallback_newline 夹带命令
        assert!(AdapterRules::from_json(&rule_json(
            r#""paste":"raw","fallback_newline":"\r;id>x;\r""#
        ))
        .is_err());
        // 报告复现点 2：用 ESC 重新拼出粘贴结束序列
        assert!(AdapterRules::from_json(&rule_json(r#""newline_in_paste":"\u001b[20""#)).is_err());
        assert!(AdapterRules::from_json(&rule_json(r#""submit_key":"\r;calc\r""#)).is_err());
        // 任何含控制字符的取值（ESC、NUL、DEL）都不行
        for bad in [
            r"\u001b", r"\u0000", r"\u007f", r"\u0003", "x", " ", r"\r\r", r"\n\n",
        ] {
            for field in ["newline_in_paste", "submit_key", "fallback_newline"] {
                assert!(
                    AdapterRules::from_json(&rule_json(&format!(r#""{field}":"{bad}""#))).is_err(),
                    "{field}={bad} 应被拒绝"
                );
            }
        }
        // 数值上限
        assert!(AdapterRules::from_json(&rule_json(r#""attach_gap_ms":99999"#)).is_err());
        // id 过长或含控制字符
        let long_id = "a".repeat(65);
        assert!(AdapterRules::from_json(&format!(
            r#"{{"adapters":[{{"id":"{long_id}","match":{{}}}}]}}"#
        ))
        .is_err());
        assert!(AdapterRules::from_json(r#"{"adapters":[{"id":"a\u001bb","match":{}}]}"#).is_err());
    }

    #[test]
    fn h1_whitelisted_values_are_accepted() {
        for v in [r"\r", r"\n", r"\r\n", r"\\\r"] {
            let j = rule_json(&format!(
                r#""newline_in_paste":"{v}","submit_key":"{v}","fallback_newline":"{v}""#
            ));
            assert!(AdapterRules::from_json(&j).is_ok(), "{v} 应通过");
        }
        // 内置规则本身必须通过校验
        assert!(AdapterRules::builtin().validate().is_ok());
    }
}
