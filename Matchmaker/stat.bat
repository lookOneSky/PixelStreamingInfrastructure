@echo off
setlocal
set "matchmakerDir=%~dp0.daspixel-runtime"
if defined DASPIXEL_MATCHMAKER_DIR (
    set "matchmakerDir=%DASPIXEL_MATCHMAKER_DIR%"
) else (
    call :prepare || exit /b 1
)
if not exist "%matchmakerDir%\matchmaker.js" (
    echo Matchmaker was not found in "%matchmakerDir%". 1>&2
    exit /b 1
)
pushd "%matchmakerDir%" || exit /b 1
node -e "for (const name of Object.keys(require('./package.json').dependencies)) require('./node_modules/' + name)" >nul 2>&1
if errorlevel 1 (
    call npm ci --prefix . --workspaces=false --no-audit --no-fund
    if errorlevel 1 (
        popd
        exit /b 1
    )
)
node matchmaker.js %*
set "result=%errorlevel%"
popd
exit /b %result%

:prepare
if exist "%matchmakerDir%\.source-ready" exit /b 0
if not exist "%matchmakerDir%\" mkdir "%matchmakerDir%" || exit /b 1
set "sourceCommit=96d41f1469845363d5f92fd0488bfe994097c0ec"
git -C "%~dp0." cat-file -e "%sourceCommit%:Matchmaker" 2>nul
if errorlevel 1 (
    git -C "%~dp0." fetch --no-tags --depth=1 origin %sourceCommit% || exit /b 1
)
set "archive=%matchmakerDir%\.source-%RANDOM%-%RANDOM%.tar"
git -C "%~dp0.." archive --output="%archive%" "%sourceCommit%:Matchmaker" matchmaker.js modules html package.json package-lock.json config.json || exit /b 1
tar -xf "%archive%" -C "%matchmakerDir%" --exclude config.json || goto prepareFailed
if not exist "%matchmakerDir%\config.json" (
    tar -xOf "%archive%" config.json > "%archive%.config" || goto prepareFailed
    ren "%archive%.config" config.json
    if not exist "%matchmakerDir%\config.json" goto prepareFailed
)
type nul > "%matchmakerDir%\.source-ready" || goto prepareFailed
del /q "%archive%"
exit /b 0

:prepareFailed
if exist "%archive%.config" del /q "%archive%.config"
if exist "%archive%" del /q "%archive%"
exit /b 1
