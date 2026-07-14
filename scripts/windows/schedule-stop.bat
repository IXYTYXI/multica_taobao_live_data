@echo off
setlocal EnableExtensions
REM 定时停止：建议任务计划程序每天 00:06 调用
REM 用法: scripts\windows\schedule-stop.bat

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "PROJECT_DIR=%%~fI"
cd /d "%PROJECT_DIR%"

for /f "delims=" %%i in ('node -e "require('dotenv').config({path:require('path').join(process.argv[1],'.env')}); process.stdout.write(process.env.SCHEDULE_PM2_NAME||'taobao-live')" "%PROJECT_DIR%"') do set "PM2_NAME=%%i"

pm2 describe %PM2_NAME% >nul 2>&1
if not errorlevel 1 (
  pm2 stop %PM2_NAME%
) else (
  echo [schedule] %PM2_NAME% 未在 pm2 中运行，跳过 stop
)

REM 关闭本工具 chrome-data 对应的 Chrome（不影响日常浏览器）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-data*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [schedule] 已停止 taobao-live
exit /b 0
