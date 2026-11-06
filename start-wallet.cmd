@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install a supported Node.js release first. Tested with Node 22.16.0.
  pause
  exit /b 1
)
node wallet\cli.mjs start
pause
