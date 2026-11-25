@echo off
title MISHU Translator Server
cd /d "%~dp0"
echo Starting MISHU Translator server...
echo Keep this window OPEN while you use the app on your iPhone.
echo Close this window to stop the server.
echo.
rem Refresh the HTTPS certificate for the PC's current IP (same CA, iPhone stays trusted).
call npm run cert
echo.
call npm start
echo.
echo The server has stopped. Press any key to close this window.
pause >nul
