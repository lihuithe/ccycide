fn main() {
    check_default_api_url();
    tauri_build::build()
}

/// 发布构建（release profile）必须通过环境变量 `RTERM_DEFAULT_API_URL` 指定 https 地址
///（形如 `https://<API 域名>`）。核心库在运行时会拒绝非 https 的默认地址，
/// 这里提前在编译期失败，避免打出一个连不上服务端的安装包。
/// 本地试打 release 包可设 `RTERM_SKIP_API_URL_CHECK=1` 跳过。
fn check_default_api_url() {
    println!("cargo:rerun-if-env-changed=RTERM_DEFAULT_API_URL");
    println!("cargo:rerun-if-env-changed=RTERM_SKIP_API_URL_CHECK");
    if std::env::var("PROFILE").as_deref() != Ok("release")
        || std::env::var_os("RTERM_SKIP_API_URL_CHECK").is_some()
    {
        return;
    }
    match std::env::var("RTERM_DEFAULT_API_URL") {
        Ok(u) if u.starts_with("https://") && u.len() > "https://".len() => {}
        Ok(_) => panic!("发布构建的 RTERM_DEFAULT_API_URL 必须是 https:// 地址（如 https://<API 域名>）"),
        Err(_) => panic!("发布构建必须设置 RTERM_DEFAULT_API_URL=https://<API 域名>（本地试打可设 RTERM_SKIP_API_URL_CHECK=1 跳过）"),
    }
}
