@echo off
chcp 65001 >nul
title DeepSeek WebtoHarness - 本地服务
cd /d "%~dp0"

echo ================================================
echo   DeepSeek WebtoHarness 本地服务启动中...
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node 版本：
node -v
echo.
echo 提示：启动后会打印访问 Token，请复制到网页左侧面板。
echo       关闭本窗口即停止服务。
echo.

node server.js

if errorlevel 1 (
    echo.
    echo [服务异常退出] 请检查上方报错信息。
    echo 常见原因：端口 39999 被占用（可设置 DS_AGENT_PORT 换端口）
)

echo.
pause
