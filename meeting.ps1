# meeting.ps1 — one-stop launcher for MAP CanvasMeet.
#
# Starts room (socket.io :3002), vite (excalidraw-app :3001), and a
# Cloudflare quick tunnel that gives us HTTPS so window.crypto.subtle
# (E2E collab) and any future getUserMedia (mic/camera) actually work
# across machines. Captures the public trycloudflare.com URL from the
# tunnel's log and copies it to the clipboard — no more squinting at
# three terminal windows.
#
# Cloudflare's trycloudflare API can return 500s during short outages
# (error code 1101). We retry the tunnel up to 3 times before giving
# up + showing a clear "this is Cloudflare's problem, not yours"
# message with ngrok as a fallback path.
#
# Usage from the repo root:
#   .\meeting.ps1          # full demo: room + vite + HTTPS tunnel
#   .\meeting.ps1 -Stop    # kill everything
#
# Each service still opens its own PowerShell window so you can read
# logs and Ctrl+C individually if needed.

param(
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

$repoRoot  = $PSScriptRoot
$toolsDir  = Join-Path $repoRoot "tools"
$roomDir   = Join-Path $repoRoot "room"
$appDir    = Join-Path $repoRoot "excalidraw-app"
$workerDir = Join-Path $repoRoot "worker"
$cf        = Join-Path $toolsDir "cloudflared.exe"
$tunnelLog = Join-Path $env:TEMP "mcm-cloudflared.log"

# --- helpers ------------------------------------------------------------

function Stop-AllServices {
    Get-NetTCPConnection -LocalPort 3001, 3002, 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Host "killed PID=$($_.OwningProcess) on :$($_.LocalPort)" -ForegroundColor DarkGray
        } catch {}
    }
    Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        Write-Host "killed cloudflared PID=$($_.Id)" -ForegroundColor DarkGray
    }
}

function Wait-Port($port, $timeoutSec) {
    $n = 0
    while ($n -lt $timeoutSec) {
        $tc = New-Object System.Net.Sockets.TcpClient
        try {
            $tc.ConnectAsync("127.0.0.1", $port).Wait(500) | Out-Null
            if ($tc.Connected) { $tc.Close(); return $true }
        } catch {}
        $tc.Close()
        Start-Sleep -Seconds 1
        $n++
    }
    return $false
}

# --- stop mode ----------------------------------------------------------

if ($Stop) {
    Stop-AllServices
    Write-Host "all services stopped." -ForegroundColor Green
    return
}

# --- 1. clean previous run ---------------------------------------------

Stop-AllServices
Start-Sleep -Seconds 1
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }

# --- 2. discover LAN IP for the localhost fallback ---------------------

$lanIP = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1).IPAddress

# --- 3. start room (port 3002) -----------------------------------------

Write-Host "starting room (port 3002)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$Host.UI.RawUI.WindowTitle = 'room :3002'; Set-Location '$roomDir'; yarn start:dev"
) | Out-Null

# --- 4. start vite (port 3001) -----------------------------------------

Write-Host "starting vite (port 3001)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$Host.UI.RawUI.WindowTitle = 'vite :3001'; Set-Location '$appDir'; yarn start"
) | Out-Null

# --- 4b. start storage worker (port 8787) ------------------------------
# Cloudflare Worker (R2 + D1) simulated locally via Miniflare — durable
# meeting save/reopen + project folders. No login needed for local dev.
Write-Host "starting storage worker (port 8787)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$Host.UI.RawUI.WindowTitle = 'worker :8787'; Set-Location '$workerDir'; npx wrangler dev --port 8787"
) | Out-Null

# --- 5. wait for both to listen ----------------------------------------

Write-Host "waiting for room :3002..." -NoNewline
if (Wait-Port 3002 30) {
    Write-Host " ready" -ForegroundColor Green
} else {
    Write-Host " TIMEOUT" -ForegroundColor Red
    return
}

Write-Host "waiting for vite :3001 (cold start may take ~30s)..." -NoNewline
if (Wait-Port 3001 120) {
    Write-Host " ready" -ForegroundColor Green
} else {
    Write-Host " TIMEOUT" -ForegroundColor Red
    return
}

