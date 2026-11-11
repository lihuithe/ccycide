//! 模拟 `rterm-cli hook [--statusline]`：直接调用 rterm-core 里的 hook_main，用来实测启动耗时和协议。
fn main() {
    let statusline = std::env::args().any(|a| a == "--statusline");
    rterm_core::host::status::hook_main(statusline)
}
