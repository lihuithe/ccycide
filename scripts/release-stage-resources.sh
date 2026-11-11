#!/usr/bin/env bash
# 为 Tauri 打包准备“外部二进制”和“资源文件”（实现方案 12.1；开发指南 T33）。
#
# 产物（路径是与 Tauri 配置之间的接口，改动前请同步 docs/发布流程.md 第 8 节）：
#   apps/desktop/src-tauri/binaries/rterm-cli-<target-triple>[.exe]   ← tauri.conf 的 bundle.externalBin = ["binaries/rterm-cli"]
#   apps/desktop/src-tauri/resources/conpty.dll                       ← 仅 Windows 目标；见 tauri.bundle.windows.conf.json，安装到 exe 同目录
#   apps/desktop/src-tauri/resources/OpenConsole.exe
#
# 用法：
#   scripts/release-stage-resources.sh --target x86_64-pc-windows-msvc
#   scripts/release-stage-resources.sh --target universal-apple-darwin     # 分别编译两个架构后 lipo 合并
#   scripts/release-stage-resources.sh --target x86_64-unknown-linux-gnu --stub
#
#   --target TRIPLE   Tauri 的目标三元组（不给则用 rustc 的 host）
#   --stub            只生成空占位文件，不编译不下载。CI 里的 clippy/check 需要这些路径存在（tauri-build 会校验），
#                     但不需要真内容
#   --no-build        不编译 rterm-cli，直接用已有的 target/<triple>/release 产物（本地反复打包时省时间）
#   --conpty-out DIR  只把该目标的 conpty.dll / OpenConsole.exe 放到 DIR（命令行版压缩包用），不编译、不碰 src-tauri
#   --root DIR        仓库根目录（默认脚本上级目录）
#
# Windows 上请在 Git Bash 里运行；依赖 curl、sha256sum（或 shasum）、python3（解压 nupkg），无需 PowerShell。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
STUB=0
BUILD=1
CONPTY_OUT=""

# ConPTY 来自微软官方 NuGet 包 Microsoft.Windows.Console.ConPTY（M0 验证结论里实测过的版本）。
# 升级版本时同时更新 SHA256：先下载再 sha256sum，核对发布者签名后写入。
CONPTY_VERSION="1.24.261001001"
CONPTY_SHA256="4d6aaddc1d2385c9f5897df28f33879f699f8f2783315d5204cf3d8c3616ac5f"
CONPTY_URL="https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${CONPTY_VERSION}/microsoft.windows.console.conpty.${CONPTY_VERSION}.nupkg"

die() { echo "错误：$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift ;;
    --stub) STUB=1 ;;
    --no-build) BUILD=0 ;;
    --conpty-out) CONPTY_OUT="${2:-}"; shift ;;
    --root) ROOT="$(cd "${2:-}" && pwd)"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "未知参数 $1" ;;
  esac
  shift
done

if [ -z "$TARGET" ]; then
  TARGET="$(rustc -vV | sed -n 's/^host: //p' | tr -d '\r')"
  [ -n "$TARGET" ] || die "没有指定 --target，也无法从 rustc 取得 host"
fi

TAURI_DIR="$ROOT/apps/desktop/src-tauri"
BIN_DIR="$TAURI_DIR/binaries"
CONPTY_DIR="${CONPTY_OUT:-$TAURI_DIR/resources}"
[ -n "$CONPTY_OUT" ] || mkdir -p "$BIN_DIR"

EXE=""
case "$TARGET" in *windows*) EXE=".exe" ;; esac
SIDECAR="$BIN_DIR/rterm-cli-${TARGET}${EXE}"

# 从标准输入算哈希：Windows 路径含反斜杠时，sha256sum 会在输出的哈希前加 "\"，导致比对失败
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi; }
PY="$(command -v python3 || command -v python || true)"

# ---------- 1. rterm-cli 外部二进制 ----------
build_one() { # triple → 输出编译产物路径
  local t="$1"
  if [ "$BUILD" = 1 ]; then
    echo ">> cargo build --release -p rterm-cli --target $t" >&2
    (cd "$ROOT" && cargo build --release -p rterm-cli --target "$t") >&2
  fi
  local tdir="${CARGO_TARGET_DIR:-$ROOT/target}"
  local out="$tdir/$t/release/rterm-cli"
  case "$t" in *windows*) out="$out.exe" ;; esac
  [ -f "$out" ] || die "找不到编译产物 $out"
  echo "$out"
}

if [ -n "$CONPTY_OUT" ]; then
  :   # 只要 ConPTY，跳过 rterm-cli
elif [ "$STUB" = 1 ]; then
  : > "$SIDECAR"
  echo "[stub] $SIDECAR"
elif [ "$TARGET" = "universal-apple-darwin" ]; then
  a="$(build_one aarch64-apple-darwin)"
  x="$(build_one x86_64-apple-darwin)"
  lipo -create -output "$SIDECAR" "$a" "$x"
  chmod +x "$SIDECAR"
  echo "已合并通用二进制：$SIDECAR"
else
  cp -f "$(build_one "$TARGET")" "$SIDECAR"
  chmod +x "$SIDECAR" 2>/dev/null || true
  echo "已放置：$SIDECAR"
fi

# ---------- 2. Windows：conpty.dll + OpenConsole.exe ----------
case "$TARGET" in
  *windows*)
    case "$TARGET" in
      x86_64-*) ARCH_DIR=x64; RID=win-x64 ;;
      aarch64-*) ARCH_DIR=arm64; RID=win-arm64 ;;
      *) die "不支持的 Windows 目标 ${TARGET}（只做 x64 和 ARM64）" ;;
    esac
    mkdir -p "$CONPTY_DIR"
    if [ "$STUB" = 1 ]; then
      : > "$CONPTY_DIR/conpty.dll"; : > "$CONPTY_DIR/OpenConsole.exe"
      echo "[stub] $CONPTY_DIR/{conpty.dll,OpenConsole.exe}"
    else
      [ -n "$PY" ] || die "需要 python3 来解压 nupkg"
      CACHE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rterm-conpty-cache"
      mkdir -p "$CACHE"
      NUPKG="$CACHE/conpty-${CONPTY_VERSION}.nupkg"
      if [ ! -f "$NUPKG" ] || [ "$(sha256_of "$NUPKG")" != "$CONPTY_SHA256" ]; then
        echo ">> 下载 ConPTY $CONPTY_VERSION"
        curl -fsSL --retry 3 -o "$NUPKG" "$CONPTY_URL"
      fi
      [ "$(sha256_of "$NUPKG")" = "$CONPTY_SHA256" ] || die "ConPTY nupkg 的 SHA256 与脚本里固定的值不符，已拒绝使用"
      # 脚本通过参数传入路径；-I 避免加载当前目录下的同名模块
      PYTHONIOENCODING=utf-8 "$PY" -I - "$NUPKG" "$RID" "$ARCH_DIR" "$CONPTY_DIR" <<'PYEOF'
import sys, zipfile, os
nupkg, rid, arch, dest = sys.argv[1:5]
want = {
    "conpty.dll": "runtimes/%s/native/conpty.dll" % rid,
    "OpenConsole.exe": "build/native/runtimes/%s/OpenConsole.exe" % arch,
}
with zipfile.ZipFile(nupkg) as z:
    for name, member in want.items():
        data = z.read(member)
        with open(os.path.join(dest, name), "wb") as f:
            f.write(data)
        print("  %s <- %s (%d 字节)" % (name, member, len(data)))
PYEOF
      echo "已放置：$CONPTY_DIR"
    fi
    ;;
esac

echo "完成（target=${TARGET}）"
