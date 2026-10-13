@echo off
title Stop Lyrica
echo Stopping Lyrica...
echo.
taskkill /f /im cloudflared.exe >nul 2>&1 && echo  - Tunnel stopped. || echo  - Tunnel was not running.
taskkill /f /im node.exe       >nul 2>&1 && echo  - Server stopped. || echo  - Server was not running.
echo.
echo Note: this closes ALL Node.js processes on this PC.
echo Done.
timeout /t 3 /nobreak >nul
