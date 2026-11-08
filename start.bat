
@echo off
title DeepSeek Local Agent Server
cd /d "%~dp0"
echo 正在启动本地桥接服务...
echo 当前工作目录: %cd%
node server.js
pause
