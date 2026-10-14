@echo off
setlocal
cd /d "%~dp0"
title Inspection Platform - Phone Access Repair
powershell.exe -NoProfile -File "%~dp0tools\configure-lan-firewall.ps1"
set "result=%errorlevel%"
echo.
if not "%result%"=="0" (
  echo Firewall repair did not complete. Review the error above.
) else (
  echo Firewall repair completed. Retry the HTTP connection guide on your phone.
)
echo.
pause
exit /b %result%
