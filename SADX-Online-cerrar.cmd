@echo off
rem Closes what SADX-Online.cmd opened: the public link, SADX and the room.
cd /d "%~dp0"
node gateway\agent-cli.mjs down
pause
