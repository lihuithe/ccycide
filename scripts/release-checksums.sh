#!/usr/bin/env bash
# 为目录下的所有发布文件生成 SHA256SUMS.txt（Linux 用户无签名可验，靠它校验下载完整性）。
#
# 用法：scripts/release-checksums.sh DIR [输出文件名，默认 SHA256SUMS.txt]
#   输出写在 DIR 里；不会把自己和已有的校验文件算进去。
# 用户校验：sha256sum -c SHA256SUMS.txt（macOS 用 shasum -a 256 -c SHA256SUMS.txt）
set -euo pipefail

DIR="${1:?用法：release-checksums.sh DIR [输出文件名]}"
OUT="${2:-SHA256SUMS.txt}"
[ -d "$DIR" ] || { echo "错误：找不到目录 $DIR" >&2; exit 1; }

cd "$DIR"
if command -v sha256sum >/dev/null 2>&1; then SUM=(sha256sum); else SUM=(shasum -a 256); fi

tmp="$(mktemp)"
# 只处理普通文件，按文件名排序，输出里是纯文件名（不带目录）
find . -maxdepth 1 -type f ! -name "$OUT" ! -name 'SHA256SUMS*' -print | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
  "${SUM[@]}" -- "$f" | sed 's/ \*/  /'
done > "$tmp"

[ -s "$tmp" ] || { echo "错误：$DIR 里没有可计算的文件" >&2; rm -f "$tmp"; exit 1; }
mv "$tmp" "$OUT"
echo "已生成 $DIR/${OUT}（$(wc -l < "$OUT") 个文件）"
