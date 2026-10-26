#!/usr/bin/env node
// Puerta web para la demo online: sirve una página con los puestos de mando,
// reparte vídeo del juego y entrega el estado de cada mando al backend elegido.
//
// Uso típico:
//   node gateway/server.mjs --source "exe=sonic.exe" --backend log
//   node gateway/server.mjs --host 0.0.0.0 --backend udp --udp-port 27016
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachWsServer } from './lib/ws.mjs';
import { Room, makeRoomCode, SEAT_MAX } from './lib/rooms.mjs';
import { VideoStream } from './lib/video.mjs';
import { VideoHub, layoutFor } from './lib/videohub.mjs';
import { GameAudio } from './lib/audio.mjs';
import { RtcLink, loadWebRtc, rtcAvailable } from './lib/rtc.mjs';
import { GameManager, LEVELS, CHARACTERS, MODES } from './lib/game.mjs';
import { createBackend, normalizePad } from './lib/backends.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

function parseArgs(argv) {
  const cfg = {
    port: 8080,
    host: '127.0.0.1',
    seats: SEAT_MAX,
    room: null,
    video: true,
    ffmpeg: 'ffmpeg',
    source: 'exe=sonic.exe',
    fps: 60,
    height: 720,
    quality: 8,
    bitrate: 4000,
    lowHeight: 480,
    lowBitrate: 1200,
    playerHeight: 480,
    playerBitrate: 2500,
    encoder: 'auto',
    backend: 'log',
    udpPort: 27016,
    adminToken: null,
    password: null,
    gameExe: defaultGameExe(),
    manageGame: true,
    audio: true,
    rtc: true,
  };
  const flags = {
    '--port': (v) => { cfg.port = Number(v); },
    '--host': (v) => { cfg.host = v; },
    '--seats': (v) => { cfg.seats = Math.max(1, Math.min(SEAT_MAX, Number(v))); },
    '--room': (v) => { cfg.room = String(v).toUpperCase(); },
    '--ffmpeg': (v) => { cfg.ffmpeg = v; },
    '--source': (v) => { cfg.source = v; },
    '--fps': (v) => { cfg.fps = Number(v); },
    '--height': (v) => { cfg.height = Number(v); },
    '--quality': (v) => { cfg.quality = Number(v); },
    '--bitrate': (v) => { cfg.bitrate = Number(v); },
    '--low-bitrate': (v) => { cfg.lowBitrate = Number(v); },
    '--low-height': (v) => { cfg.lowHeight = Number(v); },
    '--player-bitrate': (v) => { cfg.playerBitrate = Number(v); },
    '--player-height': (v) => { cfg.playerHeight = Number(v); },
    '--encoder': (v) => { cfg.encoder = String(v); },
    '--backend': (v) => { cfg.backend = v; },
    '--udp-port': (v) => { cfg.udpPort = Number(v); },
    '--admin-token': (v) => { cfg.adminToken = String(v); },
    '--password': (v) => { cfg.password = String(v); },
    '--game-exe': (v) => { cfg.gameExe = String(v); },
    '--no-game': () => { cfg.manageGame = false; },
    '--no-video': () => { cfg.video = false; },
    '--no-audio': () => { cfg.audio = false; },
    '--no-rtc': () => { cfg.rtc = false; },
  };
  const switches = new Set(['--no-game', '--no-video', '--no-audio', '--no-rtc']); // flags without a value

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      cfg.help = true;
      continue;
    }
    const [name, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const handler = flags[name];
    if (!handler) {
      throw new Error(`opción desconocida: ${arg}`);
    }
    if (switches.has(name)) {
      handler();
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[(i += 1)];
    if (value === undefined) throw new Error(`falta el valor de ${name}`);
    handler(value);
  }
  return cfg;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${msg}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function serveStatic(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('no encontrado');
    return;
  }
  const body = readFileSync(filePath);
  // The pages' scripts, styles and fonts (web/ build) carry a content hash in their name: cacheable for good.
  const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
}

