#!/usr/bin/env bash
# 备份 MySQL 到 deploy/backups/，只保留最近 14 天。恢复方法见《部署指南.md》8.3。
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p backups
FILE="backups/rterm-$(date +%Y%m%d-%H%M%S).sql.gz"

# 先写到 .partial，成功后再改名，避免中途失败留下一个看起来正常的坏文件
docker compose exec -T mysql sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --databases "$MYSQL_DATABASE"' \
  | gzip > "$FILE.partial"
mv "$FILE.partial" "$FILE"

echo "已备份到 $FILE ($(du -h "$FILE" | cut -f1))"

# 只保留最近 14 天的备份
find backups -name 'rterm-*.sql.gz' -mtime +14 -delete
