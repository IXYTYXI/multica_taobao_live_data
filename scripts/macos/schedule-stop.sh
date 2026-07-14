#!/bin/bash
# 定时停止：建议 cron 每天 00:06 调用（发送 SIGTERM，会保存 dedup/outbox）
# 用法: /path/to/scripts/macos/schedule-stop.sh
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

if [ -n "$PM2" ] && "$PM2" describe "$PM2_NAME" &>/dev/null; then
  "$PM2" stop "$PM2_NAME"
else
  echo "[schedule] $PM2_NAME 未在 pm2 中运行，跳过 stop"
fi

# 关闭本工具 chrome-data 目录对应的 Chrome（不影响日常浏览器）
pkill -f "${PROJECT_DIR}/chrome-data" 2>/dev/null || true

echo "[schedule] $(date '+%Y-%m-%d %H:%M:%S') 已停止 $PM2_NAME"
