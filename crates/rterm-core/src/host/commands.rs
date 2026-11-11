//! 自定义命令和技能扫描（《实现方案.md》18.9，《开发指南.md》T42）。
//!
//! 只读文件开头的元数据（最多 8KB），不读正文；单次扫描限时 2 秒、最多 500 项；
//! 同名时项目级覆盖用户级。插件提供的命令 v1 不扫描。
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rterm_proto::pb;

pub const MAX_ITEMS: usize = 500;
pub const SCAN_BUDGET: Duration = Duration::from_secs(2);
pub const MAX_META_BYTES: u64 = 8 * 1024;
pub const MAX_UP_LEVELS: usize = 10;

#[derive(Debug, Default, PartialEq, Eq)]
struct Meta {
    description: String,
    argument_hint: String,
    invocable: bool,
}

/// 解析文件开头 `---` 之间的 `键: 值` 行；解析不了的行跳过。
fn parse_meta(head: &str) -> Meta {
    let mut m = Meta {
        invocable: true,
        ..Default::default()
    };
    let mut lines = head.lines();
    if lines.next().map(str::trim) != Some("---") {
        return m;
    }
    for line in lines {
        let line = line.trim_end();
        if line.trim() == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        match k.trim() {
            "description" => m.description = v,
            "argument-hint" => m.argument_hint = v,
            "user-invocable" if v.eq_ignore_ascii_case("false") => m.invocable = false,
            _ => {}
        }
    }
    m
}

