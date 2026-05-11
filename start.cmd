@echo off
REM Double-click launcher: runs start.ps1 with execution policy bypass.
REM Pass /tunnel to also start a Cloudflare quick tunnel.
REM Pass /stop  to kill everything.

setlocal
set ARGS=
if /I "%1"=="/tunnel" set ARGS=-Tunnel
if /I "%1"=="/stop"   set ARGS=-Stop
if /I "%1"=="tunnel"  set ARGS=-Tunnel
if /I "%1"=="stop"    set ARGS=-Stop

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %ARGS%
endlocal
