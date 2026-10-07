@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js saknas. Installera Node.js 24 LTS och prova igen.
  pause
  exit /b 1
)
node "scripts\start-expo.mjs"
if errorlevel 1 (
  echo.
  echo Expo-demon kunde inte starta. Las felet ovan.
  pause
  exit /b 1
)
pause
