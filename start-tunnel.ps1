# Mo Cloudflare Quick Tunnel cho app dev (port 3001).
# Chay sau khi room va app da start o 2 terminal khac.
#
# Yeu cau (tat ca path tinh tu repo root):
#   - Terminal 1: cd room && yarn start:dev          (lang nghe :3002)
#   - Terminal 2: cd excalidraw-app && yarn start    (lang nghe :3001)
#   - Terminal 3 (cua script nay): chay script de tao tunnel
#
# Script in URL https cong khai cho ban share team.

$ErrorActionPreference = "Stop"

$tools = Join-Path $PSScriptRoot "tools"
$cf = Join-Path $tools "cloudflared.exe"

if (-not (Test-Path $cf)) {
    Write-Host "ERROR: $cf khong ton tai." -ForegroundColor Red
    Write-Host "       tools/ duoc gitignore - tai cloudflared.exe ve thu muc tools/ tu" -ForegroundColor Yellow
    Write-Host "       https://github.com/cloudflare/cloudflared/releases/latest" -ForegroundColor Yellow
    exit 1
}

# Kiem tra port 3001 (app) co dang listen khong
$portCheck = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if (-not $portCheck) {
    Write-Host "WARN: Khong thay process nao listen tren port 3001." -ForegroundColor Yellow
    Write-Host "      Hay chay 'yarn start' trong excalidraw-app/ truoc." -ForegroundColor Yellow
    Write-Host ""
}

$portCheck2 = Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue
if (-not $portCheck2) {
    Write-Host "WARN: Khong thay process nao listen tren port 3002 (room)." -ForegroundColor Yellow
    Write-Host "      Hay chay 'yarn start:dev' trong room/ truoc." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Dang mo Cloudflare Quick Tunnel toi http://localhost:3001 ..." -ForegroundColor Cyan
Write-Host "(URL tunnel se hien sau vai giay; Ctrl+C de dung)" -ForegroundColor DarkGray
Write-Host ""

# Cloudflared in URL ra stderr; dung 2>&1 de bat het
& $cf tunnel --url http://localhost:3001 2>&1
