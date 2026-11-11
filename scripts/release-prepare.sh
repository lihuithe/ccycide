#!/usr/bin/env bash
# RTerm 版本号一致性检查与批量修改（对应 scripts/release-prepare.ps1，两者行为一致）。
#
# 管理的文件（不存在的会跳过）：
#   Cargo.toml                         [workspace.package] version（唯一来源，crates/* 与 src-tauri 用 version.workspace = true）
#   crates/*/Cargo.toml                必须是 version.workspace = true，或写死且与工作区一致
#   apps/desktop/src-tauri/Cargo.toml  同上
#   Cargo.lock                         本地 crate（无 source 的包）的 version
#   apps/desktop/package.json          + package-lock.json（顶层与 packages[""] 两处）
#   server/package.json                + package-lock.json
#   apps/desktop/src-tauri/tauri.conf.json  version 缺省或写成 "../package.json" 视为跟随，写死则必须一致
#
# 用法：
#   scripts/release-prepare.sh                      检查所有文件版本一致（默认）
#   scripts/release-prepare.sh --expect 0.2.0       检查并要求等于 0.2.0（tag 校验用，可写 v0.2.0）
#   scripts/release-prepare.sh --set 0.2.0          批量改成 0.2.0，改完自动再检查
#   scripts/release-prepare.sh --set 0.2.0 --dry-run  只检查参数与路径，不写文件
#   --root DIR                                      指定仓库根目录（默认脚本上级目录）
#
# 退出码：0 一致；1 不一致或参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=check
NEW=""
EXPECT=""
DRY=0

die() { echo "错误：$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --set) MODE="set"; NEW="${2:-}"; shift ;;
    --expect) EXPECT="${2:-}"; shift ;;
    --dry-run) DRY=1 ;;
    --root) ROOT="$(cd "${2:-}" && pwd)"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "未知参数 $1" ;;
  esac
  shift
done

SEMVER='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
NEW="${NEW#v}"
EXPECT="${EXPECT#v}"
if [ "$MODE" = set ]; then
  [[ "$NEW" =~ $SEMVER ]] || die "--set 需要形如 1.2.3 或 1.2.3-beta.1 的版本号，收到「$NEW」"
fi
if [ -n "$EXPECT" ]; then
  [[ "$EXPECT" =~ $SEMVER ]] || die "--expect 不是合法版本号：$EXPECT"
fi

