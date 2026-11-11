#!/usr/bin/env bash
# 更新服务器的发布管理：登记版本、调灰度、撤回、强制升级（调用服务端 /v1/admin/*，见 server/src/api/admin.ts）。
#
# 连接方式（二选一，管理接口不对公网开放，见 deploy/Caddyfile）：
#   A. 直连：UPDATE_SERVER_URL=http://127.0.0.1:8080   ADMIN_TOKEN=...
#      （自己先开好 SSH 隧道 / 内网地址 / 临时的 127.0.0.1 端口映射）
#   B. 经 SSH 在服务器的 signal 容器里发请求（不需要开任何端口，ADMIN_TOKEN 用容器里已有的）：
#      RTERM_ADMIN_SSH=user@host   [RTERM_DEPLOY_DIR=/opt/rterm/deploy]
#
# 子命令：
#   publish --version 1.2.0 --assets DIR --base-url URL [--rollout 5] [--channel stable|beta] [--notes-file F] [--dry-run]
#       扫描 DIR 里的更新包（须带同名 .sig），按文件名识别 平台/架构/种类 后逐条 POST /v1/admin/releases。
#       已登记过的版本（409）视为成功，所以可以安全重跑。
#   list [--kind desktop|cli]                     列出已登记的发布
#   rollout ID PERCENT                            调某一条记录的灰度比例（0-100）
#   rollout-version VERSION PERCENT               调某个版本全部记录的灰度比例
#   revoke ID | revoke-version VERSION            撤回（status=0）一条 / 整个版本；客户端不会再收到它
#   restore ID                                    恢复撤回的记录
#   min-version X.Y.Z                             设置强制升级的最低版本（min_app_version）
#   clear-min-version                             取消强制升级
#
# 依赖：bash、curl（直连时）/ssh（SSH 方式时）、node（组装与解析 JSON）。
set -euo pipefail

die() { echo "错误：$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "需要 node 来处理 JSON"

DEPLOY_DIR="${RTERM_DEPLOY_DIR:-/opt/rterm/deploy}"

# SSH 方式在容器里执行的小脚本：从 stdin 读请求体，第一行输出状态码，其余输出响应体
REMOTE_NODE='let b="";process.stdin.on("data",d=>b+=d).on("end",async()=>{const m=process.argv[1],p=process.argv[2];const r=await fetch("http://127.0.0.1:8080/v1/admin"+p,{method:m,headers:{authorization:"Bearer "+process.env.ADMIN_TOKEN,"content-type":"application/json"},body:b?b:undefined});console.log(r.status);console.log(await r.text())})'

HTTP_CODE=""
HTTP_BODY=""

# api METHOD PATH [BODY]  → 设置 HTTP_CODE / HTTP_BODY
api() {
  local method="$1" path="$2" body="${3:-}" out
  if [ -n "${RTERM_ADMIN_SSH:-}" ]; then
    out="$(printf '%s' "$body" | ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$RTERM_ADMIN_SSH" \
      "cd '$DEPLOY_DIR' && docker compose exec -T signal node -e '$REMOTE_NODE' '$method' '$path'")" || die "SSH 调用失败"
    HTTP_CODE="$(printf '%s\n' "$out" | head -n1)"
    HTTP_BODY="$(printf '%s\n' "$out" | tail -n +2)"
  else
    [ -n "${UPDATE_SERVER_URL:-}" ] || die "请设置 UPDATE_SERVER_URL（直连）或 RTERM_ADMIN_SSH（经 SSH），见脚本头部说明"
    [ -n "${ADMIN_TOKEN:-}" ] || die "直连方式需要环境变量 ADMIN_TOKEN"
    local tmp; tmp="$(mktemp)"
    local args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')
    [ -n "$body" ] && args+=(--data-binary "$body")
    HTTP_CODE="$(curl "${args[@]}" "${UPDATE_SERVER_URL%/}/v1/admin$path")" || { rm -f "$tmp"; die "curl 失败"; }
    HTTP_BODY="$(cat "$tmp")"; rm -f "$tmp"
  fi
}