fn read_head(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut buf = Vec::new();
    f.take(MAX_META_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

struct Scan {
    start: Instant,
    items: HashMap<String, pb::CustomCommand>,
    order: Vec<String>,
}

impl Scan {
    fn out_of_budget(&self) -> bool {
        self.items.len() >= MAX_ITEMS || self.start.elapsed() > SCAN_BUDGET
    }

    fn add(&mut self, name: String, file: &Path, source: &str) {
        if self.out_of_budget() && !self.items.contains_key(&name) {
            return;
        }
        let Some(head) = read_head(file) else { return };
        let meta = parse_meta(&head);
        if !meta.invocable {
            // 同名的上层定义也要被屏蔽
            self.items.remove(&name);
            return;
        }
        if !self.items.contains_key(&name) {
            self.order.push(name.clone());
        }
        self.items.insert(
            name.clone(),
            pb::CustomCommand {
                name,
                description: meta.description,
                argument_hint: meta.argument_hint,
                source: source.into(),
            },
        );
    }

    /// `<root>/skills/<名称>/SKILL.md`
    fn scan_skills(&mut self, root: &Path, source: &str) {
        let Ok(rd) = std::fs::read_dir(root.join("skills")) else {
            return;
        };
        let mut dirs: Vec<_> = rd.flatten().collect();
        dirs.sort_by_key(|e| e.file_name());
        for e in dirs {
            if self.out_of_budget() {
                return;
            }
            let skill = e.path().join("SKILL.md");
            if skill.is_file() {
                self.add(e.file_name().to_string_lossy().into_owned(), &skill, source);
            }
        }
    }

    /// `<root>/commands/<名称>.md`，子目录用冒号连接
    fn scan_commands(&mut self, root: &Path, source: &str) {
        let base = root.join("commands");
        let mut stack: Vec<(PathBuf, String)> = vec![(base, String::new())];
        while let Some((dir, prefix)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries: Vec<_> = rd.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                if self.out_of_budget() {
                    return;
                }
                let p = e.path();
                let fname = e.file_name().to_string_lossy().into_owned();
                if p.is_dir() {
                    if stack.len() < 64 {
                        stack.push((p, format!("{prefix}{fname}:")));
                    }
                } else if let Some(stem) = fname.strip_suffix(".md") {
                    self.add(format!("{prefix}{stem}"), &p, source);
                }
            }
        }
    }
}

/// 项目目录链：从 `cwd` 向上，遇到含 `.git` 的目录就停，最多 10 层。
fn project_dirs(cwd: &Path, home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut cur = Some(cwd.to_path_buf());
    for _ in 0..=MAX_UP_LEVELS {
        let Some(d) = cur else { break };
        // 用户主目录的 .claude 已经按用户级扫描过，不再当项目级
        if d == home {
            break;
        }
        out.push(d.clone());
        if d.join(".git").exists() {
            break;
        }
        cur = d.parent().map(Path::to_path_buf);
    }
    out
}

/// 扫描。阻塞调用，应放进 `spawn_blocking`。
pub fn scan_commands(cwd: &Path, home: &Path) -> Vec<pb::CustomCommand> {
    let mut scan = Scan {
        start: Instant::now(),
        items: HashMap::new(),
        order: Vec::new(),
    };
    // 先用户级，再从仓库根到当前目录的项目级（越靠近当前目录越晚写入，覆盖更早的）
    let user_root = home.join(".claude");
    scan.scan_skills(&user_root, "user");
    scan.scan_commands(&user_root, "user");
    for d in project_dirs(cwd, home).into_iter().rev() {
        let root = d.join(".claude");
        scan.scan_skills(&root, "project");
        scan.scan_commands(&root, "project");
    }
    let Scan {
        mut items, order, ..
    } = scan;
    let mut out: Vec<pb::CustomCommand> =
        order.into_iter().filter_map(|n| items.remove(&n)).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(p, text).expect("write");
    }

    #[test]
    fn meta_parsing() {
        let m = parse_meta("---\ndescription: 部署到生产\nargument-hint: [env]\nfoo\n---\nbody: x");
        assert_eq!(
            (
                m.description.as_str(),
                m.argument_hint.as_str(),
                m.invocable
            ),
            ("部署到生产", "[env]", true)
        );
        assert!(!parse_meta("---\nuser-invocable: false\n---\n").invocable);
        assert_eq!(
            parse_meta("no front matter\ndescription: x").description,
            ""
        );
        assert_eq!(
            parse_meta("---\ndescription: \"quoted\"\n---").description,
            "quoted"
        );
    }

    #[test]
    fn scans_skills_commands_and_overrides() {
        let tmp = tempfile::tempdir().expect("tmp");
        let home = tmp.path().join("home");
        let repo = tmp.path().join("repo");
        let sub = repo.join("pkg/inner");
        std::fs::create_dir_all(repo.join(".git")).expect("git");
        std::fs::create_dir_all(&sub).expect("sub");
        write(
            &home.join(".claude/skills/review/SKILL.md"),
            "---\ndescription: user review\n---\n",
        );
        write(
            &home.join(".claude/commands/deploy.md"),
            "---\ndescription: user deploy\n---\n",
        );
        write(
            &home.join(".claude/commands/team/lint.md"),
            "---\ndescription: lint\nargument-hint: [path]\n---\n",
        );
        write(
            &repo.join(".claude/commands/deploy.md"),
            "---\ndescription: project deploy\n---\n",
        );
        write(
            &repo.join(".claude/skills/hidden/SKILL.md"),
            "---\nuser-invocable: false\n---\n",
        );
        write(
            &sub.join(".claude/skills/local/SKILL.md"),
            "---\ndescription: local skill\n---\n",
        );
        // 仓库根之上的目录不应被扫描
        write(
            &tmp.path().join(".claude/commands/outside.md"),
            "---\ndescription: outside\n---\n",
        );

        let cmds = scan_commands(&sub, &home);
        let by: HashMap<&str, &pb::CustomCommand> =
            cmds.iter().map(|c| (c.name.as_str(), c)).collect();
        assert_eq!(
            by["deploy"].description, "project deploy",
            "项目级覆盖用户级"
        );
        assert_eq!(by["deploy"].source, "project");
        assert_eq!(by["review"].source, "user");
        assert_eq!(by["team:lint"].argument_hint, "[path]");
        assert_eq!(by["local"].description, "local skill");
        assert!(!by.contains_key("hidden"));
        assert!(!by.contains_key("outside"));
    }

    #[test]
    fn caps_at_500() {
        let tmp = tempfile::tempdir().expect("tmp");
        let home = tmp.path().join("home");
        for i in 0..600 {
            write(
                &home.join(format!(".claude/commands/c{i:03}.md")),
                "---\ndescription: x\n---\n",
            );
        }
        let cmds = scan_commands(tmp.path(), &home);
        assert_eq!(cmds.len(), MAX_ITEMS);
    }

    #[test]
    fn missing_dirs_are_fine() {
        let tmp = tempfile::tempdir().expect("tmp");
        std::fs::create_dir_all(tmp.path().join(".git")).expect("git"); // 让向上查找在这里停下，不受真实环境影响
        assert!(scan_commands(&tmp.path().join("nope"), &tmp.path().join("nohome")).is_empty());
    }
}
