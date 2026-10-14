@echo off
setlocal
cd /d "%~dp0"
title Inspection Platform - LAN Startup
powershell.exe -NoProfile -File "%~dp0tools\start-lan.ps1"
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo.
  echo Startup failed. Review the error above and service-*.stderr.log files.
) else (
  echo.
  echo The system is running. Keep this computer powered on for LAN access.
)
echo.
pause
exit /b %result%
