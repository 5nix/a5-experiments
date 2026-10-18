@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title F0-photo - Start and preview

rem Locate an existing complete scrcpy distribution; do not download executables.
set "F0_SCRCPY="
if exist "%~dp0tools\scrcpy\scrcpy.exe" set "F0_SCRCPY=%~dp0tools\scrcpy\scrcpy.exe"
if not defined F0_SCRCPY if exist "%~dp0scrcpy\scrcpy.exe" set "F0_SCRCPY=%~dp0scrcpy\scrcpy.exe"
if not defined F0_SCRCPY if exist "%~dp0scrcpy.exe" set "F0_SCRCPY=%~dp0scrcpy.exe"
if not defined F0_SCRCPY for /f "delims=" %%I in ('where scrcpy.exe 2^>nul') do if not defined F0_SCRCPY set "F0_SCRCPY=%%I"
if not defined F0_SCRCPY goto missing_scrcpy
for %%I in ("%F0_SCRCPY%") do set "F0_SCRCPY_DIR=%%~dpI"

call "%~dp0tools\find_adb.bat"
if not defined F0_ADB goto missing_adb

rem Use the same ADB binary for this script and scrcpy. ANDROID_SERIAL is honored by both.
set "ADB=%F0_ADB%"
"%F0_ADB%" get-state >nul 2>nul
if errorlevel 1 goto device_error
"%F0_ADB%" shell pm path com.example.f0photo.main 2>nul | findstr /b /c:"package:" >nul
if errorlevel 1 goto missing_app

rem Remove Android's persistent wait-for-debugger setting before normal launch.
echo 正在解除调试等待并启动 F0-photo……
"%F0_ADB%" shell am clear-debug-app
if errorlevel 1 goto debug_error
rem This experience has no result data; start from its instructions on every script launch.
"%F0_ADB%" shell am force-stop com.example.f0photo.main
if errorlevel 1 goto start_error
set "F0_LAUNCH_LOG=%TEMP%\f0-launch-%RANDOM%-%RANDOM%.log"
"%F0_ADB%" shell am start -W -n com.example.f0photo.main/com.example.hello.MainActivity >"%F0_LAUNCH_LOG%" 2>&1
set "F0_LAUNCH_RC=%ERRORLEVEL%"
type "%F0_LAUNCH_LOG%"
findstr /b /c:"Error" /c:"Exception" "%F0_LAUNCH_LOG%" >nul
if not errorlevel 1 set "F0_LAUNCH_RC=1"
del "%F0_LAUNCH_LOG%" >nul 2>nul
if not "%F0_LAUNCH_RC%"=="0" goto start_error

rem Modern scrcpy redirects device audio by default. Keep the completion beeps on the glasses.
rem Older versions without audio forwarding do not recognize --no-audio.
set "F0_AUDIO_OPTION="
"%F0_SCRCPY%" --help 2>nul | findstr /c:"--no-audio" >nul
if not errorlevel 1 set "F0_AUDIO_OPTION=--no-audio"
echo 正在打开640×480单眼预览及电脑控制窗口。
echo 请在电脑控制窗口按空格开始；1返回上一条，2进入下一条，第12条按2结束。
rem The preview cannot steal experiment key events or redirect completion audio.
start "F0 preview" "%F0_SCRCPY%" --crop 640:480:0:0 --no-control %F0_AUDIO_OPTION%
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\computer_control.ps1"
if errorlevel 1 goto control_error
exit /b 0

:missing_scrcpy
echo 未找到 scrcpy.exe。
echo 请将完整的 scrcpy Windows 解压文件放入 tools\scrcpy 文件夹，或将其目录加入 PATH。
echo 需要保留同一目录中的 DLL、adb 和 scrcpy-server 等配套文件。
echo 官方下载地址：https://github.com/Genymobile/scrcpy/releases
goto failed
:missing_adb
echo 未找到 adb.exe。请保留 scrcpy 安装包中的 adb.exe，或将 Android SDK 的 platform-tools 加入 PATH。
goto failed
:device_error
echo 未检测到唯一可用的眼镜。请连接USB、允许USB调试并检查授权提示。
echo 多设备时，请只连接目标眼镜，或事先设置 ANDROID_SERIAL。
"%F0_ADB%" devices
goto failed
:missing_app
echo 眼镜尚未安装本应用。请先用 Android Studio 将本工程运行到眼镜，再双击本脚本。
goto failed
:start_error
echo 眼镜程序启动失败，请查看上方错误并确认安装的是本次更新后的工程。
goto failed
:debug_error
echo 无法解除调试等待。请在眼镜开发者选项关闭“等待调试器”，并用 Android Studio 的 Run 而非 Debug 启动。
goto failed
:control_error
echo 电脑控制未正常运行，请查看上方错误；确认已将本次更新重新部署到眼镜。
:failed
pause
exit /b 1
