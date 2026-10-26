# SADX Online por navegador

La computadora anfitriona ejecuta SADX y el mod. Las demás personas entran con
un navegador, sin descargar cliente ni instalar nada. El navegador muestra el
juego del host (con sonido) y manda teclado, controles táctiles o Gamepad API a
uno de los puestos locales. El puesto 1 es siempre del anfitrión, que juega con
el teclado o mando de su PC: ningún navegador puede tomarlo. Los invitados usan
los puestos 2–4; si están ocupados, entran como espectadores y pueden tomar uno
cuando alguien lo libere.

```text
navegador ── WebSocket (túnel) ─────────► sala (server.mjs) ── UDP local ──► SADX + mod
   ▲  ▲                                     │       ▲                          │
   │  └── WebRTC directo (si es más rápido) ┤       └── sonido (mod, UDP) ◄────┤
   └───── vídeo H.264 + sonido Opus ◄───────┴──── una captura + codificador de GPU por vista ◄─┘
```

## Un clic

`SADX-Online.cmd` (en la raíz del repo) abre todo: la sala, SADX, el enlace público
y el panel del anfitrión en tu navegador (QR, partida, jugadores).
`SADX-Online-cerrar.cmd` lo cierra todo. Lo mismo desde la consola:

```powershell
node gateway/agent-cli.mjs up --human     # --room CÓDIGO --port 8123 --level emeraldcoast --no-share --no-game --no-open
node gateway/agent-cli.mjs down
```

`up` reutiliza el código de sala y el puerto de la última vez
(`.agent-state/settings.json`), así que el enlace que ya pasaste sigue llevando a
la misma sala. Para reiniciar solo la sala sin cortar el enlace ni el juego:
`room restart` (o `room stop --keep-share` y luego `room start --room CÓDIGO`).

## Preparar el host

1. Una copia de SADX PC 2004 US convertida, con SADX Mod Loader (el SADX Mod
   Installer convierte la de Steam). La instalación Steam sin convertir no sirve.
