@echo off
rem Backs up the local git state BEFORE a push, so a bad push, a rewrite or a damaged repo can be undone.
rem Two layers per repo: a branch at the current head (instant, in-repo) and a bundle of every ref
rem (offline, outside the repo, restorable with "git clone <bundle>" even if the repo is lost).
rem Run with no arguments before every push. Keeps the 10 newest bundles per repo.
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "OUT=_git-backups"
if not exist "%OUT%" mkdir "%OUT%"

for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd-HHmmss')"`) do set "STAMP=%%s"
if not defined STAMP set "STAMP=unstamped"

rem fork is the pushed repo; server is local only and has no remote at all, so it matters more
call :backup fork fork
call :backup server server

echo.
echo Backups in %CD%\%OUT%:
dir /b /o-d "%OUT%\*.bundle" 2>nul
echo.
echo Restore a whole repo:   git clone %OUT%\^<name^>-^<stamp^>.bundle restored
echo Undo a push:            git reset --hard backup/pre-push-^<stamp^>   ^(inside that repo^)
goto :eof

:backup
rem %1 = folder, %2 = label
if not exist "%~1\.git" (
  echo [%~2] no git repo at %~1, skipped
  goto :eof
)
git -C "%~1" branch "backup/pre-push-%STAMP%" >nul 2>&1
if errorlevel 1 (
  echo [%~2] WARNING: could not create backup/pre-push-%STAMP% ^(detached head or duplicate^)
) else (
  echo [%~2] branch backup/pre-push-%STAMP% at current head
)
git -C "%~1" bundle create "%CD%\%OUT%\%~2-%STAMP%.bundle" --all >nul 2>&1
if errorlevel 1 (
  echo [%~2] ERROR: bundle failed, DO NOT PUSH until this is understood
) else (
  for %%f in ("%OUT%\%~2-%STAMP%.bundle") do echo [%~2] bundle %%~nxf, %%~zf bytes
)
rem A bundle holds committed history only, and the live gameplay files are often uncommitted:
rem also save the working-tree diff and the status, so uncommitted work is recoverable too
git -C "%~1" diff HEAD > "%OUT%\%~2-%STAMP%.patch" 2>nul
git -C "%~1" status --porcelain > "%OUT%\%~2-%STAMP%.status.txt" 2>nul
for %%f in ("%OUT%\%~2-%STAMP%.patch") do echo [%~2] working-tree patch %%~zf bytes ^(apply with: git apply^)

rem Keep the 10 newest sets for this repo
powershell -NoProfile -Command "foreach ($p in '*.bundle','*.patch','*.status.txt') { Get-ChildItem (Join-Path '%OUT%' ('%~2-' + $p)) -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue }"
goto :eof
