//! 进程树查询：判断某个终端的 shell 下面是否有 `claude` 进程（无状态回传时的降级判断，
//! 见《实现方案.md》18.8.6），以及测试里确认没有残留进程。
use std::collections::HashMap;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub cmd: Vec<String>,
}

/// 一次进程快照。全局只拍一次，再对每个终端的 shell 查后代，避免每个终端各扫一遍。
pub struct ProcTable {
    children: HashMap<u32, Vec<u32>>,
    info: HashMap<u32, ProcInfo>,
}

impl ProcTable {
    /// 拍快照。阻塞调用，约几十毫秒，应放进 `spawn_blocking`。
    pub fn snapshot() -> ProcTable {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut info = HashMap::new();
        if let Ok(mut sys) = System::new() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
            );
            for (pid, p) in sys.processes() {
                let pid = pid.as_u32();
                if let Some(parent) = p.parent().map(Pid::as_u32) {
                    children.entry(parent).or_default().push(pid);
                }
                info.insert(
                    pid,
                    ProcInfo {
                        pid,
                        name: p.name().to_string_lossy().into_owned(),
                        cmd: p
                            .cmd()
                            .iter()
                            .map(|s| s.to_string_lossy().into_owned())
                            .collect(),
                    },
                );
            }
        }
        ProcTable { children, info }
    }

    /// `root` 的全部后代进程（不含 root 自己）。
    pub fn descendants(&self, root: u32) -> Vec<ProcInfo> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        let mut guard = 0;
        while let Some(cur) = stack.pop() {
            guard += 1;
            if guard > 4096 {
                break;
            }
            for k in self.children.get(&cur).into_iter().flatten() {
                if let Some(p) = self.info.get(k) {
                    out.push(p.clone());
                }
                stack.push(*k);
            }
        }
        out
    }
}

/// 列出 `root` 的全部后代进程。
pub fn descendants(root: u32) -> Vec<ProcInfo> {
    ProcTable::snapshot().descendants(root)
}

/// 后代进程里是否有 Claude Code：进程名为 `claude`（原生二进制或 npm 的 shim），
/// 或者是 node/bun 在运行 `@anthropic-ai/claude-code`。
pub fn has_claude(procs: &[ProcInfo]) -> bool {
    procs.iter().any(is_claude)
}

fn is_claude(p: &ProcInfo) -> bool {
    let name = p.name.to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    if stem == "claude" {
        return true;
    }
    if matches!(stem, "node" | "bun" | "deno") {
        return p.cmd.iter().any(|a| {
            let a = a.to_ascii_lowercase().replace('\\', "/");
            a.contains("@anthropic-ai/claude-code")
                || a.ends_with("/claude")
                || a.ends_with("/claude.js")
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_claude_names() {
        let mk = |name: &str, cmd: &[&str]| ProcInfo {
            pid: 1,
            name: name.into(),
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
        };
        assert!(is_claude(&mk("claude.exe", &[])));
        assert!(is_claude(&mk(
            "node.exe",
            &[
                "node",
                r"C:\x\node_modules\@anthropic-ai\claude-code\cli.js"
            ]
        )));
        assert!(!is_claude(&mk("node.exe", &["node", "server.js"])));
        assert!(!is_claude(&mk("cmd.exe", &[])));
    }

    #[test]
    fn snapshot_sees_self_children() {
        let t = ProcTable::snapshot();
        // 自己的进程一定在表里
        assert!(t.info.contains_key(&std::process::id()));
    }
}
