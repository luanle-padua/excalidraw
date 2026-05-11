# Quick-run helper: starts room, vite, and (optional) cloudflared in
# separate PowerShell windows. Run this from the repo root:
#
#   .\start.ps1            # room + vite only (localhost / LAN)
#   .\start.ps1 -Tunnel    # room + vite + Cloudflare quick tunnel
#
# Each service opens its own window so you can read logs and Ctrl+C
# individually. To stop everything at once, just close the three windows
# (or use the matching kill block at the bottom of this script via
# `.\start.ps1 -Stop`).

param(
    [switch]$Tunnel,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$toolsDir = Join-Path $repoRoot "tools"
$roomDir  = Join-Path $repoRoot "room"
$appDir   = Join-Path $repoRoot "excalidraw-app"
$cf       = Join-Path $toolsDir "cloudflared.exe"

function Stop-AppPorts {
    Get-NetTCPConnection -LocalPort 3001,3002 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
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

if ($Stop) {
    Stop-AppPorts
    Write-Host "all services stopped." -ForegroundColor Green
    return
}

# --- 1. clean up any previous run ---------------------------------------
Stop-AppPorts
Start-Sleep -Seconds 1

# --- 2. discover LAN IP for cross-device URLs ---------------------------
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

Write-Host "waiting for room :3002..." -NoNewline
if (Wait-Port 3002 30) { Write-Host " ready" -ForegroundColor Green } else { Write-Host " TIMEOUT" -ForegroundColor Red; return }

Write-Host "waiting for vite :3001 (cold start may take ~30s)..." -NoNewline
if (Wait-Port 3001 120) { Write-Host " ready" -ForegroundColor Green } else { Write-Host " TIMEOUT" -ForegroundColor Red; return }

# --- 6. tunnel (optional) ----------------------------------------------
if ($Tunnel) {
    if (-not (Test-Path $cf)) {
        Write-Host "ERROR: $cf not found. Download cloudflared.exe to tools/ first." -ForegroundColor Red
        return
    }
    Write-Host "starting cloudflared quick tunnel..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'cloudflared'; & '$cf' tunnel --url http://localhost:3001 --no-autoupdate --protocol http2"
    ) | Out-Null
    Write-Host "(URL will appear in the cloudflared window after a few seconds)" -ForegroundColor DarkGray
}

# --- 7. print share URLs ------------------------------------------------
Write-Host ""
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host "  Meeting Canvas is up" -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  This machine : http://localhost:3001" -ForegroundColor White
if ($lanIP) {
    Write-Host "  Same Wi-Fi   : http://${lanIP}:3001  (phone / labmate)" -ForegroundColor White
}
if ($Tunnel) {
    Write-Host "  Public       : check the 'cloudflared' window for the trycloudflare.com URL" -ForegroundColor White
}
Write-Host ""
Write-Host "  To stop everything:  .\start.ps1 -Stop" -ForegroundColor DarkGray
Write-Host ""
