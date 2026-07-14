#!/bin/bash
# 定时启动：建议 cron 每天 08:00 调用
# 用法: /path/to/scripts/macos/schedule-start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH:-}"
PM2="$(command -v pm2 || true)"

PM2_NAME="taobao-live"
if [ -f "$PROJECT_DIR/.env" ]; then
  line=$(grep -E '^SCHEDULE_PM2_NAME=' "$PROJECT_DIR/.env" | tail -1 | sed 's/^SCHEDULE_PM2_NAME=//' | tr -d '\r"' | xargs)
  [ -n "$line" ] && PM2_NAME="$line"
fi

if [ -z "$PM2" ]; then
  echo "[schedule] 错误: 未找到 pm2，请先执行 npm install -g pm2"
  exit 1
fi

if "$PM2" describe "$PM2_NAME" &>/dev/null; then
  "$PM2" restart "$PM2_NAME"
else
  "$PM2" start "$PROJECT_DIR/src/index.js" --name "$PM2_NAME"
fi

"$PM2" save
echo "[schedule] $(date '+%Y-%m-%d %H:%M:%S') 已启动 $PM2_NAME（目录: $PROJECT_DIR）"
