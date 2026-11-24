@echo off
setlocal
call "%~dp0..\library\build.bat" || exit /b 1
cd /d "%~dp0" || exit /b 1
call npm run build
