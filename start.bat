@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-server.ps1" -Action Start %*
exit /b %ERRORLEVEL%
