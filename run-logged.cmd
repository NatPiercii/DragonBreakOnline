@echo off
rem Runs the server with stdout/stderr in server.log and appends how and when it stopped to server-exit.log,
rem so a silent stop can be told apart: a native crash leaves a large negative code (e.g. -1073741819 access
rem violation), a kill from outside leaves 1, a clean stop 0.
rem The previous run is kept as _server-logs\server-<when it ended>.log; a crash used to be overwritten by
rem the next start before anyone could read it. Logs older than 14 days are deleted.
cd /d "%~dp0"
if not exist "_server-logs" mkdir "_server-logs"
if exist "server.log" (
  set "stamp="
  for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "(Get-Item 'server.log').LastWriteTime.ToString('yyyyMMdd-HHmmss')"`) do set "stamp=%%s"
  if not defined stamp set "stamp=previous"
  call move /y "server.log" "_server-logs\server-%%stamp%%.log" >nul
)
echo %date% %time% start >> server-exit.log
node dist_back/skymp5-server.js > server.log 2>&1
echo %date% %time% exit code %ERRORLEVEL% >> server-exit.log
rem Purge after the run so nothing overwrites node's exit code
forfiles /p "_server-logs" /m "server-*.log" /d -14 /c "cmd /c del @path" >nul 2>&1
