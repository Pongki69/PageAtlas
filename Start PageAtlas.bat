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

node "server\launch.mjs"
set "atlasExitCode=%errorlevel%"
popd

if not "%atlasExitCode%"=="0" (
  echo.
  echo PageAtlas could not start. The details are shown above.
  pause
)

exit /b %atlasExitCode%
