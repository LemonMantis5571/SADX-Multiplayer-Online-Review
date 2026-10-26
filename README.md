# SADX Online

Sonic Adventure DX para cuatro, desde el navegador. Una PC corre el juego; hasta cuatro personas juegan
(y el resto mira) entrando a un enlace, con vídeo, sonido, chat y mandos (teclado, mando o táctil), sin
instalar nada. Cada jugador puede ver su parte de la pantalla dividida a su propia resolución.

El multijugador en sí (pantalla dividida, menús, cientos de parches de objetos) es
[SADX Multiplayer](https://github.com/kellsnc/sadx-multiplayer) de Kell y Sora. Este repo solo guarda lo que
hicimos nosotros encima; el original entra como submódulo, sin tocar, y se le aplica un parche al compilar.

## Qué hay aquí

| Ruta | Qué es |
| --- | --- |
| [`gateway/`](gateway/README.md) | La sala (servidor Node), la página de los jugadores y el panel del anfitrión (`gateway/web`, compilados en `gateway/public`), y el CLI `agent-cli.mjs`. |
| `mod/src/browser_bridge.cpp` | El puente del navegador dentro del juego: UDP en `127.0.0.1:27016`, los mandos de los asientos web, el estado de la partida y la parte de la ventana de cada jugador. |
| `mod/src/audio_tap.cpp` | El sonido del juego, sacado desde dentro (la captura por proceso de Windows solo oye silencio de SADX). |
| `mod/sadx-multiplayer.patch` | Lo mínimo que cambiamos del original: engancha lo anterior en `OnInput`, `Init` y `OnExit`, y corrige dos direcciones mal puestas (ver abajo). |
| `mod/build.ps1`, `mod/mod.ini` | Compila el mod y lo empaqueta en `dist/`. |
| `mod/sadx-multiplayer/` | Submódulo: SADX Multiplayer de Kell y Sora, fijado en el commit `0b6525a`. No es nuestro. |
| `SADX-Online*.cmd` | Lanzadores de un clic: instalar, abrir, cerrar. |
| [`AGENTS.md`](AGENTS.md) | Guía paso a paso para que un agente de IA instale todo y abra el juego a su usuario. |

`dist/` y `mod/.build/` no están en git: los genera `mod/build.ps1` (o `setup` baja `dist/` de la release).

## Preparar una PC anfitriona

Windows 10 2004 o más nuevo. Basta una gráfica integrada: la codificación en AMD Radeon está probada (780M);
Intel (Quick Sync) está implementada pero sin probar; NVIDIA también. Ver
[rendimiento](gateway/README.md#rendimiento).

1. SADX de Steam convertido con el [SADX Mod Installer](https://sadxmodinstaller.unreliable.network/)
   (deja el juego como la versión 2004 e instala SADX Mod Loader y SA Mod Manager). Abre SA Mod Manager una vez.
2. Clona este repo (es privado: hace falta una cuenta de GitHub con acceso):
   `gh repo clone LemonMantis5571/SADX-Multiplayer-Online`.
3. Doble clic en **`SADX-Online-instalar.cmd`**: instala Node.js, ffmpeg, cloudflared y GitHub CLI con winget
   si faltan, te pide entrar en GitHub si hace falta, baja el mod de la última release, te pide la carpeta de
   SADX y deja ahí el mod y los ajustes del Mod Loader que necesita el stream (guarda copia de lo que cambia).
4. **`SADX-Online.cmd`** abre la sala, el juego, el enlace para tus amigos y el panel del anfitrión.
   **`SADX-Online-cerrar.cmd`** lo cierra todo.

Volver a ejecutar el instalador no repite nada; si salió una release nueva del mod, la instala.

## El mod

### Compilar

Hace falta git y Visual Studio 2022 (o sus Build Tools) con C++:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
powershell -ExecutionPolicy Bypass -File mod\build.ps1
```

`build.ps1` trae el submódulo y los suyos (SADX Mod Loader, ENet), aplica `mod/sadx-multiplayer.patch` (si ya
está aplicado lo detecta), baja las cabeceras de DirectX 8 que pide el original (de BizHawk 1.11.6,
comprobadas por SHA-256), compila `libmodutils`, `ModLoaderCommon` y el mod (Release, Win32, toolset v143) en
`mod/.build/`, y deja el mod en `dist/mods/sadx-multiplayer` y en `dist/sadx-online-mod.zip`. Para instalarlo
en el juego (cerrado): `node gateway/agent-cli.mjs setup --sadx "<carpeta de SADX>"`.

### Publicar una versión

Sube `Version` en `mod/mod.ini`, compila y publica el zip como release (los demás lo reciben la próxima vez
que corran el instalador o `setup`):

```powershell
gh release create mod-v1.0.4-online.2 dist/sadx-online-mod.zip --title "Mod 1.0.4-online.2" --notes "..."
```

### Cambiar el código del original

Después de un `build.ps1`, `mod/sadx-multiplayer` tiene el parche aplicado. Edita ahí y regenera el parche:

```powershell
git -C mod/sadx-multiplayer diff --ignore-submodules > mod/sadx-multiplayer.patch
```

Para pasar a otro commit del original: `git -C mod/sadx-multiplayer checkout -- .`, luego `fetch` y
`checkout <commit>` dentro del submódulo, `build.ps1` (si el parche ya no aplica, rehazlo a mano) y commit
del nuevo puntero del submódulo.

### Las dos correcciones del parche

Encontradas por un crash en Casinopolis (`SADX has crashed at 5cb9b1`) y verificadas desensamblando
`sonic.exe`:

- `patch_o_casino_fanfan.cpp`: `InitKuzu` apuntaba a `0x5CB9B0`, que es `IsRangeIn`. Con el multijugador
  activo, cerca de un ventilador de las alcantarillas de Casinopolis el mod la llamaba con el objeto en EBX
  y el juego se caía leyendo `[eax+0x2C]`. La función real está en `0x5CB650` (el juego la llama así en
  `0x5CBF44`). Reproducido y comprobado en el juego: con la DLL vieja se cae en segundos en ese punto; con la
  nueva no.
- `patch_rd_twinkle.cpp`: `TwinkleMaskBlock` apuntaba a la de Speed Highway (`0x60FEE0`); la de Twinkle Park
  es `0x61CDE0`. No se caía, pero en pantalla dividida elegía qué partes del escenario dibujar con los
  umbrales de otro nivel.

## Créditos

- [SADX Multiplayer](https://github.com/kellsnc/sadx-multiplayer), de **Kell** y **Sora**: todo el multijugador.
  Aquí solo como submódulo, más nuestro parche. Ese proyecto no publica licencia: este repo y sus releases
  (que llevan su mod compilado) son privados y no deben publicarse sin su permiso.
- [SADX Mod Loader](https://github.com/X-Hax/sadx-mod-loader) (X-Hax) y [ENet](https://github.com/lsalzman/enet),
  submódulos del original.
- Cabeceras de DirectX 8: Microsoft; `build.ps1` las baja al compilar, no están en el repo.
- SADX Online: `gateway/`, el puente del navegador, el sonido, el parche, el instalador y los lanzadores.
