import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_SEAT } from '../lib/rooms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, '..');
const ROOT = path.resolve(GATEWAY, '..');
const CLI = path.join(GATEWAY, 'agent-cli.mjs');
const STATE_DIR = path.resolve(process.env.SADX_AGENT_STATE_DIR || path.join(GATEWAY, '.agent-state'));
const ROOM_STATE = path.join(STATE_DIR, 'room.json');
const TUNNEL_STATE = path.join(STATE_DIR, 'tunnel.json');
const GAME_STATE = path.join(STATE_DIR, 'game.json');
const FOCUS_SCRIPT = path.join(GATEWAY, 'lib', 'focus-game-window.ps1');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GUEST_SEAT = HOST_SEAT + 1; // the seat Edge takes and moves (the host PC plays HOST_SEAT)

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--url') throw new Error(`opción desconocida: ${argv[i]}`);
    if (!argv[i + 1]) throw new Error('falta la URL después de --url');
    result.url = argv[++i];
  }
  return result;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function resolveEdge() {
  const candidates = [
    process.env.SADX_BROWSER_EXE,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES_X86 && path.join(process.env.PROGRAMFILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (found) return found;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['msedge'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim().split(/\r?\n/)[0];
  throw new Error('no encuentro Microsoft Edge; configura SADX_BROWSER_EXE con la ruta de msedge.exe');
}

function roomTarget() {
  const tunnel = readJson(TUNNEL_STATE);
  if (tunnel?.url && tunnel?.code) return `${tunnel.url}/?code=${encodeURIComponent(tunnel.code)}`;
  const room = readJson(ROOM_STATE);
  if (room?.url) return `${room.url}/?code=${encodeURIComponent(room.code || '')}`;
  throw new Error('no hay una sala administrada ni un túnel guardado; pasa --url');
}

function resolveBrowserHost(host) {
  if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(host)) return null;
  const script = `$answers=Resolve-DnsName -Name '${host}' -Server '8.8.8.8' -Type A -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'A' } | Select-Object -ExpandProperty IPAddress; $answers`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  const address = (result.stdout || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  if (result.status !== 0 || !address) throw new Error(`no pude resolver ${host} usando DNS público`);
  return address;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return data;
}

async function connectRoomClient(pageUrl, name) {
  const target = new URL(pageUrl);
  const code = target.searchParams.get('code');
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/ws';
  target.search = new URLSearchParams({ code, name }).toString();
  const ws = new WebSocket(target.href);
  const timeout = setTimeout(() => ws.close(), 5000);
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === 'welcome') {
        clearTimeout(timeout);
        resolve({ ws, welcome: message });
      } else if (message.t === 'error') {
        clearTimeout(timeout);
        reject(new Error(message.message || 'el gateway rechazó al cliente de prueba'));
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('falló la conexión WebSocket de prueba'));
    }, { once: true });
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      reject(new Error('el gateway cerró al cliente de prueba antes de asignarlo'));
    }, { once: true });
  });
}

function getModStatus() {
  const result = spawnSync(process.execPath, [CLI, 'mod', 'status'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'SADX no respondió al estado del mod');
  const value = JSON.parse(result.stdout);
  if (!value.mod?.multiplayerActive) throw new Error('el modo multijugador de SADX no está activo');
  const player = value.mod.players?.find((entry) => entry.seat === GUEST_SEAT);
  if (!player) throw new Error(`el mod no reportó al personaje del puesto ${GUEST_SEAT}`);
  return player;
}

function focusGame() {
  const result = spawnSync(process.execPath, [CLI, 'game', 'focus'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 8000,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'no pude traer SADX al frente');
}

function startFocusGuard(pid) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SCRIPT,
    '-TargetPid', String(pid), '-HoldMilliseconds', '90000',
  ].map(quote).join(',');
  const command = `$focusProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(${args}) -PassThru -WindowStyle Hidden; Write-Output $focusProcess.Id`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 8000,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'no pude mantener SADX al frente');
  const childPid = Number((result.stdout || '').trim().split(/\r?\n/).at(-1));
  if (!Number.isInteger(childPid) || childPid <= 0) throw new Error('Windows no devolvió el PID del guardián de foco');
  return { pid: childPid };
}

