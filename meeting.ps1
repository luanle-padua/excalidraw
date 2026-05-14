# meeting.ps1 — one-stop launcher for MAP CanvasMeet.
#
# Starts room (socket.io :3002), vite (excalidraw-app :3001), and a
# Cloudflare quick tunnel that gives us HTTPS so window.crypto.subtle
# (E2E collab) and any future getUserMedia (mic/camera) actually work
# across machines. Captures the public trycloudflare.com URL from the
# tunnel's log and copies it to the clipboard — no more squinting at
# three terminal windows.
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
$cf        = Join-Path $toolsDir "cloudflared.exe"
$tunnelLog = Join-Path $env:TEMP "mcm-cloudflared.log"

# --- helpers ------------------------------------------------------------

function Stop-AllServices {
    Get-NetTCPConnection -LocalPort 3001, 3002 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
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

# --- 6. cloudflared quick tunnel ---------------------------------------

if (-not (Test-Path $cf)) {
    Write-Host "ERROR: cloudflared.exe not found at $cf" -ForegroundColor Red
    Write-Host "Download from https://github.com/cloudflare/cloudflared/releases and drop it in tools/" -ForegroundColor DarkGray
    return
}

Write-Host "starting cloudflared quick tunnel (HTTPS)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$Host.UI.RawUI.WindowTitle = 'cloudflared'; & '$cf' tunnel --url http://localhost:3001 --no-autoupdate --protocol http2 2>&1 | Tee-Object -FilePath '$tunnelLog'"
) | Out-Null

# --- 7. capture the public URL from the tunnel's log -------------------

Write-Host "waiting for tunnel URL " -NoNewline
$tunnelURL = $null
$tries = 0
while ($tries -lt 60 -and -not $tunnelURL) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $tunnelURL = $matches[0]
        }
    }
    $tries++
    Write-Host "." -NoNewline
}
Write-Host ""

# --- 8. final summary --------------------------------------------------

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host "  MAP CanvasMeet is up" -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  This machine : http://localhost:3001" -ForegroundColor White

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
    Write-Host "  Tunnel URL not found within 60s." -ForegroundColor Red
    Write-Host "  Check the 'cloudflared' window for the URL manually." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  To stop everything:  .\meeting.ps1 -Stop" -ForegroundColor DarkGray
Write-Host ""
