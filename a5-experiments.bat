@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 24 或更高版本，再重新打开启动器。
  pause
  exit /b 1
)
node "%~dp0scripts\experiment-launcher.mjs"
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
