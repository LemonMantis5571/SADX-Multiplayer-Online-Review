# Mods listos para instalar

`SADX-Online-instalar.cmd` (o `node gateway/agent-cli.mjs setup --sadx <carpeta>`) copia estas carpetas a
`<SADX>\mods\` y las activa en el perfil del Mod Loader.

- `sadx-multiplayer/`: este mod compilado (configuración `PrivateOnline`), con el puente del navegador:
  mandos por UDP, diseño de la pantalla dividida y el sonido del juego para la sala. Su `mod.ini` no tiene
  `GitHubRepo`: si SA Mod Manager lo "actualizara" desde el proyecto original, volvería la versión sin puente.

Después de recompilar el mod (ver `gateway/README.md`, "Compilar el mod"):

```powershell
Copy-Item bin\sadx-multiplayer.dll dist\mods\sadx-multiplayer\ -Force
```
