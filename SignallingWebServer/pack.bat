@echo off
setlocal
set "out=%~dp0..\..\Pack\SignallingWebServer"
if not "%~1"=="" set "out=%~f1"
cd /d "%~dp0.." || exit /b 1
call npm run build:signalling || exit /b 1
cd SignallingWebServer || exit /b 1
call npx --yes esbuild@0.25.12 dist/index.js --bundle --platform=node --target=node22 --outfile="%out%\app.cjs" --metafile=dist/meta.json || exit /b 1
if not exist "%out%\config.json" copy /y config.json "%out%\config.json" >nul || exit /b 1
if not exist "%out%\apidoc\" mkdir "%out%\apidoc" || exit /b 1
copy /y apidoc\api-definition-base.yml "%out%\apidoc\" >nul || exit /b 1
if exist www\ xcopy www "%out%\www\" /e /i /y >nul || exit /b 1
exit /b 0
