@echo off
setlocal EnableExtensions
REM 定时启动：建议任务计划程序每天 08:00 调用
REM 用法: scripts\windows\schedule-start.bat

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "PROJECT_DIR=%%~fI"
cd /d "%PROJECT_DIR%"

where pm2 >nul 2>&1
if errorlevel 1 (
  echo [schedule] 错误: 未找到 pm2，请先执行 npm install -g pm2
  exit /b 1
)

for /f "delims=" %%i in ('node -e "require('dotenv').config({path:require('path').join(process.argv[1],'.env')}); process.stdout.write(process.env.SCHEDULE_PM2_NAME||'taobao-live')" "%PROJECT_DIR%"') do set "PM2_NAME=%%i"

pm2 describe %PM2_NAME% >nul 2>&1
if errorlevel 1 (
  pm2 start npm --name %PM2_NAME% -- start
) else (
  pm2 restart %PM2_NAME%
)

pm2 save
echo [schedule] 已启动 %PM2_NAME%（目录: %PROJECT_DIR%）
exit /b 0
