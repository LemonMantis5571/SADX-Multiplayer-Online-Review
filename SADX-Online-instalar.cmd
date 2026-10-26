@echo off
rem Prepares this PC to host SADX Online: the tools (Node.js, ffmpeg, cloudflared, GitHub CLI, through winget)
rem and, in your SADX folder, the mod (dist\mods, or this repo's latest release) and the Mod Loader settings
rem the stream needs.
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
rem GitHub CLI downloads the built mod from this private repo's releases (unless mod\build.ps1 built it here).
where gh >nul 2>nul
if errorlevel 1 (
  echo Instalando GitHub CLI...
  winget install --id GitHub.cli --exact --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\GitHub CLI"
)
if not exist "dist\mods\sadx-multiplayer\sadx-multiplayer.dll" (
  gh auth status >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Para bajar el mod, entra en GitHub con la cuenta que tiene acceso a este repo:
    gh auth login --hostname github.com --git-protocol https --web
  )
)

set "SADX=%~1"
if "%SADX%"=="" set /p "SADX=Carpeta de SADX (la que tiene sonic.exe): "
node gateway\agent-cli.mjs setup --sadx "%SADX%" --human
pause
