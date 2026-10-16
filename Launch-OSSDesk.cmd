@echo off
REM Launch OSS Desk without a console window; prefer the NSIS shortcut after install.
set "EXE=%~dp0src-tauri\target\release\oss_desk.exe"
if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)
set "INST=%LocalAppData%\Programs\OSSDesk\oss_desk.exe"
if exist "%INST%" (
  start "" "%INST%"
  exit /b 0
)
echo oss_desk.exe not found. Run: npm run build:client
pause
