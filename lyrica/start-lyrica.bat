@echo off
title Lyrica Launcher
setlocal

set "PROJECT=C:\Users\reddy\Desktop\spotify-lyrics-translator"
set "CF=%LOCALAPPDATA%\cloudflared\cloudflared.exe"
set "LOG=%LOCALAPPDATA%\cloudflared\tunnel.log"

echo.
echo ==============================================
echo                   LYRICA
echo ==============================================
echo.

if not exist "%PROJECT%\server.js" (
  echo ERROR: Could not find the Lyrica project at:
  echo   %PROJECT%
  echo Edit this file and fix the PROJECT path.
  echo.
  pause
  exit /b 1
)

echo [1/2] Starting the music server...
start "Lyrica Server" /min cmd /k node "%PROJECT%\server.js"

timeout /t 3 /nobreak >nul

echo [2/2] Starting the secure tunnel for your phone...
if exist "%LOG%" del "%LOG%" >nul 2>&1

if not exist "%CF%" (
  echo.
  echo WARNING: cloudflared not found - the phone tunnel won't start.
  echo The app still works on this PC at http://localhost:8080
  echo.
  goto done
)

start "Lyrica Tunnel" /min cmd /k "%CF% tunnel --url http://localhost:8080 --no-autoupdate > %LOG% 2>&1"

echo.
echo Generating your phone link (please wait ~10 seconds)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$log='%LOG%'; $u=$null; for($i=0;$i -lt 40;$i++){Start-Sleep -Milliseconds 750; if(Test-Path $log){$m=Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -EA SilentlyContinue | Select-Object -First 1; if($m){$u=$m.Matches[0].Value;break}}}; Write-Host ''; if($u){Write-Host '   >>> OPEN THIS ON YOUR PHONE <<<' -ForegroundColor Green; Write-Host ''; Write-Host ('       '+$u) -ForegroundColor Cyan}else{Write-Host '   Link not ready yet - open the minimized' -ForegroundColor Yellow; Write-Host '   Lyrica Tunnel window to read the URL.' -ForegroundColor Yellow}; Write-Host ''"

:done
echo ==============================================
echo  Server + tunnel run in two minimized windows.
echo  Keep them open while you use the app.
echo.
echo  To STOP: run stop-lyrica.bat (or close those
echo  two minimized windows).
echo ==============================================
echo.
echo  You can close THIS window now.
echo.
pause
