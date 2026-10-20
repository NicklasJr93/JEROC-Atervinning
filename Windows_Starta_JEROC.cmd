@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js saknas. Installera Node.js 24 LTS, minst 24.19.0, och prova igen.
  pause
  exit /b 1
)
node "scripts\start-demo.mjs"
if errorlevel 1 (
  echo.
  echo Appen kunde inte starta. Las felet ovan.
  pause
  exit /b 1
)
pause
