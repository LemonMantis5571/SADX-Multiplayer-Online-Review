@echo off
rem One click: the room, SADX, the public link and the host panel (QR, match, players).
cd /d "%~dp0"
node gateway\agent-cli.mjs up --human %*
if errorlevel 1 echo. & echo   Algo fallo: revisa el mensaje de arriba.
pause
