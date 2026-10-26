@echo off
rem Prepares this PC to host SADX Online: the tools (Node.js, ffmpeg, cloudflared, through winget) and,
rem in your SADX folder, the mods from dist\mods and the Mod Loader settings the stream needs.
rem Usage: double-click, or SADX-Online-instalar.cmd "C:\...\Sonic Adventure DX"
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Instalando Node.js...
  winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
  echo.
  echo   Node.js quedo instalado: cierra esta ventana y vuelve a abrir SADX-Online-instalar.cmd
  pause
  exit /b
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Instalando ffmpeg...
  winget install --id Gyan.FFmpeg --exact --accept-source-agreements --accept-package-agreements
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo Instalando cloudflared...
  winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements
)

set "SADX=%~1"
if "%SADX%"=="" set /p "SADX=Carpeta de SADX (la que tiene sonic.exe): "
node gateway\agent-cli.mjs setup --sadx "%SADX%" --human
pause
