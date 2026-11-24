@echo off
setlocal
cd /d "%~dp0..\.." || exit /b 1
call npm run build:cjs -w Common || exit /b 1
call npm run build:esm -w Common || exit /b 1
call npm run build -w Frontend/library