const HELP = `Puerta web para puestos de mando

Opciones:
  --port <n>          puerto HTTP (por defecto 8080)
  --host <ip>         127.0.0.1 (por defecto) o 0.0.0.0 para LAN/Tailscale
  --seats <n>         puestos de mando, 1..${SEAT_MAX} (por defecto ${SEAT_MAX})
  --room <codigo>     código de sala fijo (por defecto aleatorio)
  --source <ventana>  ventana del juego (por defecto exe=sonic.exe)
                      acepta exe=, title=, hwnd=; desktop usa GDI
  --fps <n>           frames por segundo a capturar (por defecto 60)
  --height <n>        alto de la calidad alta, toda la partida (por defecto 720)
  --bitrate <kbps>    bitrate H.264 de la calidad alta (por defecto 4000)
  --low-height <n>    alto de la calidad baja, a la mitad de fps (por defecto 480)
  --low-bitrate <kbps> bitrate de la calidad baja (por defecto 1200)
  --player-height <n> alto de la pantalla de cada jugador (por defecto 480)
  --player-bitrate <kbps> bitrate de la pantalla de cada jugador (por defecto 2500)
  --encoder <nombre>  auto (NVENC y si no libx264), h264_nvenc, libx264, h264_amf...
  --quality <n>       calidad JPEG del respaldo 2..31, menor = mejor (por defecto 8)
  --no-video          no lanza ffmpeg (sirve para probar los mandos)
  --no-audio          no captura el sonido del juego
  --no-rtc            no ofrece la conexión directa (WebRTC) a quien pueda usarla
  --ffmpeg <ruta>     binario de ffmpeg (busca primero gfxcapture de um)
  --backend log|udp   destino del estado de mando (por defecto log)
  --udp-port <n>      puerto UDP del backend udp (por defecto 27016)
  --password <texto>  contraseña para entrar a la sala (también desde el panel del anfitrión)
  --game-exe <ruta>   sonic.exe que lanza, reinicia y vigila la sala (por defecto el que guardó agent-cli setup)
  --no-game           la sala no toca el proceso del juego
`;

const STATE_DIR = path.resolve(process.env.SADX_AGENT_STATE_DIR || path.join(HERE, '.agent-state'));

/** The SADX the room launches: --game-exe, else SADX_EXE, else what `agent-cli setup` saved. */
function defaultGameExe() {
  if (process.env.SADX_EXE) return process.env.SADX_EXE;
  try { return JSON.parse(readFileSync(path.join(STATE_DIR, 'settings.json'), 'utf8')).gameExe || null; } catch { return null; }
}

/** Requests that came through the Cloudflare tunnel carry its headers; local ones don't. */
function viaTunnel(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function isLoopback(req) {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** Who is on the other end: the visitor's address for tunnel requests, the socket's otherwise. */
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
}

function readBody(req, limit = 16 << 10) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** A display name from the page: printable, trimmed, at most 24 characters. */
function cleanName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
}

// Chat: short lines, a few per person every few seconds; emotes from a fixed set (the page shows them big).
const CHAT_HISTORY = 40;
const CHAT_WINDOW_MS = 10000;
const CHAT_PER_WINDOW = 6;
const EMOTES = ['👍', '😂', '😮', '🔥', '💀', '❤️', '👏', 'GG'];

