#!/usr/bin/env bash
# 提交前 / 公开前敏感信息扫描。扫描“将被提交”的文件（已跟踪 + 未忽略的新文件），发现即以非零退出。
#
# 检查：公网 IPv4、私钥特征、常见 token 前缀、个人邮箱、本机用户名与路径、已知的测试服务器域名/主机名/密码片段、
#       .env 文件、密钥/证书/二进制文件、超过 1MB 的文件；若存在 docs/测试服务器凭据.local.md，还会把其中的 IP 和密码当作精确值再扫一遍。
# 用法：
#   scripts/scan-secrets.sh              只扫工作区
#   scripts/scan-secrets.sh --history    同时扫整个 git 历史（git log --all -p）
# 本脚本自身和 .gitignore 不参与内容扫描（规则里的关键字用 [] 拆开，避免脚本自己命中）。
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
HISTORY=0
[ "${1:-}" = "--history" ] && HISTORY=1

FAIL=0
report() { # 类别 行
  echo "[$1] $2"
  FAIL=1
}

# 名称|扩展正则(grep -E，区分大小写)
RULES=(
  "私钥|-----BEGIN [A-Z ]*PRIVATE KEY-----"
  "GitHub token|(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
  "API key|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[bpas]-[0-9A-Za-z-]{10,}"
  "个人邮箱|[A-Za-z0-9._%+-]+@(gmai[l]|q[q]|163|126|outloo[k]|hotmai[l]|yaho[o]|icloud|foxmai[l]|proton)\\.(com|cn|me)"
  "本机用户名/路径|lizhaowe[i]|[A-Za-z]:\\\\Users\\\\Administrato[r]|/Users/[a-z0-9_.-]+/(Desktop|Documents)|rterm_deploy_ke[y]"
  "测试服务器域名/主机名|shanghaiji[y]ue|ccycid[c]|iv-yez[9]"
  "密码片段|LI[l]i[0-9]{4}"
)
# 公网 IPv4 以外的合法写法（回环、私网、文档保留段、测试里常用的示例地址）
IP_ALLOW='(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.1[89]\.|198\.20\.0\.1|255\.|1\.2\.3\.|1\.1\.1\.1|8\.8\.8\.8|9\.9\.9\.9|6\.6\.6\.6|11\.1\.2\.3)'

# ---- 文件列表 ----
LIST=$(mktemp)
git -c core.quotepath=off ls-files -z -co --exclude-standard | tr '\0' '\n' | grep -vE '^(scripts/scan-secrets\.(sh|ps1)|\.gitignore)$' > "$LIST"
TEXT=$(mktemp); PATS=$(mktemp); trap 'rm -f "$LIST" "$TEXT" "$PATS"' EXIT
grep -vE '(^|/)(Cargo\.lock|package-lock\.json)$|\.(png|ico|icns|jpg|jpeg|gif|webp|woff2?|pdf)$' "$LIST" > "$TEXT"

# ---- 文件名 / 大小 ----
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    .env|*/.env|.env.*|*/.env.*) case "$f" in *.example) ;; *) report ".env 文件" "$f" ;; esac ;;
  esac
  case "$f" in
    *.pem|*.key|*.p12|*.pfx|*.keystore|*.jks|*id_rsa*|*id_ed25519*|*deploy_ke[y]*) report "密钥文件" "$f" ;;
    *.exe|*.dll|*.so|*.dylib|*.msi|*.zip|*.tgz|*.7z) report "二进制/压缩包" "$f" ;;
  esac
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  [ "$sz" -gt 1048576 ] && report "大文件(>1MB)" "$f ($sz 字节)"
done < "$LIST"

# ---- 内容规则 ----
for rule in "${RULES[@]}"; do
  name="${rule%%|*}"; re="${rule#*|}"
  hits=$(tr '\n' '\0' < "$TEXT" | xargs -0 grep -InE -e "$re" 2>/dev/null | cut -c1-160)
  [ -n "$hits" ] && while IFS= read -r l; do report "$name" "$l"; done <<< "$hits"
done
# 公网 IPv4
hits=$(tr '\n' '\0' < "$TEXT" | xargs -0 grep -InoE -e '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' 2>/dev/null \
  | grep -vE ":${IP_ALLOW}[0-9.]*\$" )
[ -n "$hits" ] && while IFS= read -r l; do report "公网IP" "$l"; done <<< "$hits"

# ---- 本机凭据文件里的精确值 ----
CRED='docs/测试服务器凭据.local.md'
if [ -f "$CRED" ]; then
  { grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$CRED" | grep -vE "^${IP_ALLOW}"
    sed -n 's/^- *密码[：:] *//p' "$CRED" | tr -d '\r'; } | sort -u | grep -v '^$' > "$PATS"
  if [ -s "$PATS" ]; then
    hits=$(tr '\n' '\0' < "$TEXT" | xargs -0 grep -InF -f "$PATS" 2>/dev/null | cut -c1-120)
    [ -n "$hits" ] && while IFS= read -r l; do report "凭据文件里的值" "$l"; done <<< "$hits"
  fi
fi

# ---- 历史 ----
if [ "$HISTORY" = 1 ]; then
  H=$(mktemp); git log --all -p --no-color > "$H" 2>/dev/null
  for rule in "${RULES[@]}"; do
    name="${rule%%|*}"; re="${rule#*|}"
    n=$(grep -cE -e "$re" "$H"); [ "$n" -gt 0 ] && report "历史:$name" "$n 行命中（git log --all -p | grep -E '规则' 查看）"
  done
  n=$(grep -E '^\+' "$H" | grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' | grep -vE "^${IP_ALLOW}" | wc -l)
  [ "$n" -gt 0 ] && report "历史:公网IP" "$n 处"
  if git log --all --format='%ae %ce' | grep -vE 'noreply\.github\.com' | grep -q .; then report "历史:提交邮箱" "存在非 noreply 的作者/提交者邮箱"; fi
  rm -f "$H"
fi

if [ "$FAIL" = 0 ]; then
  echo "扫描通过：未发现敏感信息（$(wc -l < "$LIST" | tr -d ' ') 个文件）"
  exit 0
fi
echo "扫描失败：上面是需要处理的项目"
exit 1
