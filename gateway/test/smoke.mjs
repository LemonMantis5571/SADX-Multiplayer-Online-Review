// Prueba de humo de la puerta: sala, puestos, pads y liberación.
// No necesita el juego ni ffmpeg (arranca con --no-video y backend log).
//
//   node gateway/test/smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = Number(process.env.SMOKE_PORT || 8199); // not the room's usual 8123: never touch a live room
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function status() {
  const res = await fetch(`${BASE}/api/status`);
  if (!res.ok) throw new Error(`/api/status ${res.status}`);
  return res.json();
}

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await status();
    } catch {
      if (Date.now() > deadline) throw new Error('el servidor no respondió');
      await sleep(150);
    }
  }
}

function openSocket(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${code}&name=smoke`);
    const messages = [];
    ws.addEventListener('message', (ev) => {
      try {
        messages.push(JSON.parse(ev.data));
      } catch {
        /* ignora basura */
      }
    });
    ws.addEventListener('open', () => resolve({ ws, messages }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws timeout')), 4000);
  });
}

// --no-game: the room must not adopt or relaunch the real SADX from .agent-state/game.json.
const child = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-video', '--no-game', '--backend', 'log', '--seats', '4'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => { serverLog += c.toString(); });
child.stderr.on('data', (c) => { serverLog += c.toString(); });

try {
  console.log('puerta web — prueba de humo');
  const first = await waitForServer();
  const code = first.room.code;
  check('sala creada con código de 5 caracteres', typeof code === 'string' && code.length === 5, code);
  check('4 puestos declarados', first.seats === 4, String(first.seats));
  check('todos los puestos libres al arrancar', first.room.seats.every((s) => !s.occupied));

  // Código incorrecto: el servidor debe rechazar.
  const wrong = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=ZZZZZ`);
    ws.addEventListener('close', (ev) => resolve(ev.code));
    ws.addEventListener('error', () => resolve('error'));
  });
  check('código incorrecto rechazado', wrong === 1008, String(wrong));

  // Dos clientes ocupan los dos primeros puestos.
  const a = await openSocket(code);
  await sleep(150);
  const b = await openSocket(code);
  await sleep(200);

  const welcomeA = a.messages.find((m) => m.t === 'welcome');
  const welcomeB = b.messages.find((m) => m.t === 'welcome');
  check('cliente A recibe bienvenida en el puesto 1', welcomeA?.seat === 1, JSON.stringify(welcomeA));
  check('cliente B recibe bienvenida en el puesto 2', welcomeB?.seat === 2, JSON.stringify(welcomeB));

  let st = await status();
  check('dos puestos ocupados', st.room.seats.filter((s) => s.occupied).length === 2, JSON.stringify(st.room.seats.map((s) => s.occupied)));

  // Un puesto ocupado debe sobrevivir al vigilante, que corre cada 2 s.
  await sleep(2600);
  st = await status();
  check(
    'los puestos siguen ocupados tras pasar el vigilante',
    st.room.seats[0].occupied && st.room.seats[1].occupied,
    JSON.stringify(st.room.seats.map((s) => s.occupied)),
  );

  // Mando: un botón y un eje.
  a.ws.send(JSON.stringify({ t: 'pad', b: { a: true, up: true }, a: { lx: 0.5, ly: -1 } }));
  await sleep(250);
  st = await status();
  check('el pad llega al backend', st.input.totalMessages > 0, JSON.stringify(st.input));
  check('el puesto 1 tiene datos recientes', st.room.seats[0].padAge !== null && st.room.seats[0].padAge < 3000, String(st.room.seats[0].padAge));

  // Ping/pong.
  a.ws.send(JSON.stringify({ t: 'ping', id: 12345 }));
  await sleep(150);
  check('pong responde al ping', a.messages.some((m) => m.t === 'pong' && m.id === 12345));

  // Liberar puesto: queda como espectador pero el socket sigue vivo.
  a.ws.send(JSON.stringify({ t: 'release' }));
  await sleep(200);
  st = await status();
  check('liberar deja el puesto 1 libre', !st.room.seats[0].occupied);
  check('el socket de A sigue abierto tras liberar', a.ws.readyState === WebSocket.OPEN);

  // El espectador no puede mover el puesto liberado.
  const before = (await status()).input.totalMessages;
  a.ws.send(JSON.stringify({ t: 'pad', b: { b: true }, a: {} }));
  await sleep(200);
  const after = (await status()).input.totalMessages;
  check('un espectador sin puesto no mueve nada', after === before, `${before} -> ${after}`);

  // Desconexión: el puesto se libera solo.
  const preDisconnect = await status();
  check('el puesto 2 sigue ocupado antes de desconectar', preDisconnect.room.seats[1].occupied);
  b.ws.close();
  await sleep(3200); // deja correr el vigilante
  st = await status();
  check('desconectar libera el puesto 2', !st.room.seats[1].occupied, JSON.stringify(st.room.seats.map((s) => s.occupied)));

  // Los cuatro puestos son finitos, pero la audiencia puede entrar como espectadora.
  const clients = [];
  for (let i = 0; i < 4; i += 1) {
    clients.push(await openSocket(code));
    await sleep(120);
  }
  const fifth = await openSocket(code);
  await sleep(150);
  const welcomeFifth = fifth.messages.find((m) => m.t === 'welcome');
  check('el quinto cliente entra como espectador', welcomeFifth?.role === 'spectator' && welcomeFifth.seat === null, JSON.stringify(welcomeFifth));
  let full = await status();
  check('la sala cuenta a la audiencia espectadora', full.spectators >= 1, String(full.spectators));

  const beforeSpectatorPad = full.input.totalMessages;
  fifth.ws.send(JSON.stringify({ t: 'pad', b: { b: true }, a: {} }));
  await sleep(200);
  full = await status();
  check('el espectador no mueve un puesto ocupado', full.input.totalMessages === beforeSpectatorPad, `${beforeSpectatorPad} -> ${full.input.totalMessages}`);

  clients[0].ws.send(JSON.stringify({ t: 'release' }));
  await sleep(150);
  fifth.ws.send(JSON.stringify({ t: 'claim' }));
  await sleep(150);
  const assignedFifth = fifth.messages.find((m) => m.t === 'assigned');
  check('el espectador puede tomar un puesto cuando queda libre', assignedFifth?.seat === 1, JSON.stringify(assignedFifth));
  fifth.ws.send(JSON.stringify({ t: 'pad', b: { a: true }, a: { lx: 0.5 } }));
  await sleep(200);
  full = await status();
  check('el nuevo jugador ya puede mandar input', full.input.totalMessages > beforeSpectatorPad, JSON.stringify(full.input));

  for (const c of clients) c.ws.close();
  fifth.ws.close();
  a.ws.close();
} catch (err) {
  failures += 1;
  console.log(`  FAIL excepción: ${err.message}`);
  if (serverLog) console.log(serverLog.split('\n').slice(-15).join('\n'));
} finally {
  child.kill();
  await sleep(200);
  console.log(failures === 0 ? '\ntodo correcto' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