# 要求 2xx，否则退出并打印响应
expect_ok() {
  case "$HTTP_CODE" in 2*) ;; *) echo "请求失败 HTTP ${HTTP_CODE}：$HTTP_BODY" >&2; exit 1 ;; esac
}

# ---------- 子命令 ----------
cmd_publish() {
  local version="" assets="" base="" rollout="${ROLLOUT_PERCENT:-5}" channel="auto" notes_file="" dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) version="${2#v}"; shift ;;
      --assets) assets="$2"; shift ;;
      --base-url) base="$2"; shift ;;
      --rollout) rollout="$2"; shift ;;
      --channel) channel="$2"; shift ;;
      --notes-file) notes_file="$2"; shift ;;
      --dry-run) dry=1 ;;
      *) die "publish 不认识的参数 $1" ;;
    esac
    shift
  done
  [ -n "$version" ] && [ -n "$assets" ] && [ -n "$base" ] || die "publish 需要 --version --assets --base-url"
  [ -d "$assets" ] || die "找不到目录 $assets"
  [[ "$rollout" =~ ^[0-9]+$ ]] && [ "$rollout" -le 100 ] || die "--rollout 必须是 0-100 的整数"
  if [ "$channel" = auto ]; then
    case "$version" in *-*) channel=beta ;; *) channel=stable ;; esac
  fi
  [ "$channel" = stable ] || [ "$channel" = beta ] || die "--channel 只能是 stable 或 beta"

  local bodies
  bodies="$(node - "$version" "$assets" "$base" "$rollout" "$channel" "$notes_file" <<'JS'
const fs = require('fs'), path = require('path');
const [version, dir, base, rollout, channel, notesFile] = process.argv.slice(2);
const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').slice(0, 4000) : '';
const names = fs.readdirSync(dir).filter((n) => !n.endsWith('.sig')).sort();
const archOf = (n) => (/(arm64|aarch64)/.test(n) ? 'aarch64' : /(x64|x86_64|amd64)/.test(n) ? 'x86_64' : null);
const out = [];
for (const name of names) {
  const l = name.toLowerCase();
  const targets = []; // [kind, platform, arch]
  let m;
  if (/-setup\.exe$/.test(l) && !l.includes('offline')) {
    const a = archOf(l); if (a) targets.push(['desktop', 'windows', a]);
  } else if (/\.app\.tar\.gz$/.test(l)) {
    const a = archOf(l);
    for (const x of a ? [a] : ['x86_64', 'aarch64']) targets.push(['desktop', 'macos', x]);
  } else if (/\.appimage$/.test(l)) {
    const a = archOf(l); if (a) targets.push(['desktop', 'linux', a]);
  } else if ((m = /^rterm-cli-.+-(x86_64|aarch64)-(unknown-linux-musl|pc-windows-msvc|apple-darwin)\.(tar\.gz|zip)$/.exec(l))) {
    const plat = { 'unknown-linux-musl': 'linux', 'pc-windows-msvc': 'windows', 'apple-darwin': 'macos' }[m[2]];
    targets.push(['cli', plat, m[1]]);
  }
  if (!targets.length) continue;
  const sigPath = path.join(dir, name + '.sig');
  if (!fs.existsSync(sigPath)) { console.error(`跳过 ${name}：没有同名 .sig 签名文件`); continue; }
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  for (const [kind, platform, arch] of targets) {
    out.push(JSON.stringify({
      version, kind, platform, arch, channel,
      download_url: base.replace(/\/+$/, '') + '/' + encodeURIComponent(name),
      signature, notes, rollout_percent: Number(rollout),
    }));
  }
}
console.log(out.join('\n'));
JS
)" || die "识别更新包失败"

  [ -n "$bodies" ] || die "在 $assets 里没有找到可登记的更新包（需要 -setup.exe / .app.tar.gz / .AppImage / rterm-cli-*.tar.gz|zip 且带 .sig）"

  local n=0 fail=0 line label
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2016  # 单引号里是 node 脚本，不需要 shell 展开
    label="$(printf '%s' "$line" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`${j.version} ${j.kind}/${j.platform}/${j.arch}/${j.channel} 灰度${j.rollout_percent}% ${j.download_url}`)')"
    n=$((n + 1))
    if [ "$dry" = 1 ]; then echo "[dry-run] POST /v1/admin/releases  $label"; continue; fi
    api POST /releases "$line"
    case "$HTTP_CODE" in
      2*) echo "已登记  $label" ;;
      409) echo "已存在  ${label}（跳过）" ;;
      *) echo "失败    $label  HTTP $HTTP_CODE $HTTP_BODY" >&2; fail=$((fail + 1)) ;;
    esac
  done <<< "$bodies"
  echo "共 $n 条，失败 $fail 条"
  [ "$fail" = 0 ]
}

