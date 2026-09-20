@echo off
rem Builds bin\BotHost.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
rem No SDK, no NuGet, no download: csc.exe is always present under %WINDIR%\Microsoft.NET.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo Cannot find csc.exe at "%CSC%"
  exit /b 2
)
if not exist "%~dp0..\bin" mkdir "%~dp0..\bin"
"%CSC%" /nologo /optimize+ /platform:x64 /target:exe /out:"%~dp0..\bin\BotHost.exe" "%~dp0BotHost.cs"
if errorlevel 1 exit /b 1
echo Built %~dp0..\bin\BotHost.exe