2. `SADX-Online-instalar.cmd` en la raíz del repo, o
   `node gateway/agent-cli.mjs setup --sadx "<carpeta de SADX>"`: instala el mod
   (el de `dist/mods` si lo compilaste con `mod/build.ps1`; si no, lo baja de la
   última release del repo con `gh` y lo actualiza cuando sale otra), recuerda
   dónde está `sonic.exe` (`.agent-state/settings.json`;
   también vale la variable `SADX_EXE`) y ajusta el perfil activo del cargador
   (`mods\.modloader\profiles\<perfil>.json`, con copia en
   `<SADX>\sadx-online-backups\`):
   - `"EnablePauseOnInactive": false`: SADX sigue corriendo y sonando sin foco.
   - Ventana de 1280 × 960 (`ScreenMode` 0, redimensionable): cada jugador ve
     640 × 480, la resolución original.
   - `"RenderBackend": 1` (Direct3D 9). Con el 2 (Direct3D 11 con transparencia
     OIT) SADX iba entre 6 y 47 fps según el momento, con la GPU al 100 %; con
     Direct3D 9 va estable a 50–59 fps (la captura de Windows a 60 Hz es el techo).
     VSync lo empeora (41–46), así que queda apagado.
   - Sin `sadx-frame-limit` (si estaba, lo desactiva): su espera activa gastaba
     un núcleo entero (SADX 1,2 núcleos con él, 0,4–0,5 sin él) con los mismos fps.
   - `setup --light`: ventana de 960 × 720 (cada jugador ve 480 × 360) para
     integradas flojas.
3. `cloudflared` para el enlace público:
   `winget install --id Cloudflare.cloudflared --exact`. Las personas que entran
   solo necesitan el navegador.
4. Opcional, Counter-Strike 1.6 (Steam, `steam://install/10`) para los ocho
   soldados (`cs_terror`, `cs_leet`, `cs_arctic`, `cs_guerilla`, `cs_gign`,
   `cs_gsg9`, `cs_sas`, `cs_urban`): sus modelos y sonidos salen de esa copia, el
   repo no trae ninguno. `setup` lo busca en las bibliotecas de Steam (o
   `--cstrike "<carpeta Half-Life>"`) y escribe la carpeta en
   `mods\sadx-multiplayer\sadx-online.ini` (`[CounterStrike]`, `Path=`). Sin él
   son maniquíes de cajas, mudos. Controles: X dispara, B cambia de arma, Y
   granada, A salta.

Sin el lanzador, paso a paso:

```powershell
node gateway/agent-cli.mjs room start --port 8123 --room 7AN8J
node gateway/agent-cli.mjs share start
```

y la partida desde el panel del anfitrión (o `game start`, que la abre fuera de
la sala: entonces la sala no la vigila hasta que la adopta).

## El enlace

`share start` sin más usa un Quick Tunnel de Cloudflare: una dirección
`*.trycloudflare.com` nueva cada vez que se abre el túnel. Cualquiera con el
enlace puede entrar (pon contraseña desde el panel si lo compartes en público),
sin garantía de disponibilidad y con un límite de 200 solicitudes simultáneas
([documentación](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)).
Reiniciar la sala con `room restart` no lo corta.

### Enlace fijo

Con una cuenta de Cloudflare y un dominio tuyo, el enlace no cambia nunca. Una
sola vez:

```powershell
cloudflared tunnel login                          # abre el navegador: elige tu dominio
cloudflared tunnel create sadx
cloudflared tunnel route dns sadx sadx.tudominio.com
node gateway/agent-cli.mjs share start --tunnel sadx --hostname sadx.tudominio.com
```

El CLI guarda el túnel y el nombre; desde entonces `share start` y `up` lo usan
solos y el enlace es siempre `https://sadx.tudominio.com/?code=CÓDIGO`.
`share start --quick` vuelve a un enlace temporal.

## Panel del anfitrión

`up` lo abre solo; a mano: `http://127.0.0.1:8123/host?admin=TOKEN` (el token
está en `.agent-state/room.json`). Solo responde desde esta PC, nunca a través
del túnel. Tiene:

- Invitar: enlace público con QR y enlace local.
- Seguridad: contraseña de la sala (la página la pide al entrar).
- Partida: nivel, acto, modo, número de jugadores y personaje de cada uno.
  «Usar lo que eligieron los jugadores» carga lo que pidió cada puesto (y suma a
  quien espera en un puesto de más). «Aplicar y reiniciar» reinicia SADX con eso;
  la página avisa a todos.
- Jugadores: quién está en cada puesto, qué personaje quiere, si su mando está
  activo, y «Sacar» (lo bloquea 10 minutos por su dirección).
- Vídeo: cada vista con sus fps y kbps reales, y cada espectador con lo que mira,
  su retraso y los cuadros saltados.

Si SADX se cierra solo, la sala lo vuelve a abrir con la misma partida (hasta
tres veces en dos minutos).

## Vídeo

Cada vista es su propio ffmpeg con su propia captura de la ventana (`gfxcapture`,
Windows Graphics Capture, hasta 60 fps), que recorta y escala en la GPU. Una vista
solo se codifica mientras alguien la mira y se apaga a los 15 s sin público: en
una sala donde cada uno mira su pantalla no se codifica también la partida entera.

| vista | qué es | por defecto |
| --- | --- | --- |
| alta | toda la partida | 720 p, 60 fps, 4000 kbps |
| baja | toda la partida | 480 p, 30 fps, 1200 kbps |
| p1…p4 | la pantalla de cada jugador | 480 p, 60 fps, 2500 kbps |

Las pantallas de los jugadores se recortan con el diseño de pantalla dividida
que informa el mod (cambia con el número de jugadores; con dos, mitades
verticales). En menús y escenas sin pantalla dividida todos ven la partida entera.

**Qué codifica** (`lib/gpu.mjs` lo elige al abrir la sala y lo prueba con unos
cuadros sintéticos; si con la captura real no sale imagen, pasa al siguiente):

| GPU | cómo llega el cuadro | CPU por vista (60 fps) |
| --- | --- | --- |
| NVIDIA (NVENC) | la textura de la captura entra tal cual al codificador | 0,05–0,07 núcleos |
| AMD (AMF, también integradas Radeon) | cuadro ya escalado copiado a memoria; AMF convierte y codifica en la GPU | 0,06–0,12 núcleos |
| Intel (Quick Sync) | textura mapeada a Quick Sync y convertida allí (sin probar: no hay Intel en la PC de pruebas) | — |
| ninguna | libx264 en la CPU, solo la partida entera a 30 fps | alto |

`--encoder h264_amf` (o `h264_qsv`, `libx264`) fuerza uno; `doctor` y el panel
dicen cuál se usa.

Configuración de baja latencia: sin B-frames ni lookahead, cada cuadro se manda
en cuanto sale y hay un cuadro clave por segundo. Cada cuadro viaja como mensaje
binario por el WebSocket de los mandos y la página lo decodifica con WebCodecs y
lo dibuja en cuanto está.

**Por qué no se acumula retraso:** a través del túnel, cloudflared acepta todo al
instante y encola el vídeo más lejos, así que el servidor no ve la congestión. Por
eso la página confirma (`va`) cada cuadro al recibirlo; si el cuadro más viejo sin
confirmar supera el mejor ida y vuelta del espectador más 160 ms, ese espectador
deja de recibir hasta el siguiente cuadro clave (como mucho 1 s congelado, nunca
segundos de retraso). En calidad **auto**, quien salta dos veces en 10 s pasa a
la baja (su pantalla sale recortada de «baja» en la página) y vuelve a probar la
alta tras 20 s tranquilo (más tiempo si vuelve a fallar).

La ventana del juego tiene que seguir dibujando: `lib/game-window.ps1` la vuelve
a su tamaño normal sin quitar el foco si se minimiza (no dibuja) o se maximiza
(SADX baja a unos 8 fps a 1920 × 1009), y la sala reinicia la captura si cambia
de tamaño.

**El vídeo vuelve solo.** Si la ventana desaparece (el juego se cierra, se cae o
se reinicia), las vistas esperan a que vuelva y siguen con el mismo codificador;
la página avisa «el vídeo vuelve solo» sobre el último cuadro. Un codificador
solo se descarta si no da imagen durante 10 s con la ventana presente; si se
descartan todos, se vuelven a probar todos al rato (10 s, luego hasta 60 s). Una
vista que corre pero deja de dar cuadros 10 s se reinicia. Lo comprueba
`npm run test:video`.

### Rendimiento

Medido en la PC de pruebas (Ryzen con Radeon 780M integrada + RTX 3060 Ti), con un
espectador y el juego en 4 jugadores:

| | antes | ahora |
| --- | --- | --- |
| SADX | 1,2 núcleos (con `sadx-frame-limit`) | 0,4–0,5 |
| vídeo | 0,85 núcleos (copia y conversión de 6 vistas en la CPU) | 0,02–0,06 (una vista, en la GPU) |
| sala (Node) | ~0,03 | ~0,03 |
| total | ~2,1 núcleos | ~0,6 |

Del botón a la imagen, en la misma PC: ≈70 ms con NVENC, ≈110 ms con AMF en la
integrada (aquí el juego se dibuja en la NVIDIA y la captura cruza de una GPU a
otra; en una PC solo con integrada ese cruce no existe). La sala en Node gasta tan
poco que reescribirla (en Rust u otro lenguaje) no cambiaría nada: lo pesado es
el juego, y la captura y el codificador ya son código nativo en la GPU.

Opciones de `room start` / `server.mjs`: `--fps`, `--height`, `--bitrate`
(alta), `--low-height`, `--low-bitrate`, `--player-height`, `--player-bitrate`,
`--encoder auto|h264_nvenc|h264_amf|h264_qsv|libx264`, `--quality` (JPEG), `--room`,
`--password`, `--no-audio`, `--no-rtc`, `--no-game`. Los navegadores sin
WebCodecs reciben JPEG uno a la vez (máximo 20 fps); `/api/frame.jpg` sigue
disponible para `capture` y `doctor`.

## Sonido

Solo el sonido de SADX, nada más de la PC. La captura por proceso de Windows
solo oye silencio de SADX (su DirectSound no queda asociado al proceso), así que
lo saca el mod desde dentro (`mod/src/audio_tap.cpp`): engancha el flujo WASAPI
compartido donde DirectSound mezcla todo y, mientras la sala lo pida
(`{"cmd":"audio"}` cada 2 s), manda cada búfer por UDP local. La sala lo pasa a
Opus (20 ms, 96 kbps) y lo envía por el WebSocket a quien activó el sonido
(botón 🔊 o tecla M); la página lo decodifica con WebCodecs y lo reproduce con
unos 100 ms de margen, descartando si se adelanta más de 250 ms al vídeo.

## Conexión directa (WebRTC)

Si la red de quien entra lo permite (STUN, la mayoría de los routers domésticos),
el vídeo llega por RTP sobre UDP directo desde esta PC y los mandos por un canal
de datos, sin pasar por el túnel. La página mide las dos rutas y solo se queda
con la directa si ahorra más de 20 ms de ida y vuelta: el receptor WebRTC del
navegador cuesta unos 15 ms más que el lienzo (en esta PC: 78 ms del botón a la
imagen por WebRTC frente a 63 ms por WebSocket). Si no conecta en 8 s, o se cae,
sigue por el WebSocket. Se puede apagar en la tarjeta «Sala»; `?direct=1` en la
dirección la fuerza para pruebas.

Usa `werift` (JavaScript puro, versión fijada en `package.json`, dependencia
opcional): `npm install` en esta carpeta. Sin él la sala funciona igual, solo por
WebSocket.

## La página

Las dos páginas (la del jugador y el panel del anfitrión) están hechas con React,
Tailwind y [shadcn/ui](https://ui.shadcn.com) en `web/`, con el estilo oscuro de
Linear (lienzo casi negro, superficies escalonadas con bordes finos, un único
acento lavanda #5e6ad2; Inter y JetBrains Mono como fuentes). Se compilan a
`public/` y lo compilado va en el repo, así que una PC que solo juega no
necesita compilar nada. Para cambiarlas:

```powershell
cd gateway\web
npm install
npm run build        # deja index.html, host.html y assets/ en ..\public
npm run dev          # con una sala abierta en el 8123: recarga al guardar
```

La parte de tiempo real (WebSocket, vídeo, sonido, conexión directa, mandos) está
en `web/src/player/room.ts`, fuera de React: dibuja cada cuadro en cuanto se
decodifica y React solo pinta la interfaz a partir de su estado.


- **Ver**: «mi pantalla» (la parte de la pantalla dividida de tu puesto, a su
  propia resolución), «toda la partida» o la de otro jugador. Tecla V.
- **Calidad**: auto, alta o baja. Sobre el vídeo: HD/SD, qué jugador ves, «directa».
- **Puestos**: personaje y color de cada uno (lo informa el mod), clic en uno
  libre para jugar o cambiar. Un puesto de más («entra en la próxima partida»)
  sirve para esperar y elegir personaje.
- **Próxima partida**: el personaje que quieres; el anfitrión lo ve en el panel.
- **Chat** (tecla T) y **emotes**, que suben sobre el vídeo encima de tu puesto.
- **Sonido** (🔊, tecla M) y **Medir retraso**: tu personaje salta cinco veces y
  la página mide del botón a la imagen (mediana).
- Contraseña si la sala la tiene; aviso si el anfitrión te saca (y no reconecta).
- Mando en vivo, nombre, enlace al portapapeles, pantalla completa (F o doble
  clic), controles táctiles en celulares (debajo del vídeo en vertical). Se
  reconecta sola si se corta la red. `window.sadxVideo`, `window.sadxAudio` y
  `window.sadxRtc` en la consola sirven para diagnosticar.

Teclado: WASD moverse, J=A, K=B, U=X, I=Y, Q=LB, E=RB, Shift=LT, O=RT, flechas
= stick derecho, Enter=Start.

## CLI para agentes

Todas las respuestas son JSON salvo `--human`. Node 22 o posterior.

```powershell
node gateway/agent-cli.mjs up --human
node gateway/agent-cli.mjs room status
node gateway/agent-cli.mjs room restart
node gateway/agent-cli.mjs share status
node gateway/agent-cli.mjs doctor
node gateway/agent-cli.mjs mod status
node gateway/agent-cli.mjs pad --seat 2 --buttons a --ly -1 --duration 700
node gateway/agent-cli.mjs capture frame.jpg
node gateway/agent-cli.mjs test browser
node gateway/agent-cli.mjs down
```

Para control sostenido, modo JSONL: `connect` reclama un puesto, `input` se
repite sin soltarlo, `release` manda neutral y libera:

```powershell
node gateway/agent-cli.mjs --stdio
```

```json
{"op":"room.status"}
{"op":"connect","seat":2,"name":"agente"}
{"op":"input","axes":{"ly":-1},"durationMs":800}
{"op":"input","buttons":["a"],"durationMs":120}
{"op":"release"}
```

Operaciones: `up`, `down`, `room.start`, `room.status`, `room.stop`,
`room.restart`, `share.start`, `share.status`, `share.stop`, `game.start`,
`game.status`, `game.focus`, `game.stop`, `mod.status`, `mod.neutral`, `pad`,
`connect`, `input`, `release`, `capture`, `doctor`, `test.browser` y `scenario`
(pasos en orden con expectativas por ruta, por ejemplo
`status.room.seats[0].occupied`).

`game start` abre SADX fuera de la sala (la sala lo adopta por
`.agent-state/game.json`); `game stop` cierra solo el proceso que abrió, por PID.
`doctor` revisa Node, ffmpeg, que cada vista entregue cuadros, la sala y el mod.
`test browser` abre Edge headless, ocupa los cuatro puestos con clientes de
prueba, entra como espectador, toma un puesto y comprueba que SADX mueve al
personaje.

## Probar sin abrir SADX

```powershell
node gateway/agent-cli.mjs test
```

Las pruebas de humo usan el puerto 8199 (nunca el 8123 de una sala real) y
`--no-game`, y cubren sala, puestos, pad, latido, espectadores y el CLI.

`npm run test:video` (en `gateway/`, unos 40 s; necesita ffmpeg) comprueba que el
vídeo vuelve solo: captura una ventana de prueba (`test/fixtures/fake-game.cs`,
compilada con el C# que trae Windows), la cierra 15 s, la vuelve a abrir y la
reinicia rápido, y exige que llegue vídeo cada vez sin cambiar de codificador.

## Puente del mod

El mod (`mod/src/browser_bridge.cpp`) escucha UDP en `127.0.0.1:27016` desde
`OnInput()`, sin bloquear el frame. Los paquetes son el JSON de
`lib/backends.mjs`: los asientos web 1–4 son los puestos 0–3 del mod (botones de
SADX, ejes `[-1,1]`, gatillos), que se suman a lo que el anfitrión toca en su
propio teclado o mando; un estado que no se renueva en 900 ms se neutraliza.
Comandos:

- `status`: nivel, modo, jugadores, personajes (0–8 los del juego y Metal
  Sonic, 9–16 los soldados), puntos (`score`), posiciones, qué puestos reciben
  input web, `splitscreen` y la parte de la ventana de cada jugador (`screen`).
- `releaseAll`: suelta los cuatro puestos.
- `audio` (`on`): manda el sonido del juego a quien lo pide durante 5 s.

Para entrar directo a un nivel con cuatro personajes:
`--level twinklepark --act 1 --multi 4 coop -p1 sonic -p2 tails -p3 knuckles -p4 amy`
(con `--position x y z` aparecen en ese punto; `-p1 cs_gign` es un soldado).
`--bridge-port N` cambia el puerto del puente (27016), para probar una segunda
copia del juego sin tocar la de la sala.

Compilar el mod: `mod/build.ps1`, explicado en el [README de la raíz](../README.md#building-the-mod).

## Límites

- La subida del host crece con cada espectador: unos 4 Mbps por persona en alta
  (2,5 Mbps mirando una pantalla de jugador). Para conexiones justas: `--bitrate`,
  `--player-bitrate` o calidad baja en la página.
- La conexión directa solo se probó en esta PC (no a través de routers ajenos);
  si no conecta, la página sigue por el túnel.
- Cuatro puestos locales implican pantalla dividida dentro de una sola instancia
  de SADX; «mi pantalla» es esa parte, no una cámara aparte.
