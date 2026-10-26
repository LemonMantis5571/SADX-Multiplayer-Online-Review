# AGENTS.md — SADX Online

SADX Online deja jugar Sonic Adventure DX a cuatro desde el navegador: la PC del usuario (el **anfitrión**)
corre el juego con el mod multijugador y una **sala** (servidor Node en `gateway/`) que reparte vídeo, sonido y
mandos por un enlace público. Lo habitual que te pidan: instalar todo en la PC del usuario y dejarlo jugando.
Para eso sigue los **Pasos** en orden; cada uno termina en una condición comprobable (**Hecho cuando**) y no
se pasa al siguiente sin cumplirla. Qué es cada carpeta: [`README.md`](README.md#repository-layout). Detalles de la
sala, el vídeo y el CLI: [`gateway/README.md`](gateway/README.md).

Todo es Windows. Los comandos son de PowerShell y, salvo que se diga otra cosa, se ejecutan desde la raíz del
repo. El CLI responde en JSON (con `--human`, en texto para personas).

## Reglas

1. **Las credenciales las pone el usuario.** Para GitHub, el usuario ejecuta `gh auth login` en su terminal (o
   el instalador se lo pide); tú solo compruebas con `gh auth status`.
2. **El token de administrador se queda en la PC.** Vive en `gateway/.agent-state/room.json` y en la URL del
   panel del anfitrión; `up` abre ese panel en el navegador del usuario. Para el estado de la sala usa
   `room status` y `doctor`, que no lo muestran.
3. **Las pruebas van al puerto 8199** (`node gateway/agent-cli.mjs test`). El 8123 es la sala real del usuario.
4. **Cierra lo que abriste con el CLI** (`down`, `game stop`): cierra por PID solo lo suyo. Cuando nadie juega,
   sala, enlace y juego quedan cerrados.
5. **La carpeta de SADX se toca solo con `setup`**, con el juego cerrado: guarda copia de lo que cambia en
   `<SADX>\sadx-online-backups\<fecha>`.
6. **El juego sale de la copia de Steam del usuario**, convertida por él con el SADX Mod Installer.
7. **El repo y sus releases son privados**: la base del mod no tiene licencia (ver Agradecimientos en el README). Se quedan en
   GitHub, en este repo; el zip del mod no se comparte fuera.

## Pasos

### 1. Lo que solo el usuario puede poner

- Windows 10 versión 2004 o más nuevo: `[Environment]::OSVersion.Version` con `Build` ≥ 19041.
- Sonic Adventure DX comprado en Steam e instalado.
- Una cuenta de GitHub con acceso a `LemonMantis5571/SADX-Multiplayer-Online` (repo privado).

**Hecho cuando:** el build es ≥ 19041 y el usuario confirmó las otras dos.

### 2. Herramientas

| Herramienta | Comprobar | Paquete de winget |
| --- | --- | --- |
| Git | `git --version` | `Git.Git` |
| Node.js 22 o más nuevo | `node --version` | `OpenJS.NodeJS.LTS` |
| ffmpeg 8 o más nuevo, con gfxcapture | `ffmpeg -hide_banner -h filter=gfxcapture` | `Gyan.FFmpeg` |
| cloudflared (enlace público) | `cloudflared --version` | `Cloudflare.cloudflared` |
| GitHub CLI | `gh --version` | `GitHub.cli` |

Instala cada una que falte:

```powershell
winget install --id <Paquete> --exact --accept-source-agreements --accept-package-agreements
```

Si `winget` no existe, el usuario instala "App Installer" desde Microsoft Store. Lo que instala winget entra
al `PATH` solo en terminales nuevas; para seguir en la misma:

```powershell
$env:Path += ";C:\Program Files\Git\cmd;C:\Program Files\nodejs;C:\Program Files\GitHub CLI;$env:LOCALAPPDATA\Microsoft\WinGet\Links"
```

**Hecho cuando:** los cinco comandos de "Comprobar" terminan bien, `node --version` da v22 o más, y la ayuda de
ffmpeg menciona `gfxcapture`.

### 3. GitHub

```powershell
gh auth status
```

Si no hay sesión, pide al usuario que ejecute él mismo
`gh auth login --hostname github.com --git-protocol https --web` (abre el navegador con un código). Después:

```powershell
gh repo view LemonMantis5571/SADX-Multiplayer-Online --json name
```

**Hecho cuando:** ese comando devuelve `{"name":"SADX-Multiplayer-Online"}`. Si dice que no encuentra el repo,
la cuenta no tiene acceso: el dueño del repo tiene que invitarla; avisa al usuario y espera.

### 4. El repo

Clónalo en una ruta corta, fuera de OneDrive (la compilación del mod se rompe con rutas de más de 260
caracteres):

```powershell
gh repo clone LemonMantis5571/SADX-Multiplayer-Online "$env:USERPROFILE\SADX-Online"
Set-Location "$env:USERPROFILE\SADX-Online"
```

Si ya estaba clonado: `git pull` en su carpeta. Los submódulos solo hacen falta para compilar el mod
(ver [Compilar el mod](#compilar-el-mod)).

**Hecho cuando:** existe `gateway\agent-cli.mjs` en la carpeta actual.

### 5. SADX convertido

Busca la carpeta del juego: por defecto `C:\Program Files (x86)\Steam\steamapps\common\Sonic Adventure DX`; si
no está ahí, cada biblioteca de Steam aparece como `"path"` en
`C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf`, y el juego está en
`<path>\steamapps\common\Sonic Adventure DX`. Comprueba:

```powershell
$sadx = 'C:\Program Files (x86)\Steam\steamapps\common\Sonic Adventure DX'
Test-Path "$sadx\sonic.exe"; Test-Path "$sadx\mods\.modloader\SADXModLoader.dll"; Get-ChildItem "$sadx\mods\.modloader\profiles\*.json"
```

La versión de Steam sin convertir solo trae `Sonic Adventure DX.exe` y no sirve. En ese caso el usuario tiene
que convertirla con el [SADX Mod Installer](https://sadxmodinstaller.unreliable.network/) (programa con
ventanas: elige la carpeta del juego; las opciones por defecto valen), y después abrir **SA Mod Manager** una
vez y cerrarlo (crea el perfil). Explícaselo, espera a que termine y vuelve a comprobar.

**Hecho cuando:** las dos rutas dan `True` y hay al menos un `.json` en `profiles`.

### 6. Instalar el mod y ajustar el juego

Con el juego cerrado (`Get-Process sonic -ErrorAction SilentlyContinue` no devuelve nada):

```powershell
node gateway/agent-cli.mjs setup --sadx "$sadx" --human
```

`setup` baja el mod de la última release del repo (con `gh`; si compilaste el mod, usa `dist\`), lo instala en
`<SADX>\mods\sadx-multiplayer`, lo activa en el perfil del Mod Loader con los ajustes que necesita el stream
(ventana de 1280 × 960, Direct3D 9, sin pausa al perder el foco), quita `sadx-frame-limit`, recuerda dónde
está `sonic.exe`, elige el codificador de vídeo de la GPU e instala `werift` (conexión directa, opcional).
Cada línea empieza con `ok` (hecho) o `falta` (qué falta y cómo resolverlo). Resuelve cada `falta` y repite
`setup`: no rehace lo que ya está.

Empieza sin `--light`. Si luego el juego va a tirones (gráfica integrada floja), repite con `--light`
(ventana de 960 × 720).

**Hecho cuando:** la salida no tiene ninguna línea `falta` y termina en `Listo. Para jugar: SADX-Online.cmd`.

### 7. Jugar

```powershell
node gateway/agent-cli.mjs up --human
```

Abre la sala en el puerto 8123, el juego (cuatro jugadores en pantalla dividida, en Twinkle Park; el panel del
anfitrión cambia nivel y personajes), el enlace público y el panel del anfitrión en el navegador del usuario.
La salida trae `Pasa este enlace: https://….trycloudflare.com/?code=…` (cambia en cada `up`; para uno fijo, ver
"Enlace fijo" en `gateway/README.md`) y `Juego: abierto (pid …)`.

Comprueba a los 30 segundos (lo que tarda el nivel en cargar):

```powershell
node gateway/agent-cli.mjs doctor
node gateway/agent-cli.mjs capture "$env:TEMP\sadx.jpg"
```

En `doctor`, `checks.gateway.ok` y `checks.sadxMod.ok` deben ser `true` (`playerCount` 4). `checks.video.ok`
puede salir `false` mientras nadie mira: el vídeo arranca cuando alguien entra. `capture` guarda un cuadro de
la ventana del juego: míralo.

Dile al usuario: pasa el enlace a sus amigos (cada uno elige un puesto del 2 al 4 en la página; el resto
mira), él juega como jugador 1 con el teclado o mando de la PC (ese puesto es siempre suyo), el sonido se activa en la página con 🔊 o la tecla M, y la
ventana del juego no se minimiza (la sala la vuelve a abrir si pasa). Para cerrar: el paso 8, o doble clic en
`SADX-Online-cerrar.cmd`.

**Hecho cuando:** `doctor` da `gateway` y `sadxMod` en `ok`, la captura muestra la pantalla dividida y el
usuario tiene el enlace.

### 8. Cerrar

```powershell
node gateway/agent-cli.mjs down
```

**Hecho cuando:** la respuesta tiene `"ok": true`, con `share`, `game` y `room` en `stopped` o
`alreadyStopped`, y `Get-Process sonic -ErrorAction SilentlyContinue` no devuelve nada.

## Después

**Actualizar:** con el juego cerrado, `git pull` y el paso 6 (instala la release nueva del mod si la hay).

**Uso diario sin agente:** `SADX-Online.cmd` (paso 7) y `SADX-Online-cerrar.cmd` (paso 8), en la raíz del repo.

## Compilar el mod

Hace falta cuando la cuenta no puede bajar releases o cuando cambiaste `mod/`. Visual Studio 2022 Build Tools
con C++ ocupa varios GB: pregunta al usuario antes de instalarlo.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
powershell -ExecutionPolicy Bypass -File mod\build.ps1
```

**Hecho cuando:** termina con `Mod:  …\dist\mods\sadx-multiplayer` y código de salida 0. Luego el paso 6:
`setup` usa ese `dist\` (dice `compilado en esta PC`). Para volver a las releases, borra `dist\`. Qué hace el
script, cómo publicar una release y cómo cambiar la base del mod: [`README.md`](README.md#building-the-mod).

## Cambiar el código

- La sala y el CLI: `gateway/*.mjs`, `gateway/lib/`. Pruebas sin juego, en el 8199:
  `node gateway/agent-cli.mjs test`.
- Las páginas: `gateway/web` (React + Vite + Tailwind + shadcn/ui); `npm install` y `npm run build` en esa
  carpeta dejan el resultado en `gateway/public`, que va en git.
- El mod: `mod/src` y `mod/sadx-multiplayer.patch`, luego [Compilar el mod](#compilar-el-mod). Para probar en
  un punto concreto de un nivel, el juego acepta
  `--level casinopolis --act 1 --multi 4 coop -p1 sonic -p2 tails -p3 knuckles -p4 amy --position x y z`.

## Problemas frecuentes

| Síntoma | Causa | Qué hacer |
| --- | --- | --- |
| `setup`: `no tiene SADX Mod Loader` | Juego sin convertir, o SA Mod Manager nunca abierto | Paso 5 |
| `setup`: `no encuentro sonic.exe` | Carpeta equivocada o juego sin convertir | Paso 5 |
| `setup`: `no pude bajar el mod de …` | `gh` sin sesión o la cuenta sin acceso | Paso 3, o [Compilar el mod](#compilar-el-mod) |
| `up`: `Sin enlace público` | cloudflared falta o la red bloquea trycloudflare.com | `node gateway/agent-cli.mjs share start`; en la misma WiFi sirve el enlace local |
| `up` falla con el puerto 8123 ocupado | Ya hay una sala | `room status` y `down`, o `up --port 8124` |
| `sadxMod`: `SADX no respondió en 127.0.0.1:27016` | Juego cerrado, todavía cargando, o sin el mod | Espera; `game status`; repite el paso 6 con el juego cerrado |
| `sadxMod`: `el modo multijugador del mod no está activo` | Todavía en menús | Espera a que cargue el nivel, o elige partida en el panel |
| El juego va a tirones | Gráfica integrada justa | Paso 6 con `--light`; cerrar otros programas |
| Vídeo negro o congelado | Ventana minimizada, o ningún codificador | Restaura la ventana; `doctor` (`checks.video.error`) |
| SADX se cayó (aviso `SADX has crashed at …`) | Error del juego o del mod | Al cerrar el aviso, la sala lo reabre (hasta 3 veces en 2 min). El informe está en `<SADX>\CrashDump\<fecha>\*_extra_info_*.txt` (dirección, nivel, posiciones): pásaselo al usuario |
| Los amigos no oyen | El sonido empieza apagado en el navegador | 🔊 o tecla M en la página |
| `build.ps1`: `Filename too long` | Ruta del repo demasiado larga | Clonar en una ruta corta (paso 4) |
| `build.ps1`: `conflict with the patch` | Cambios a mano en el submódulo | `git -C mod/sadx-multiplayer checkout -- .` y repetir |
| PowerShell no deja ejecutar el script | Política de ejecución | `powershell -ExecutionPolicy Bypass -File …` |
