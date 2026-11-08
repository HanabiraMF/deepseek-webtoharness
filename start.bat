@echo off
chcp 65001 >nul
title DeepSeek WebtoHarness - Local Server
cd /d "%~dp0"

echo ================================================
echo   DeepSeek WebtoHarness - Local Server
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Please install from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node version:
node -v
echo.
echo After starting, a Token will be printed below.
echo Copy it into the left panel of DeepSeek.
echo Close this window to stop the server.
echo.

node server.js

if errorlevel 1 (
    echo.
    echo [ERROR] Server exited abnormally. See message above.
    echo Common cause: port 39999 in use.
    echo Fix: set DS_AGENT_PORT=40000 ^&^& start.bat
)

echo.
pause