# ---------- awk 程序：op=get 输出当前值，op=set 输出改写后的全文 ----------
# 变量：kind=json|lock|cargo_ws|cargo_pkg|cargolock  op=get|set  nv=新版本  names=" a b c "
read -r -d '' AWK_PROG <<'AWK' || true
function jver(line) { sub(/^[ \t]*"version"[ \t]*:[ \t]*"/, "", line); sub(/".*$/, "", line); return line }
function jrewrite(line, v,   head, rest) {
  match(line, /^[ \t]*"version"[ \t]*:[ \t]*"/); head = substr(line, 1, RLENGTH)
  rest = substr(line, RLENGTH + 1); sub(/^[^"]*/, "", rest); return head v rest
}
function cver(line) { sub(/^version[ \t]*=[ \t]*"/, "", line); sub(/".*$/, "", line); return line }
function crewrite(line, v,   head, rest) {
  match(line, /^version[ \t]*=[ \t]*"/); head = substr(line, 1, RLENGTH)
  rest = substr(line, RLENGTH + 1); sub(/^[^"]*/, "", rest); return head v rest
}
function flush(   i, name, src, vidx) {
  if (nb == 0) return
  name = ""; src = 0; vidx = 0
  for (i = 1; i <= nb; i++) {
    if (buf[i] ~ /^name[ \t]*=/) { name = buf[i]; sub(/^name[ \t]*=[ \t]*"/, "", name); sub(/".*$/, "", name) }
    if (buf[i] ~ /^source[ \t]*=/) src = 1
    if (buf[i] ~ /^version[ \t]*=/ && !vidx) vidx = i
  }
  if (!src && vidx && index(names, " " name " ") > 0) {
    if (op == "get") print "pkg:" name "=" cver(buf[vidx])
    else buf[vidx] = crewrite(buf[vidx], nv)
  }
  if (op == "set") for (i = 1; i <= nb; i++) print buf[i]
  nb = 0
}
BEGIN { topdone = 0; rootdone = 0; inroot = 0; insec = 0; done = 0; nb = 0; inblock = 0 }
{
  if (kind == "json") {
    if (!done && $0 ~ /^[ \t]*"version"[ \t]*:[ \t]*"/) {
      done = 1
      if (op == "get") print jver($0); else { print jrewrite($0, nv); next }
    }
    if (op == "set") print
  } else if (kind == "lock") {
    if (!rootdone && $0 ~ /^[ \t]*"":[ \t]*\{/) inroot = 1
    if ($0 ~ /^[ \t]*"version"[ \t]*:[ \t]*"/ && !rootdone) {
      if (!topdone) {
        topdone = 1
        if (op == "get") print "top=" jver($0); else { print jrewrite($0, nv); next }
      } else if (inroot) {
        rootdone = 1
        if (op == "get") print "root=" jver($0); else { print jrewrite($0, nv); next }
      }
    }
    if (op == "set") print
  } else if (kind == "cargo_ws" || kind == "cargo_pkg") {
    if ($0 ~ /^\[/) {
      insec = (kind == "cargo_ws") ? ($0 ~ /^\[workspace\.package\]/) : ($0 ~ /^\[package\]/)
    }
    if (insec && !done && $0 ~ /^version\.workspace[ \t]*=[ \t]*true/) {
      done = 1; if (op == "get") print "workspace"
    } else if (insec && !done && $0 ~ /^version[ \t]*=[ \t]*"/) {
      done = 1
      if (op == "get") print cver($0); else { print crewrite($0, nv); next }
    }
    if (op == "set") print
  } else if (kind == "cargolock") {
    if ($0 ~ /^\[\[package\]\]/) { flush(); inblock = 1; buf[++nb] = $0; next }
    if ($0 ~ /^\[/) { flush(); inblock = 0 }
    if (inblock) { buf[++nb] = $0; next }
    if (op == "set") print
  }
}
END { if (kind == "cargolock") flush() }
AWK

# awk_get kind file [names]；awk_set kind file [names]（set 把结果写回原文件，保持原有换行符）
awk_get() { awk -v kind="$1" -v op=get -v names="${3:-}" "$AWK_PROG" "$2" | tr -d '\r'; }
awk_set() {
  local kind="$1" file="$2" names="${3:-}" tmp
  tmp="$(mktemp)"
  awk -v kind="$kind" -v op=set -v nv="$NEW" -v names="$names" "$AWK_PROG" "$file" | tr -d '\r' > "$tmp.lf"
  # 部分 awk（如 Git Bash 的 gawk）读文件时会吃掉 CR；原文件是 CRLF 的就补回去，避免整文件换行符被改
  if [ "$(tr -cd '\r' < "$file" | wc -c)" -gt 0 ]; then awk '{ printf "%s\r\n", $0 }' "$tmp.lf" > "$tmp"; else cat "$tmp.lf" > "$tmp"; fi
  rm -f "$tmp.lf"
  if [ "$DRY" = 1 ]; then rm -f "$tmp"; else cat "$tmp" > "$file"; rm -f "$tmp"; fi
}

# ---------- 收集目标 ----------
WS_TOML="$ROOT/Cargo.toml"
[ -f "$WS_TOML" ] || die "找不到 $WS_TOML"
TAURI_DIR="$ROOT/apps/desktop/src-tauri"

pkg_name() { # Cargo.toml 的 [package] name
  awk '/^\[/{s=($0 ~ /^\[package\]/)} s && /^name[ \t]*=/{n=$0; sub(/^name[ \t]*=[ \t]*"/,"",n); sub(/".*$/,"",n); print n; exit}' "$1" | tr -d '\r'
}

MEMBER_TOMLS=()
for f in "$ROOT"/crates/*/Cargo.toml; do [ -f "$f" ] && MEMBER_TOMLS+=("$f"); done
[ -f "$TAURI_DIR/Cargo.toml" ] && MEMBER_TOMLS+=("$TAURI_DIR/Cargo.toml")

NAMES=" "
for f in "${MEMBER_TOMLS[@]}"; do NAMES+="$(pkg_name "$f") "; done

# ---------- 修改 ----------
if [ "$MODE" = set ]; then
  awk_set cargo_ws "$WS_TOML"
  for f in "${MEMBER_TOMLS[@]}"; do
    cur="$(awk_get cargo_pkg "$f" | head -n1)"
    # 写死版本的成员才改；version.workspace = true 的不动
    if [ -n "$cur" ] && [ "$cur" != workspace ]; then awk_set cargo_pkg "$f"; fi
  done
  if [ -f "$ROOT/Cargo.lock" ]; then awk_set cargolock "$ROOT/Cargo.lock" "$NAMES"; fi
  for p in apps/desktop server; do
    if [ -f "$ROOT/$p/package.json" ]; then awk_set json "$ROOT/$p/package.json"; fi
    if [ -f "$ROOT/$p/package-lock.json" ]; then awk_set lock "$ROOT/$p/package-lock.json"; fi
  done
  TC="$TAURI_DIR/tauri.conf.json"
  if [ -f "$TC" ]; then
    cur="$(awk_get json "$TC" | head -n1)"
    if [ -n "$cur" ] && [[ "$cur" =~ ^[0-9] ]]; then awk_set json "$TC"; fi
  fi
  if [ "$DRY" = 1 ]; then echo "[dry-run] 参数与路径检查通过，未写入任何文件，目标版本 $NEW"; exit 0; fi
  echo "已将版本号改为 $NEW"
fi

# ---------- 检查 ----------
ROWS=()
WS_VER="$(awk_get cargo_ws "$WS_TOML" | head -n1)"
[ -n "$WS_VER" ] || die "Cargo.toml 的 [workspace.package] 里没有 version"
WANT="${EXPECT:-$WS_VER}"
BAD=0

add() { # label value
  local ok="OK"
  [ "$2" = "$WANT" ] || { ok="不一致"; BAD=1; }
  ROWS+=("$(printf '%-52s %-16s %s' "$1" "$2" "$ok")")
}
add_note() { ROWS+=("$(printf '%-52s %-16s %s' "$1" "$2" "跟随")"); }
rel() { echo "${1#"$ROOT"/}"; }

add "Cargo.toml [workspace.package]" "$WS_VER"
for f in "${MEMBER_TOMLS[@]}"; do
  v="$(awk_get cargo_pkg "$f" | head -n1)"
  if [ "$v" = workspace ]; then add_note "$(rel "$f")" "workspace"; else add "$(rel "$f")" "${v:-（缺失）}"; fi
done
if [ -f "$ROOT/Cargo.lock" ]; then
  while IFS= read -r line; do
    n="${line#pkg:}"; add "Cargo.lock ${n%%=*}" "${n#*=}"
  done < <(awk_get cargolock "$ROOT/Cargo.lock" "$NAMES")
fi
for p in apps/desktop server; do
  if [ -f "$ROOT/$p/package.json" ]; then add "$p/package.json" "$(awk_get json "$ROOT/$p/package.json" | head -n1)"; fi
  if [ -f "$ROOT/$p/package-lock.json" ]; then
    while IFS= read -r line; do add "$p/package-lock.json (${line%%=*})" "${line#*=}"; done < <(awk_get lock "$ROOT/$p/package-lock.json")
  fi
done
TC="$TAURI_DIR/tauri.conf.json"
if [ -f "$TC" ]; then
  v="$(awk_get json "$TC" | head -n1 || true)"
  if [ -z "$v" ]; then add_note "apps/desktop/src-tauri/tauri.conf.json" "（未设置）"
  elif [[ "$v" =~ ^[0-9] ]]; then add "apps/desktop/src-tauri/tauri.conf.json" "$v"
  else add_note "apps/desktop/src-tauri/tauri.conf.json" "$v"; fi
else
  ROWS+=("$(printf '%-52s %-16s %s' "apps/desktop/src-tauri/tauri.conf.json" "-" "文件还不存在，跳过")")
fi

echo "期望版本：$WANT"
printf '%s\n' "${ROWS[@]}"
if [ "$BAD" = 1 ]; then
  echo "版本号不一致。用 scripts/release-prepare.sh --set $WANT 批量修正。" >&2
  exit 1
fi
echo "版本号全部一致：$WANT"
