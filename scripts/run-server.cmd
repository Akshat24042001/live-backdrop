@echo off
rem Runs the backdrop server and restarts it within 2 seconds if it ever stops.
rem The backdrop and the operator panel reconnect by themselves. Close this window to stop for good.
title Live Backdrop server
cd /d "%~dp0.."
:loop
node server.js
echo.
echo Server stopped. Restarting in 2 seconds... (close this window to stop it)
timeout /t 2 /nobreak >nul
goto loop
