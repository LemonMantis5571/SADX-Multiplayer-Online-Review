# SADX Online

Sonic Adventure DX para cuatro, desde el navegador. Una PC corre el juego; hasta cuatro personas juegan
(y el resto mira) entrando a un enlace, con vídeo, sonido, chat y mandos (teclado, mando o táctil), sin
instalar nada. Cada jugador puede ver su parte de la pantalla dividida a su propia resolución.

- [`gateway/`](gateway/README.md): la sala (servidor Node), las páginas, el panel del anfitrión y el CLI.
- [`source/`](source): el mod de SADX con el puente del navegador (mandos por UDP, diseño de la pantalla
  dividida, sonido del juego), sobre el multijugador de SADX Multiplayer (ver Créditos).
- [`dist/mods`](dist/README.md): el mod ya compilado, listo para instalar.

## Preparar una PC anfitriona

Windows 10 2004 o más nuevo. Basta una gráfica integrada: la codificación en AMD Radeon está probada (780M); Intel (Quick Sync) está implementada pero sin probar; NVIDIA también. Ver [rendimiento](gateway/README.md#rendimiento).

1. SADX de Steam convertido con el [SADX Mod Installer](https://sadxmodinstaller.unreliable.network/)
   (deja el juego como la versión 2004 e instala SADX Mod Loader y SA Mod Manager). Abre SA Mod Manager una vez.
2. Doble clic en **`SADX-Online-instalar.cmd`**: instala Node.js, ffmpeg y cloudflared con winget si
   faltan, te pide la carpeta de SADX y deja ahí los mods de `dist/mods` y los ajustes del Mod Loader que
   necesita el stream (guarda copia de lo que cambia).
3. **`SADX-Online.cmd`** abre la sala, el juego, el enlace para tus amigos y el panel del anfitrión.
   **`SADX-Online-cerrar.cmd`** lo cierra todo.

## Compilar el mod

Visual Studio 2022 y las cabeceras de DirectX 8; los detalles están en
[`gateway/README.md`](gateway/README.md#compilar-el-mod). Los submódulos de `external/` (SADX Mod Loader,
ENet) se traen con `git submodule update --init --recursive`.

## Créditos

- El multijugador de SADX (pantalla dividida, menús, parches de objetos, netplay) es
  [SADX Multiplayer](https://github.com/kellsnc/sadx-multiplayer) de **Kell** y **Sora**; la mayor parte de
  `source/`, `include/`, `resources/` y `docs/` es su trabajo. Ese proyecto no publica licencia: este repo es
  privado y no debe publicarse sin su permiso.
- [SADX Mod Loader](https://github.com/X-Hax/sadx-mod-loader) (X-Hax) y [ENet](https://github.com/lsalzman/enet).
- SADX Online: el puente del navegador del mod, el sonido, `gateway/`, el instalador y los lanzadores.
