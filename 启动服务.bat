@echo off
@chcp 65001 > nul
cd /d "%~dp0"

echo ==========================================
echo   名片扫描助手 - 启动本地服务
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装 Node.js
  echo 下载地址: https://nodejs.org/
  pause
  exit /b 1
)

echo 正在启动服务...
echo 启动后请在浏览器访问: http://localhost:3200
echo.
start "" http://localhost:3200
node server.js
pause