function stopFocusGuard(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  } else {
    try { process.kill(child.pid); } catch { /* already exited */ }
  }
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || 'falló una orden CDP'));
    else entry.resolve(message.result || {});
  });
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('Edge cerró la sesión de depuración'));
    pending.clear();
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge no abrió el canal CDP')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('no se pudo conectar al canal CDP')); }, { once: true });
  });
  return {
    ws,
    async send(method, params = {}) {
      await ready;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

async function waitForBrowser(portFile, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Edge terminó al iniciar (código ${child.exitCode})`);
    try {
      const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (port > 0) return port;
    } catch { /* Edge is still starting. */ }
    await sleep(100);
  }
  throw new Error('Edge no publicó el puerto de depuración');
}

async function waitForPage(port, origin) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith(origin));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* DevTools is still starting. */ }
    await sleep(100);
  }
  throw new Error('Edge abrió, pero no encontró la página de la sala');
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'falló la evaluación en Edge');
  return response.result?.value;
}

async function waitForSeat(cdp, expectedSeat = '1') {
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, `({
      ready: document.readyState,
      connection: document.querySelector('#connText')?.textContent,
      seat: document.querySelector('#seatChip')?.textContent,
      message: document.querySelector('#msg')?.textContent
    })`);
    if (last?.connection === 'conectado' && last.seat === expectedSeat) return last;
    if (last?.connection === 'error de conexión' || last?.message?.includes('lleno')) {
      throw new Error(`la página no pudo entrar a la sala: ${JSON.stringify(last)}`);
    }
    await sleep(200);
  }
  throw new Error(`Edge no llegó al estado ${expectedSeat}: ${JSON.stringify(last)}`);
}

async function waitForVideo(cdp) {
  const deadline = Date.now() + 10000;
  let image = null;
  while (Date.now() < deadline) {
    // #stream is a canvas the page draws decoded frames on; data-frames counts them.
    image = await evaluate(cdp, `(() => {
      const el = document.querySelector('#stream');
      const drawn = Number(el?.dataset.frames || 0) > 0;
      return { width: drawn ? el.width : 0, height: drawn ? el.height : 0, frames: Number(el?.dataset.frames || 0) };
    })()`);
    if (image?.width > 0 && image?.height > 0) return image;
    await sleep(250);
  }
  throw new Error(`Edge entró a la sala, pero no recibió imagen: ${JSON.stringify(image)}`);
}

async function cleanupBrowser(child, profileDir, cdp) {
  cdp?.close();
  if (child?.pid && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  } else {
    try { child?.kill(); } catch { /* already exited */ }
  }
  if (profileDir) {
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(profileDir);
    if (target.startsWith(`${tempRoot}${path.sep}`)) {
      let lastError;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { rmSync(target, { recursive: true, force: true }); return; }
        catch (error) {
          lastError = error;
          if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
          await sleep(250 * (attempt + 1));
        }
      }
      throw lastError;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof WebSocket !== 'function') throw new Error('Node 22 o posterior es necesario para WebSocket');
  const targetUrl = new URL(opts.url || roomTarget());
  const origin = targetUrl.origin;
  const roomState = readJson(ROOM_STATE);
  const gameState = readJson(GAME_STATE);
  if (!gameState?.pid) throw new Error('inicia SADX desde el CLI antes de correr la prueba del navegador');
  const roomOrigin = roomState?.url || origin;
  const localStatus = await getJson(`${roomOrigin}/api/status`);
  if (!targetUrl.searchParams.has('code')) targetUrl.searchParams.set('code', localStatus.room.code);
  const edge = resolveEdge();
  if (!localStatus.room?.code || localStatus.room.code !== targetUrl.searchParams.get('code')) {
    throw new Error('el enlace apunta a una sala distinta o el código no coincide');
  }
  if (localStatus.room.seats?.some((seat) => seat.occupied && !seat.host)) throw new Error('libera los puestos de invitados antes de correr la prueba de navegador');
  const guestSeats = localStatus.room.seats.filter((seat) => !seat.host).map((seat) => seat.index);
  const localPageUrl = `${roomOrigin}/?code=${encodeURIComponent(localStatus.room.code)}`;
  const mappedAddress = resolveBrowserHost(targetUrl.hostname);

  const blockers = [];
  let profileDir = null;
  let child;
  let cdp;
  let focusGuard;
  let initialPosition;
  let joined = false;
  try {
    focusGame();
    focusGuard = startFocusGuard(gameState.pid);
    await sleep(600);
    initialPosition = getModStatus();
    for (const index of guestSeats) {
      const client = await connectRoomClient(localPageUrl, `browser-e2e-${index}`);
      blockers.push(client);
      if (client.welcome.role !== 'player' || client.welcome.seat !== index) {
        throw new Error(`el puesto ${index} no fue asignado al preparar el aforo`);
      }
    }
    console.log('  ok   puestos de invitados ocupados para probar la llegada de oyentes extra');
    console.log('  ok   SADX se mantiene al frente durante la prueba de video e input');

    const tempRoot = path.resolve(os.tmpdir());
    profileDir = mkdtempSync(path.join(tempRoot, 'sadx-browser-e2e-'));
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    child = spawn(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0',
      ...(mappedAddress ? [`--host-resolver-rules=MAP ${targetUrl.hostname} ${mappedAddress}`] : []),
      `--user-data-dir=${profileDir}`, targetUrl.href,
    ], { cwd: GATEWAY, stdio: 'ignore', windowsHide: true });
    const port = await waitForBrowser(portFile, child);
    const page = await waitForPage(port, origin);
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const spectator = await waitForSeat(cdp, 'espectador');
    joined = true;
    console.log(`  ok   Edge entró como ${spectator.seat} con los puestos de invitados ocupados`);
    const video = await waitForVideo(cdp);
    console.log(`  ok   Edge recibió el video de ${video.width}×${video.height}`);

    const spectatorBackendBefore = await getJson(`${roomOrigin}/api/status`);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w', unmodifiedText: 'w',
    });
    await sleep(450);
    const spectatorInput = await evaluate(cdp, `({ source: document.querySelector('#srcChip')?.textContent, pad: document.querySelector('#padInfo')?.textContent })`);
    const spectatorPosition = getModStatus();
    const spectatorBackendAfter = await getJson(`${roomOrigin}/api/status`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    const spectatorInputCount = spectatorBackendAfter.input.totalMessages - spectatorBackendBefore.input.totalMessages;
    if (spectatorInput?.source !== 'espectador' || spectatorInput?.pad !== 'solo observas' || spectatorPosition.browserInput || spectatorInputCount !== 0) {
      throw new Error(`el espectador no quedó aislado de los mandos: ${JSON.stringify({ spectatorInput, modInput: spectatorPosition.browserInput, spectatorInputCount })}`);
    }
    console.log('  ok   el espectador ve el juego y W no controla un puesto');

    blockers[0].ws.send(JSON.stringify({ t: 'release' }));
    const seatDeadline = Date.now() + 3000;
    while (Date.now() < seatDeadline) {
      const status = await getJson(`${roomOrigin}/api/status`);
      if (!status.room.seats[GUEST_SEAT - 1].occupied) break;
      await sleep(100);
    }
    let claimButton = null;
    const claimDeadline = Date.now() + 3000;
    while (Date.now() < claimDeadline) {
      claimButton = await evaluate(cdp, `({ hidden: document.querySelector('#claimBtn')?.hidden, disabled: document.querySelector('#claimBtn')?.disabled })`);
      if (claimButton?.hidden === false && claimButton?.disabled === false) break;
      await sleep(100);
    }
    if (claimButton?.hidden !== false || claimButton?.disabled) throw new Error('la página no ofreció tomar el puesto que quedó libre');
    await evaluate(cdp, "document.querySelector('#claimBtn').click()");
    const seat = await waitForSeat(cdp, String(GUEST_SEAT));
    console.log(`  ok   el espectador tomó el puesto ${seat.seat} al liberarse`);

    const before = getModStatus();
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w', unmodifiedText: 'w',
    });
    const deadline = Date.now() + 4000;
    let live = null;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(250);
      live = await evaluate(cdp, `({ source: document.querySelector('#srcChip')?.textContent, pad: document.querySelector('#padInfo')?.textContent })`);
      after = getModStatus();
      const distance = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
      if (live?.source === 'teclado' && /ly=-1\.00/.test(live.pad || '') && distance > 0.25) break;
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    const distance = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    if (live?.source !== 'teclado' || !/ly=-1\.00/.test(live.pad || '')) {
      throw new Error(`la página no mapeó W como movimiento adelante: ${JSON.stringify(live)}`);
    }
    if (distance <= 0.25) throw new Error(`W llegó al navegador, pero el personaje no se movió (${distance.toFixed(3)})`);
    console.log(`  ok   W envió ly=-1 por WSS y movió al personaje ${distance.toFixed(2)} unidades`);

    await evaluate(cdp, "document.querySelector('#releaseBtn').click()");
    const releaseDeadline = Date.now() + 3000;
    while (Date.now() < releaseDeadline) {
      const status = await getJson(`${roomOrigin}/api/status`);
      if (!status.room.seats[GUEST_SEAT - 1].occupied) break;
      await sleep(150);
    }
    const finalStatus = await getJson(`${roomOrigin}/api/status`);
    if (finalStatus.room.seats[GUEST_SEAT - 1].occupied) throw new Error('Edge no liberó el puesto al terminar');
    console.log('  ok   el puesto quedó libre al finalizar la prueba');
  } finally {
    if (joined && cdp) {
      try { await evaluate(cdp, "document.querySelector('#releaseBtn').click()"); } catch { /* browser may be closing */ }
    }
    for (const client of blockers) {
      try {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ t: 'release' }));
          client.ws.close();
        }
      } catch { /* the gateway may already have closed this test client */ }
    }
    try { await cleanupBrowser(child, profileDir, cdp); }
    finally { stopFocusGuard(focusGuard); }
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
