@echo off
rem Called by the launch and export scripts. Returns F0_ADB to the caller.
set "F0_ADB="
if defined F0_SCRCPY_DIR if exist "%F0_SCRCPY_DIR%adb.exe" set "F0_ADB=%F0_SCRCPY_DIR%adb.exe"
if not defined F0_ADB if exist "%~dp0scrcpy\adb.exe" set "F0_ADB=%~dp0scrcpy\adb.exe"
if not defined F0_ADB if exist "%~dp0..\scrcpy\adb.exe" set "F0_ADB=%~dp0..\scrcpy\adb.exe"
if not defined F0_ADB if exist "%~dp0..\adb.exe" set "F0_ADB=%~dp0..\adb.exe"
if not defined F0_ADB for /f "delims=" %%I in ('where adb.exe 2^>nul') do if not defined F0_ADB set "F0_ADB=%%I"
if not defined F0_ADB if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "F0_ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not defined F0_ADB if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools\adb.exe" set "F0_ADB=%ANDROID_HOME%\platform-tools\adb.exe"
if not defined F0_ADB exit /b 1
exit /b 0
