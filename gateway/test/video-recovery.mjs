// Video recovery: the room must bring the video back by itself when the game window goes away and returns
// (the game closed, crashed or restarting), keeping the encoder it chose. Needs Windows, ffmpeg with
// gfxcapture and a GPU or CPU encoder; it captures a test window (fixtures/fake-game.cs), never SADX.
//
//   node gateway/test/video-recovery.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = Number(process.env.SMOKE_PORT || 8199); // never the room's usual 8123
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_NAME = 'sadx-online-test-window.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const work = mkdtempSync(path.join(os.tmpdir(), 'sadx-video-test-'));
const exe = path.join(work, EXE_NAME);
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const built = spawnSync(csc, ['-nologo', '-target:winexe', `-out:${exe}`, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll',
  path.join(HERE, 'fixtures', 'fake-game.cs')], { encoding: 'utf8', windowsHide: true });
if (built.status !== 0) {
  console.log(`  FAIL no pude compilar la ventana de prueba: ${(built.stdout || built.error?.message || '').trim()}`);
  process.exit(1);
}

let window = null;
const openWindow = () => { window = spawn(exe, [], { stdio: 'ignore' }); };
const closeWindow = () => { window?.kill(); window = null; };

const room = spawn(process.execPath, [SERVER, '--host', '127.0.0.1', '--port', String(PORT), '--no-game', '--no-audio',
  '--no-rtc', '--backend', 'log', '--room', 'VIDEO', '--source', `exe=${EXE_NAME}`], {
  env: { ...process.env, SADX_AGENT_STATE_DIR: path.join(work, 'state') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let roomLog = '';
room.stdout.on('data', (c) => { roomLog += c; });
room.stderr.on('data', (c) => { roomLog += c; });

const video = async () => (await (await fetch(`${BASE}/api/status`)).json()).video;

/** A viewer like the page: watches the whole game in H.264, acknowledges each frame, pings every 2 s. */
async function watch() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=VIDEO&spectate=1&name=video-test`);
  ws.binaryType = 'arraybuffer';
  const viewer = { frames: 0, ws };
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') return;
    viewer.frames += 1;
    ws.send(JSON.stringify({ t: 'va', s: new DataView(ev.data).getUint32(4, true) }));
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  ws.send(JSON.stringify({ t: 'video', codec: 'h264', quality: 'alta', view: 'all' }));
  viewer.pinger = setInterval(() => ws.send(JSON.stringify({ t: 'ping', id: Date.now() })), 2000);
  return viewer;
}

/** Whether frames reach the viewer within `ms`. */
async function framesWithin(viewer, ms) {
  const start = viewer.frames;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (viewer.frames - start >= 10) return true;
    await sleep(250);
  }
  return false;
}

try {
  console.log('vídeo — recuperación cuando la ventana del juego se va y vuelve');
  openWindow();
  for (let i = 0; i < 40; i++) { try { await video(); break; } catch { await sleep(250); } }
  let status = await video();
  while (status.encoder === 'eligiendo…') { await sleep(250); status = await video(); }
  const encoder = status.encoder;
  check('la sala elige un codificador', encoder !== 'ninguno' && encoder !== 'reintentando', encoder);

  const viewer = await watch();
  check('llega vídeo con la ventana abierta', await framesWithin(viewer, 8000));

  // Longer than it took the old code to give up on every encoder (about 11 s).
  closeWindow();
  await sleep(15000);
  status = await video();
  check('sin ventana durante 15 s conserva el codificador', status.encoder === encoder, status.encoder);
  check('la sala sabe que no hay ventana', status.window.present === false, JSON.stringify(status.window));
  openWindow();
  check('el vídeo vuelve solo cuando vuelve la ventana', await framesWithin(viewer, 8000));

  // A quick restart (closed and reopened within a second, like "Aplicar y reiniciar").
  closeWindow();
  await sleep(500);
  openWindow();
  check('el vídeo vuelve tras un reinicio rápido', await framesWithin(viewer, 8000));
  check('el codificador sigue siendo el mismo', (await video()).encoder === encoder);

  clearInterval(viewer.pinger);
  viewer.ws.close();
} catch (err) {
  failures += 1;
  console.log(`  FAIL excepción: ${err.message}`);
} finally {
  closeWindow();
  room.kill();
  await sleep(300);
  if (failures) console.log(roomLog.split('\n').filter((l) => /\[vídeo\]/.test(l)).slice(-15).join('\n'));
  rmSync(work, { recursive: true, force: true });
  console.log(failures === 0 ? '\ntodo correcto' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
