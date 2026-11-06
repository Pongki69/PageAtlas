@echo off
setlocal EnableExtensions DisableDelayedExpansion
title PageAtlas

pushd "%~dp0"
if errorlevel 1 (
  echo Could not open the PageAtlas folder.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.18 or newer from https://nodejs.org, then run this file again.
  popd
  pause
  exit /b 1
)

if /i "%~1"=="--menu" goto menu
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "server\launcher-window.ps1"
set "atlasExitCode=%errorlevel%"
popd
exit /b %atlasExitCode%

:menu
echo.
echo PageAtlas
echo   1. Start / open PageAtlas
echo   2. Restart server with the latest changes
echo   3. Stop server
echo   4. Close this menu
echo.
echo Stop and restart clear captures and reviews. Export anything you want to keep first.
choice /c 1234 /n /m "Choose 1, 2, 3, or 4: "
if errorlevel 4 goto done
if errorlevel 3 goto stop
if errorlevel 2 goto restart

:start
node "server\launch.mjs" --background
goto menu

:restart
node "server\launch.mjs" --restart --background
goto menu

:stop
node "server\launch.mjs" --stop
goto menu

:done
popd
exit /b 0
