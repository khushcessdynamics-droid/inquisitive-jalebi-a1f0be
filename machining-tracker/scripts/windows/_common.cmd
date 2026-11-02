@echo off
rem Shared checks for the CESS backup scripts. Sets ROOT and CLI.
set "ROOT=%~dp0..\.."
set "CLI=%ROOT%\tools\backup\src\cli.ts"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version 22 or newer from https://nodejs.org and run this again.
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 (
  echo Node.js 22.18 or newer is required. Please update Node.js from https://nodejs.org
  exit /b 1
)
if not exist "%ROOT%\node_modules\pg" (
  echo Installing the backup components - one time only, needs internet...
  pushd "%ROOT%"
  call npm ci --omit=dev --no-audit --no-fund
  popd
)
exit /b 0
