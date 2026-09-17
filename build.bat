@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required to package the extension.
  exit /b 1
)

call npm run check
if errorlevel 1 exit /b 1
call npm test
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1

echo.
echo Extension package written to dist.