cmd_list() {
  local q=""
  [ "${1:-}" = --kind ] && q="?kind=${2:-}"
  api GET "/releases$q"; expect_ok
  printf '%s' "$HTTP_BODY" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad("id", 5) + pad("version", 16) + pad("kind", 9) + pad("platform", 9) + pad("arch", 9) + pad("channel", 8) + pad("灰度%", 6) + "状态");
    for (const r of j.items) console.log(pad(r.id, 5) + pad(r.version, 16) + pad(r.kind, 9) + pad(r.platform, 9) + pad(r.arch, 9) + pad(r.channel, 8) + pad(r.rollout_percent, 6) + (r.status === 1 ? "生效" : "已撤回"));'
}

# 取某个版本的全部记录 id
ids_of_version() {
  api GET "/releases?limit=500"; expect_ok
  printf '%s' "$HTTP_BODY" | node -e 'const v=process.argv[1];const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.items.filter(r=>r.version===v).map(r=>r.id).join("\n"))' "$1"
}

patch_id() { # id json
  api PATCH "/releases/$1" "$2"
  case "$HTTP_CODE" in 2*) echo "记录 $1 已更新：$2" ;; *) echo "记录 $1 更新失败 HTTP $HTTP_CODE $HTTP_BODY" >&2; return 1 ;; esac
}

patch_version() { # version json
  local ids id rc=0
  ids="$(ids_of_version "${1#v}")"
  [ -n "$ids" ] || die "没有找到版本 $1 的记录"
  while IFS= read -r id; do [ -n "$id" ] && { patch_id "$id" "$2" || rc=1; }; done <<< "$ids"
  return $rc
}

pct_ok() { [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -le 100 ] || die "灰度比例必须是 0-100 的整数"; }
ver_ok() { [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "不是合法版本号：${1:-}"; }

sub="${1:-}"; [ $# -gt 0 ] && shift
case "$sub" in
  publish) cmd_publish "$@" ;;
  list) cmd_list "$@" ;;
  rollout) pct_ok "${2:-}"; patch_id "${1:?缺少 ID}" "{\"rollout_percent\":$2}" ;;
  rollout-version) pct_ok "${2:-}"; patch_version "${1:?缺少版本号}" "{\"rollout_percent\":$2}" ;;
  revoke) patch_id "${1:?缺少 ID}" '{"status":0}' ;;
  revoke-version) patch_version "${1:?缺少版本号}" '{"status":0}' ;;
  restore) patch_id "${1:?缺少 ID}" '{"status":1}' ;;
  min-version)
    ver_ok "${1:-}"
    api PUT /config/min_app_version "{\"value\":\"${1#v}\",\"remark\":\"release-admin.sh\"}"; expect_ok
    echo "min_app_version 已设为 ${1#v}：低于它的客户端连接时会收到强制升级提示" ;;
  clear-min-version)
    api DELETE /config/min_app_version; expect_ok
    echo "已删除下发的 min_app_version，恢复为服务端环境变量里的默认值" ;;
  ''|-h|--help) sed -n '2,26p' "$0" ;;
  *) die "未知子命令 ${sub}（-h 查看帮助）" ;;
esac
