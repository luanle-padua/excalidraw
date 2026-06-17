@echo off
REM Canvas M - run LOCAL (isolated from prod).
REM Worker = wrangler dev (local D1/R2/DO). App points to localhost:8787.
REM This file NEVER runs `wrangler deploy` or `migrate.mjs --remote`.
cd /d "%~dp0"

echo.
echo  Canvas M - LOCAL dev (safe, does not touch prod)
echo.

if not exist "worker\.dev.vars" echo  [!] Missing worker\.dev.vars (local secrets) - login/AI/Daily may fail. Create it from .dev.vars.example.

echo  [1/3] Migrating LOCAL D1 ...
pushd worker
call node migrate.mjs
popd

echo  [2/3] Starting WORKER (wrangler dev @ 8787) ...
start "Canvas M WORKER local" cmd /k "cd /d %~dp0worker && npx wrangler dev"

echo  Waiting 6s for the worker ...
timeout /t 6 /nobreak >nul

echo  [3/3] Starting APP (yarn start @ 3000) ...
start "Canvas M APP local" cmd /k "cd /d %~dp0 && yarn start"

echo.
echo  Opened 2 windows: WORKER (8787) + APP (3000).
echo  Open your browser at:  http://localhost:3000
echo  LOCAL data only. Close the 2 windows to stop.
echo.
pause
