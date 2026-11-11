fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("找不到内置的 protoc");
    let mut cfg = prost_build::Config::new();
    cfg.protoc_executable(protoc);
    cfg.compile_protos(&["../../proto/rterm.proto"], &["../../proto"])
        .expect("编译 proto 失败");
    println!("cargo:rerun-if-changed=../../proto/rterm.proto");
}