function cleanChat(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (cfg.help) {
    console.log(HELP);
    return;
  }

  const code = cfg.room || makeRoomCode();
  const room = new Room(code, cfg.seats);
  const backend = createBackend(cfg.backend, { port: cfg.udpPort, log });

  const video = cfg.video
    ? new VideoStream({
        ffmpeg: cfg.ffmpeg,
        source: cfg.source,
        fps: Math.min(cfg.fps, 20), // fallback only: JPEG costs ~3x the bandwidth of H.264 per frame
        height: Math.min(cfg.height, cfg.lowHeight),
        quality: cfg.quality,
        log,
      })
    : null;

  // H.264 (the whole game in two qualities plus each player's screen, per-viewer pacing) is the normal
  // video; the JPEG stream only runs for browsers without WebCodecs and the CLI's captures.
  const hub = cfg.video
    ? new VideoHub({
        ffmpeg: cfg.ffmpeg,
        source: cfg.source,
        fps: cfg.fps,
        height: cfg.height,
        bitrate: cfg.bitrate,
        lowHeight: cfg.lowHeight,
        lowBitrate: cfg.lowBitrate,
        playerHeight: cfg.playerHeight,
        playerBitrate: cfg.playerBitrate,
        encoder: cfg.encoder,
        jpeg: video,
        seatOf: (conn) => room.seatOf(conn.id)?.index ?? null,
        log,
      })
    : null;

  // The SADX process: launched, restarted and brought back after a crash from here (shares game.json with the CLI).
  if (cfg.manageGame && !cfg.gameExe) log('[juego] no sé dónde está SADX: ejecuta `node gateway/agent-cli.mjs setup --sadx <carpeta>`');
  const game = cfg.manageGame && cfg.gameExe && process.platform === 'win32'
    ? new GameManager({
        exe: cfg.gameExe,
        stateFile: path.join(STATE_DIR, 'game.json'),
        configFile: path.join(STATE_DIR, 'game-config.json'),
        log,
      })
    : null;
  const bans = new Map(); // ip -> banned until (kicked players)
  // Until the mod reports its split-screen layout, cut the players' views from the one it uses for this many players.
  hub?.setLayout({ screens: layoutFor(game ? game.config.characters.length : cfg.seats) });

  function isAdmin(req, url) {
    if (!isLoopback(req) || viaTunnel(req) || !cfg.adminToken) return false;
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('admin') || '';
    return presented.length === cfg.adminToken.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(cfg.adminToken));
  }

  function shareUrl() {
    try {
      const t = JSON.parse(readFileSync(path.join(STATE_DIR, 'tunnel.json'), 'utf8'));
      return t.url ? `${t.url}/?code=${room.code}` : null;
    } catch { return null; }
  }

  function adminState() {
    const conns = new Map([...ws.connections].map((c) => [c.id, c]));
    return {
      room: room.code,
      password: Boolean(cfg.password),
      localUrl: `http://127.0.0.1:${cfg.port}/?code=${room.code}`,
      shareUrl: shareUrl(),
      seats: room.seats.map((s) => ({
        index: s.index, occupied: s.clientId !== null, name: s.name, want: s.want,
        ip: s.clientId ? conns.get(s.clientId)?.clientIp ?? null : null,
        padAge: s.lastPadAt ? Date.now() - s.lastPadAt : null,
      })),
      spectators: [...ws.connections].filter((c) => !room.seatOf(c.id)).map((c) => ({ name: c.displayName, ip: c.clientIp })),
      game: game ? game.status() : { managed: false },
      mod: gameInfo(),
      video: hub ? hub.status() : null,
      audio: audio ? audio.status() : null,
      options: { levels: LEVELS, characters: CHARACTERS, modes: MODES },
    };
  }

  // The game window has to stay streamable: minimized it doesn't draw, maximized SADX renders so many more
  // pixels that it drops to a few fps, and the capture keeps the size it started with. lib/game-window.ps1
  // watches it, puts it back to its normal size without taking the focus, and says when its size changes.
  const gameExe = /^(?:exe|window_exe)=(.+)$/i.exec(cfg.source)?.[1];
  let windowKeeper = null;
  let closing = false;
  function keepGameWindow() {
    if (closing) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(HERE, 'lib', 'game-window.ps1'), '-ProcessName', gameExe, '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    windowKeeper = child;
    let size = null;
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const [event, value] = line.trim().split(' ');
        if (event === 'restored') log(`[vídeo] la ventana del juego estaba ${value === 'maximized' ? 'maximizada' : 'minimizada'}: vuelve a su tamaño sin quitar el foco`);
        if (event === 'size') {
          // Crops are in window pixels and a running capture keeps its first size: the views follow the window.
          const [w, h] = value.split('x').map(Number);
          if (size && size !== value) log(`[vídeo] la ventana del juego cambió a ${value}: reinicio la captura`);
          hub.setWindowSize(w, h);
          size = value;
        }
      }
    });
    child.on('exit', () => {
      if (windowKeeper === child) windowKeeper = null;
      if (!closing) setTimeout(keepGameWindow, 5000).unref();
    });
  }
  if (hub && gameExe && process.platform === 'win32') keepGameWindow();

  // The game's sound (the mod sends SADX's own mix), for viewers who turn it on.
  const audio = cfg.video && cfg.audio && cfg.backend === 'udp'
    ? new GameAudio({ ffmpeg: cfg.ffmpeg, modPort: cfg.udpPort, log })
    : null;

  // What the mod says about the game (level, character in each seat), for the page.
  let modInfo = { online: false };
  let gameSignature = '';
  const gameInfo = () => modInfo;
  const gamePoll = backend.query
    ? setInterval(async () => {
        const reply = await backend.query();
        const next = reply
          ? {
              online: true,
              multiplayer: Boolean(reply.multiplayerActive),
              stage: reply.stage,
              characters: (reply.players || []).map((p) => p.character),
              split: Boolean(reply.splitscreen),
              // Each player's part of the window while split-screen is on (older mod builds don't say).
              screens: Object.fromEntries((reply.players || [])
                .filter((p) => Array.isArray(p.screen) && p.screen.length === 4)
                .map((p) => [`p${p.seat}`, p.screen.map((n) => Math.round(Number(n) * 10000) / 10000)])),
            }
          : { online: false };
        // While a level loads the mod briefly reports fewer screens than players: only a full layout re-cuts the views.
        const fullLayout = Object.keys(next.screens || {}).length >= 2 && Object.keys(next.screens).length === reply?.playerCount;
        if (next.online) hub?.setLayout({ split: next.split, screens: fullLayout ? next.screens : null });
        const signature = JSON.stringify(next);
        if (signature !== gameSignature) {
          gameSignature = signature;
          modInfo = next;
          broadcastSeats();
        }
      }, 2000)
    : null;

  const startedAt = Date.now();
  const padBudget = new Map(); // clientId -> { windowStart, count }
  // Direct connections (WebRTC) only when werift is installed; the WebSocket works either way.
  const RTC_MAX = 8;
  let rtcOn = false;
  if (cfg.video && cfg.rtc) {
    loadWebRtc().then((ok) => {
      rtcOn = ok;
      log(ok ? '[rtc] conexión directa disponible (WebRTC)' : '[rtc] sin werift: solo WebSocket (npm install en gateway/ para la conexión directa)');
    });
  }
  const chatLog = []; // the last messages, for whoever joins later
  const PAD_PER_SEC = 120;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    if (url.pathname === '/api/status') {
      const body = Buffer.from(
        JSON.stringify(
          {
            room: room.snapshot(),
            seats: room.seats.length,
            spectators: spectatorCount(),
            video: hub ? hub.status() : { running: false, disabled: true },
            audio: audio ? audio.status() : { running: false, disabled: true },
            jpeg: video ? video.status() : { running: false, disabled: true },
            game: modInfo,
            process: game ? game.status() : null,
            input: backend.status(),
            uptimeMs: Date.now() - startedAt,
            connections: ws.connections.size,
          },
          null,
          2,
        ),
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/frame.jpg') {
      if (!video) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('vídeo desactivado (--no-video)');
        return;
      }
      if (url.searchParams.get('code') !== room.code) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('código de sala incorrecto');
        return;
      }
      video.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (!video.latest() || Date.now() - video.lastFrameAt > 2500)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const jpeg = video.latest();
      if (!jpeg || Date.now() - video.lastFrameAt > 2500) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
        res.end('no llegó un cuadro reciente; comprueba que SADX siga redibujando');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': jpeg.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(jpeg);
      return;
    }
    // Host panel and admin API: only from this PC (never through the tunnel) and with the room's admin token.
    if (url.pathname === '/host' || url.pathname === '/host.html') {
      if (!isLoopback(req) || viaTunnel(req)) { res.writeHead(404); res.end('no encontrado'); return; }
      serveStatic(res, path.join(PUBLIC_DIR, 'host.html'));
      return;
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req, url)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('no encontrado'); return; }
      try {
        const route = `${req.method} ${url.pathname}`;
        if (route === 'POST /api/admin/stop') {
          sendJson(res, 202, { stopping: true });
          setTimeout(shutdown, 25).unref();
          return;
        }
        if (route === 'GET /api/admin/state') { sendJson(res, 200, adminState()); return; }
        if (route === 'POST /api/admin/game') {
          if (!game) { sendJson(res, 400, { error: 'esta sala no administra el juego (--no-game)' }); return; }
          const body = await readBody(req);
          for (const conn of ws.connections) conn.send({ t: 'notice', message: 'El anfitrión está reiniciando la partida…' });
          await game.restart(body);
          sendJson(res, 200, adminState());
          return;
        }
        if (route === 'POST /api/admin/game/stop') {
          if (game) await game.stop();
          sendJson(res, 200, adminState());
          return;
        }
        if (route === 'POST /api/admin/kick') {
          const body = await readBody(req);
          const seat = room.seats.find((s) => s.index === Number(body.seat));
          const target = seat?.clientId ? [...ws.connections].find((c) => c.id === seat.clientId) : null;
          if (!target) { sendJson(res, 404, { error: 'ese puesto está libre' }); return; }
          bans.set(target.clientIp, Date.now() + 10 * 60 * 1000);
          target.send({ t: 'kicked', message: 'El anfitrión te sacó de la sala.' });
          target.close(1008, 'kicked');
          log(`[sala] el anfitrión sacó a ${seat.name} (${target.clientIp}) del puesto ${seat.index}`);
          sendJson(res, 200, adminState());
          return;
        }
        if (route === 'POST /api/admin/password') {
          const body = await readBody(req);
          cfg.password = body.password ? String(body.password).slice(0, 64) : null;
          log(cfg.password ? '[sala] contraseña activada' : '[sala] contraseña quitada');
          sendJson(res, 200, adminState());
          return;
        }
        sendJson(res, 404, { error: 'ruta desconocida' });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (url.pathname === '/stream') {
      if (!video) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('vídeo desactivado (--no-video)');
        return;
      }
      if (url.searchParams.get('code') !== room.code) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('código de sala incorrecto');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Connection: 'close',
      });
      video.subscribe(res);
      return;
    }

    const safe = path.normalize(url.pathname).replace(/^([/\\])+/, '');
    const candidate = path.join(PUBLIC_DIR, safe);
    if (!candidate.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ruta no permitida');
      return;
    }
    serveStatic(res, candidate);
  });

  const ws = attachWsServer(server, {
    path: '/ws',
    onReject(_req, socket, reason) {
      socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\n${reason}`);
    },
    onConnection(conn, req, url) {
      conn.clientIp = clientIp(req);
      const bannedUntil = bans.get(conn.clientIp);
      if (bannedUntil && bannedUntil > Date.now()) {
        conn.send({ t: 'error', code: 'kicked', message: 'el anfitrión te sacó de la sala; espera unos minutos' });
        conn.close(1008, 'banned');
        return;
      }
      if (cfg.password && url.searchParams.get('pw') !== cfg.password) {
        conn.send({ t: 'error', code: 'password', message: url.searchParams.get('pw') ? 'contraseña incorrecta' : 'esta sala tiene contraseña' });
        conn.close(1008, 'password');
        return;
      }
      const presented = (url.searchParams.get('code') || '').toUpperCase();
      if (presented !== room.code) {
        conn.send({ t: 'error', message: 'código de sala incorrecto' });
        conn.close(1008, 'bad room');
        return;
      }
      const wantedSeat = Number(url.searchParams.get('seat') || 0);
      if (wantedSeat && (!Number.isInteger(wantedSeat) || wantedSeat < 1 || wantedSeat > room.seats.length)) {
        conn.send({ t: 'error', message: 'puesto solicitado inválido' });
        conn.close(1008, 'bad seat');
        return;
      }
      if (wantedSeat) {
        room.prunePresent(connectedIds());
        const taken = room.seats.find((s) => s.index === wantedSeat && s.clientId !== null);
        if (taken) {
          conn.send({ t: 'error', message: `el puesto ${wantedSeat} ya está ocupado` });
          conn.close(1008, 'seat taken');
          return;
        }
      }

      const askedName = cleanName(url.searchParams.get('name'));
      const seat = url.searchParams.get('spectate') === '1' ? null : room.claim(conn.id, askedName);
      if (!seat) {
        conn.displayName = askedName || 'espectador';
        conn.send({ t: 'welcome', seat: null, role: 'spectator', code: room.code, ...seatsPayload() });
        log(`[sala] ${conn.remoteAddress} entra como espectador (${conn.displayName})`);
        broadcastSeats();
      } else {
        conn.displayName = askedName || `invitado-${seat.index}`;
      }
      if (seat && wantedSeat && seat.index !== wantedSeat) {
        // Libre pero no el primero: se mueve el recién llegado a su puesto.
        room.free(conn.id);
        const target = room.seats[wantedSeat - 1];
        target.clientId = conn.id;
        target.name = conn.displayName || `invitado-${target.index}`;
        target.since = Date.now();
      }

      const assigned = room.seatOf(conn.id);
      if (assigned) {
        log(`[sala] ${conn.remoteAddress} ocupa el puesto ${assigned.index} (${assigned.name})`);
        conn.send({ t: 'welcome', seat: assigned.index, role: 'player', code: room.code, ...seatsPayload() });
        broadcastSeats();
      }
      if (chatLog.length) conn.send({ t: 'chat-history', messages: chatLog });

      // Pads arrive over the WebSocket or, on a direct connection, an unordered data channel: `n` counts
      // up per page, so a state that arrives after a newer one is ignored.
      const applyPad = (msg) => {
        const seatNow = room.seatOf(conn.id);
        if (!seatNow) return;
        if (Number.isInteger(msg.n)) {
          if (msg.n <= (conn.lastPadN ?? -1)) return;
          conn.lastPadN = msg.n;
        }
        const budget = padBudget.get(conn.id) || { windowStart: Date.now(), count: 0 };
        if (Date.now() - budget.windowStart >= 1000) {
          budget.windowStart = Date.now();
          budget.count = 0;
        }
        budget.count += 1;
        padBudget.set(conn.id, budget);
        if (budget.count > PAD_PER_SEC) return; // límite por cliente

        const pad = normalizePad(msg);
        room.setPad(conn.id, pad);
        backend.apply(seatNow.index, pad);
      };

      const closeRtc = () => {
        if (!conn.rtc) return;
        conn.rtc.close();
        conn.rtc = null;
        hub?.transportChanged(conn);
      };

      const handleRtc = async (msg) => {
        if (msg.op === 'start') {
          closeRtc();
          const open = [...ws.connections].filter((c) => c.rtc).length;
          if (!rtcOn || !rtcAvailable() || !hub || open >= RTC_MAX) { conn.send({ t: 'rtc', op: 'unavailable' }); return; }
          const link = new RtcLink({
            log,
            onMessage: (text) => {
              let m;
              try { m = JSON.parse(text); } catch { return; }
              if (m && m.t === 'pad') applyPad(m); // the data channel carries controls only
            },
            onState: (state) => {
              if (conn.rtc !== link) return;
              conn.send({ t: 'rtc', op: 'state', state });
              if (state === 'connected') log(`[rtc] ${conn.remoteAddress} conectado directo`);
              if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                log(`[rtc] ${conn.remoteAddress}: ${state}; sigue por WebSocket`);
                closeRtc();
                return;
              }
              hub.transportChanged(conn);
            },
          });
          conn.rtc = link;
          try {
            const sdp = await link.offer();
            if (conn.rtc === link) conn.send({ t: 'rtc', op: 'offer', sdp });
          } catch (err) {
            log(`[rtc] no pude crear la oferta: ${err.message}`);
            if (conn.rtc === link) closeRtc();
            conn.send({ t: 'rtc', op: 'unavailable' });
          }
          return;
        }
        if (msg.op === 'answer' && conn.rtc && typeof msg.sdp === 'string' && msg.sdp.length < 20000) {
          try { await conn.rtc.answer(msg.sdp); }
          catch (err) { log(`[rtc] respuesta inválida: ${err.message}`); closeRtc(); conn.send({ t: 'rtc', op: 'state', state: 'failed' }); }
          return;
        }
        if (msg.op === 'stop') closeRtc();
      };

      conn.on('message', (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;

        if (msg.t === 'ping') {
          conn.send({ t: 'pong', id: msg.id ?? null });
          return;
        }
        if (msg.t === 'va') {
          hub?.ack(conn, Number(msg.s)); // a video frame arrived at the page
          return;
        }
        if (msg.t === 'video') {
          // The page says what it can decode (H.264 with WebCodecs, or JPEG), which quality it wants and
          // what it watches: the whole game, its own screen or another player's.
          if (!hub) return;
          hub.subscribe(conn, {
            codec: msg.codec === 'jpeg' ? 'jpeg' : 'h264',
            mode: String(msg.quality || 'auto'),
            view: String(msg.view || 'all'),
          });
          if (msg.codec === 'jpeg') log(`[vídeo] ${conn.remoteAddress} recibe JPEG (sin WebCodecs)`);
          return;
        }
        if (msg.t === 'chat' || msg.t === 'emote') {
          // Chat and emotes go to everyone in the room, players and spectators, with a per-person limit.
          const now = Date.now();
          conn.chatTimes = (conn.chatTimes || []).filter((t) => now - t < CHAT_WINDOW_MS);
          if (conn.chatTimes.length >= CHAT_PER_WINDOW) return;
          const seat = room.seatOf(conn.id);
          const from = { name: seat ? seat.name : conn.displayName || 'espectador', seat: seat ? seat.index : null };
          if (msg.t === 'emote') {
            if (!EMOTES.includes(msg.e)) return;
            conn.chatTimes.push(now);
            ws.broadcast({ t: 'emote', e: msg.e, ...from });
            return;
          }
          const body = cleanChat(msg.text);
          if (!body) return;
          conn.chatTimes.push(now);
          const entry = { t: 'chat', text: body, at: now, ...from };
          chatLog.push(entry);
          if (chatLog.length > CHAT_HISTORY) chatLog.shift();
          ws.broadcast(entry);
          return;
        }
        if (msg.t === 'rtc') {
          handleRtc(msg);
          return;
        }
        if (msg.t === 'audio') {
          if (!audio) { conn.send({ t: 'audio', on: false, available: false }); return; }
          if (msg.on) audio.subscribe(conn); else audio.unsubscribe(conn);
          conn.send({ t: 'audio', on: Boolean(msg.on), available: true });
          return;
        }
        if (msg.t === 'want') {
          // Lobby: the character this player wants next time the host restarts the game.
          const character = CHARACTERS.includes(msg.character) ? msg.character : null;
          if (room.setWant(conn.id, character)) broadcastSeats();
          return;
        }
        if (msg.t === 'name') {
          const name = cleanName(msg.name);
          if (!name) return;
          conn.displayName = name;
          if (room.rename(conn.id, name)) broadcastSeats();
          return;
        }
        if (msg.t === 'claim') {
          if (room.seatOf(conn.id)) {
            conn.send({ t: 'claim-result', ok: false, message: 'ya ocupas un puesto' });
            return;
          }
          const wanted = Number.isInteger(msg.seat) ? msg.seat : 0;
          const claimed = room.claim(conn.id, conn.displayName, wanted);
          if (!claimed) {
            conn.send({ t: 'claim-result', ok: false, message: wanted ? `el puesto ${wanted} ya está ocupado` : 'no hay un puesto libre' });
            return;
          }
          conn.send({ t: 'assigned', seat: claimed.index, role: 'player', ...seatsPayload() });
          log(`[sala] ${conn.remoteAddress} toma el puesto ${claimed.index} (${claimed.name})`);
          hub?.reroute(conn);
          broadcastSeats();
          return;
        }
        if (msg.t === 'pad') {
          applyPad(msg);
          return;
        }
        if (msg.t === 'release') {
          const freed = room.free(conn.id);
          if (freed) {
            backend.release(freed.index);
            log(`[sala] puesto ${freed.index} liberado por ${conn.remoteAddress}`);
          }
          conn.send({ t: 'released', role: 'spectator', ...seatsPayload() });
          hub?.reroute(conn);
          broadcastSeats();
          return;
        }
      });

      conn.on('close', () => {
        if (conn.rtc) { conn.rtc.close(); conn.rtc = null; }
        hub?.unsubscribe(conn);
        audio?.unsubscribe(conn);
        padBudget.delete(conn.id);
        const freed = room.free(conn.id);
        if (freed) {
          backend.release(freed.index);
          log(`[sala] puesto ${freed.index} libre (desconexión)`);
        }
        broadcastSeats();
      });
    },
  });

  function seatsPayload() {
    return {
      seats: room.snapshot().seats, spectators: spectatorCount(), game: modInfo,
      options: { characters: CHARACTERS }, features: { audio: Boolean(audio), rtc: rtcOn },
    };
  }

  function broadcastSeats() {
    ws.broadcast({ t: 'seats', ...seatsPayload() });
  }

  function spectatorCount() {
    return [...ws.connections].filter((conn) => !room.seatOf(conn.id)).length;
  }

  // Los puestos guardan el id de la conexión, no la conexión: prunePresent
  // necesita el conjunto de ids vivos, no de objetos.
  function connectedIds() {
    return new Set([...ws.connections].map((c) => c.id));
  }

  // Vigila clientes mudos y puestos huérfanos.
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const conn of ws.connections) {
      if (now - conn.lastSeen > 15000) {
        conn.close(1001, 'sin actividad');
      }
    }
    if (room.prunePresent(connectedIds())) broadcastSeats();
  }, 2000);

  server.listen(cfg.port, cfg.host, () => {
    const base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
    log('');
    log('  Puerta web lista');
    log(`  URL:   ${base}/?code=${room.code}`);
    log(`  Sala:  ${room.code}  puestos: ${room.seats.length}`);
    log(`  Mando: backend ${backend.name}`);
    log(`  Vídeo: ${hub
      ? `H.264 ${cfg.source} @${cfg.fps}fps: alta ${cfg.height}p ${cfg.bitrate} kbps, baja ${cfg.lowHeight}p ${cfg.lowBitrate} kbps, ` +
        `cada jugador ${cfg.playerHeight}p ${cfg.playerBitrate} kbps (${cfg.encoder})`
      : 'desactivado'}`);
    if (cfg.host === '0.0.0.0') {
      log('  Aviso: escuchando en todas las interfaces. La sala no tiene autenticación');
      log('         aparte del código; úsala solo en LAN o VPN (Tailscale).');
    }
    log('');
    if (hub) hub.start();
  });

  const shutdown = () => {
    log('[gateway] cerrando');
    clearInterval(watchdog);
    ws.closeAll();
    video?.stop();
    hub?.stop();
    audio?.stop();
    if (gamePoll) clearInterval(gamePoll);
    game?.close();
    closing = true;
    if (windowKeeper) { try { windowKeeper.kill(); } catch { /* ya terminó */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