# Storage worker is non-fatal: if it's down the meeting still runs, just
# without durable save/reopen. Warn instead of aborting the whole stack.
Write-Host "waiting for worker :8787 (first run downloads workerd)..." -NoNewline
if (Wait-Port 8787 120) {
    Write-Host " ready" -ForegroundColor Green
} else {
    Write-Host " TIMEOUT (storage offline — meeting still works, no persistence)" -ForegroundColor Yellow
}

# --- 6. cloudflared quick tunnel ---------------------------------------
#
# Cloudflare's trycloudflare.com endpoint can return 500/error-code-1101
# during short outages (the response isn't JSON, cloudflared blows up
# parsing it). We retry up to 3 times before giving up — most outages
# clear in <30s. Each retry uses a fresh subprocess + fresh log so we
# only "see" the URL from the successful attempt.

if (-not (Test-Path $cf)) {
    Write-Host "ERROR: cloudflared.exe not found at $cf" -ForegroundColor Red
    Write-Host "Download from https://github.com/cloudflare/cloudflared/releases and drop it in tools/" -ForegroundColor DarkGray
    return
}

function Start-QuickTunnel($logPath) {
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'cloudflared'; & '$cf' tunnel --url http://localhost:3001 --no-autoupdate --protocol http2 2>&1 | Tee-Object -FilePath '$logPath'"
    ) | Out-Null
}

function Wait-TunnelURL($logPath, $timeoutSec) {
    $n = 0
    while ($n -lt $timeoutSec) {
        Start-Sleep -Seconds 1
        if (Test-Path $logPath) {
            $content = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
            if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
                return $matches[0]
            }
            # Hard-fail markers: Cloudflare returned an error response we
            # can't recover from on this attempt. Bail out early so the
            # outer retry loop can spawn a new cloudflared process.
            if ($content -match 'failed to unmarshal quick Tunnel' -or
                $content -match 'error code: 1101') {
                return "RETRY"
            }
        }
        $n++
        Write-Host "." -NoNewline
    }
    return $null
}

$tunnelURL = $null
$maxAttempts = 3
for ($attempt = 1; $attempt -le $maxAttempts -and -not $tunnelURL; $attempt++) {
    if ($attempt -gt 1) {
        Write-Host ""
        Write-Host "cloudflared quick-tunnel API flaked (attempt $($attempt - 1)). Retrying..." -ForegroundColor Yellow
        Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 3
    }

    Write-Host "starting cloudflared quick tunnel (attempt $attempt/$maxAttempts)..." -ForegroundColor Cyan
    Start-QuickTunnel $tunnelLog

    Write-Host "waiting for tunnel URL " -NoNewline
    $result = Wait-TunnelURL $tunnelLog 45
    Write-Host ""
    if ($result -and $result -ne "RETRY") {
        $tunnelURL = $result
    }
}

# --- 8. final summary --------------------------------------------------

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host "  MAP CanvasMeet is up" -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  This machine : http://localhost:3001" -ForegroundColor White
Write-Host "  Storage API  : http://localhost:8787  (R2+D1 local via Miniflare)" -ForegroundColor White

if ($lanIP) {
    Write-Host "  Same Wi-Fi   : http://${lanIP}:3001  (collab broken — no HTTPS)" -ForegroundColor DarkGray
}

if ($tunnelURL) {
    try {
        $tunnelURL | Set-Clipboard
        $clipNote = "  (copied to clipboard)"
    } catch {
        $clipNote = ""
    }
    Write-Host ""
    Write-Host "  Public URL   : $tunnelURL" -ForegroundColor Green
    if ($clipNote) {
        Write-Host $clipNote -ForegroundColor DarkGray
    }
    Write-Host "                 Share this with labmate / phone — HTTPS, collab works." -ForegroundColor DarkGray
} else {
    Write-Host ""
    Write-Host "  Cloudflare quick tunnel failed after $maxAttempts attempts." -ForegroundColor Red
    Write-Host "  This is a transient outage on Cloudflare's side, not your config." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Try again in 1-2 minutes:  .\meeting.ps1" -ForegroundColor DarkGray
    Write-Host "  Or fall back to ngrok:     ngrok http 3001  (separate terminal)" -ForegroundColor DarkGray
    Write-Host "                             https://ngrok.com/download (free, more reliable)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  To stop everything:  .\meeting.ps1 -Stop" -ForegroundColor DarkGray
Write-Host ""
