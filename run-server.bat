@echo off
setlocal
rem Starts the OpenLine server. Settings and secrets live in server\.env (not committed).
rem Usage: run-server.bat            build, open Tailscale Funnel, start the server
rem        run-server.bat nofunnel   same, but keep the server private (no Funnel)

cd /d "%~dp0server"

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Created server\.env from the example.
  echo Edit it ^(at least HTTP_GATEWAY_API_KEY and PUBLIC_URL^), then run this again.
  notepad ".env"
  exit /b 1
)

findstr /r /c:"^HTTP_GATEWAY_API_KEY=change-me" ".env" >nul && (
  echo HTTP_GATEWAY_API_KEY in server\.env is still "change-me". Set a long random key first.
  exit /b 1
)

where node >nul 2>&1 || (
  echo Node.js 20 or newer is required: https://nodejs.org
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install || exit /b 1
)

echo Building...
call npm run build --silent || exit /b 1

if /i not "%~1"=="nofunnel" (
  where tailscale >nul 2>&1 && (
    echo Opening Tailscale Funnel on port 8787...
    tailscale funnel --bg 8787
  ) || echo Tailscale not found; skipping Funnel. Phones need another tunnel, see README.
)

echo.
echo Console: http://localhost:8787/
echo Press Ctrl+C to stop.
echo.
node --disable-warning=ExperimentalWarning --env-file=.env dist/index.js
