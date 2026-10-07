@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js saknas. Installera Node.js 22.12 eller senare och prova igen.
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
