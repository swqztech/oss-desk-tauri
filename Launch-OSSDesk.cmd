@echo off
chcp 65001 >nul
REM 正式版（内置界面，读 %APPDATA%\oss\accounts.json）。不要用 cargo run / tauri dev，否则会连 localhost 报错。
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
echo 未找到正式版 oss_desk.exe
echo 请先执行: npm run build:client
echo 账号可从 Electron 导入: node scripts/import-electron-accounts.mjs
pause
