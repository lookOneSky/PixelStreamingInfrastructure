@echo off
setlocal
cd /d "%~dp0.." || exit /b 1
if not exist "SignallingWebServer\dist\index.js" (
    call npm run build:signalling || exit /b 1
)
cd SignallingWebServer || exit /b 1
node dist\index.js %*
