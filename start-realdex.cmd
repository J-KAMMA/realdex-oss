@echo off
cd /d "%~dp0"
node app\cli.mjs start %*
if errorlevel 1 pause
