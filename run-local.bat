@echo off
chcp 65001 >nul
REM ============================================================
REM  Canvas M — CHAY LOCAL AN TOAN (tach hoan toan voi PROD)
REM ------------------------------------------------------------
REM  - Worker chay bang `wrangler dev`  -> D1 / R2 / Durable Object
REM    deu la ban LOCAL (KHONG dung du lieu that tren prod).
REM  - App dev server tro vao Worker local (http://localhost:8787)
REM    nho file excalidraw-app\.env.development.local.
REM  - File nay KHONG bao gio chay `wrangler deploy` hay
REM    `migrate.mjs --remote` -> tuyet doi khong cham prod.
REM
REM  Muon DAY LEN LIVE thi lam tay (co y): xem docs\runbooks\deploy.md
REM ============================================================
cd /d "%~dp0"

echo.
echo  ============================================
echo   Canvas M  -  moi truong LOCAL (an toan)
echo  ============================================
echo.

REM --- 0. Canh bao neu thieu secret local ---
if not exist "worker\.dev.vars" (
  echo  [!] Thieu worker\.dev.vars (secret local: SUPABASE_URL/KEY, DAILY, GEMINI, DEEPGRAM...).
  echo      Login/AI/Daily se loi cho toi khi co file nay. Tao tu .dev.vars.example.
  echo.
)

REM --- 1. Ap migration vao D1 LOCAL (khong --remote) ---
echo  [1/3] Ap migration vao D1 LOCAL...
pushd worker
call node migrate.mjs
popd
echo.

REM --- 2. Mo Worker LOCAL (wrangler dev, cong 8787) ---
echo  [2/3] Mo Worker LOCAL (wrangler dev @ 8787)...
start "Canvas M - WORKER (local)" cmd /k "cd /d "%~dp0worker" && npx wrangler dev"

echo       Cho Worker khoi dong (6s)...
timeout /t 6 /nobreak >nul

REM --- 3. Mo App dev server (tro vao localhost:8787) ---
echo  [3/3] Mo App (yarn start @ 3000)...
start "Canvas M - APP (local)" cmd /k "cd /d "%~dp0" && yarn start"

echo.
echo  ============================================
echo   Da mo 2 cua so:
echo     - WORKER (local)  : http://localhost:8787
echo     - APP    (local)  : http://localhost:3000
echo.
echo   Mo trinh duyet:  http://localhost:3000
echo   Du lieu LOCAL, KHONG dung prod. Dong 2 cua so de tat.
echo  ============================================
echo.
pause
