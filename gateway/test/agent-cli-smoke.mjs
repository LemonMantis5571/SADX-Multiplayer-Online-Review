import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'gateway', 'agent-cli.mjs');
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'sadx-agent-cli-'));
const env = { ...process.env, SADX_AGENT_STATE_DIR: stateDir };

function run(args, { input, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    input,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function parseJson(text) {
  return JSON.parse(text.trim());
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

let roomStarted = false;
let roomUrl = '';

try {
  const port = await freePort();
  roomUrl = `http://127.0.0.1:${port}`;

  const badGameStart = run(
    ['game', 'start', '--exe', path.join(stateDir, 'missing.exe'), '--arg', '--multi'],
    { allowFailure: true },
  );
  assert.notEqual(badGameStart.status, 0);
  assert.match(parseJson(badGameStart.stderr).error, /no existe el ejecutable/);
  console.log('  ok   --arg acepta opciones de SADX que empiezan con --');

  const emptyShare = parseJson(run(['share', 'status']).stdout);
  assert.equal(emptyShare.managed, false);
  const stoppedShare = parseJson(run(['share', 'stop']).stdout);
  assert.equal(stoppedShare.alreadyStopped, true);
  console.log('  ok   share status y stop convergen si no hay un túnel');

  if (process.platform === 'win32') {
    const noMultiplayer = run([
      'game', 'start', '--exe', process.execPath, '--no-multiplayer',
    ], { allowFailure: true });
    assert.notEqual(noMultiplayer.status, 0);
    assert.match(parseJson(noMultiplayer.stderr).error, /terminó durante el arranque \(código 0/);
    console.log('  ok   --no-multiplayer omite los argumentos por defecto');

    const stalePid = 4_000_000_000;
    writeFileSync(path.join(stateDir, 'game.json'), JSON.stringify({
      pid: stalePid,
      exe: process.execPath,
      args: [],
      startedAt: Date.now(),
    }));
    const gameStatus = parseJson(run(['game', 'status']).stdout);
    assert.equal(gameStatus.managed, true);
    assert.equal(gameStatus.running, false);
    assert.equal(gameStatus.processFound, false);
    const staleStop = parseJson(run(['game', 'stop']).stdout);
    assert.equal(staleStop.alreadyExited, true);
    assert.equal(parseJson(run(['game', 'status']).stdout).managed, false);
    assert.equal(parseJson(run(['game', 'stop']).stdout).alreadyStopped, true);

    const managedProcess = parseJson(run([
      'game', 'start', '--exe', process.execPath,
      '--arg', '-e', '--arg', 'setTimeout(()=>{},60000)',
    ]).stdout);
    assert.equal(managedProcess.running, true);
    const liveStatus = parseJson(run(['game', 'status']).stdout);
    assert.equal(liveStatus.running, true);
    assert.equal(liveStatus.processMatches, true);
    assert.equal(liveStatus.pid, managedProcess.pid);
    assert.equal(parseJson(run(['game', 'stop']).stdout).stopped, true);
    assert.equal(parseJson(run(['game', 'status']).stdout).managed, false);
    console.log('  ok   CLI confirma, termina y limpia su proceso administrado');
  }

  const start = parseJson(run([
    'room', 'start', '--host', '127.0.0.1', '--port', String(port), '--backend', 'log', '--no-video',
  ]).stdout);
  roomStarted = true;
  assert.equal(start.ok, true);
  assert.equal(start.status.seats, 4);
  console.log('  ok   CLI inicia y publica una sala local');

  const lines = [
    { op: 'room.status', url: roomUrl },
    { op: 'connect', seat: 1, name: 'cli-smoke', url: roomUrl },
    { op: 'input', buttons: ['a'], axes: { ly: -1 }, durationMs: 120 },
    { op: 'release' },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const agentOutput = run(['--stdio'], { input: `${lines}\n` });
  const replies = agentOutput.stdout.trim().split(/\r?\n/).map(parseJson);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[1].connected, true);
  assert.equal(replies[1].seat, 1);
  assert.ok(replies[2].sent >= 1);
  assert.equal(replies[3].released, true);
  console.log('  ok   agente JSONL consulta, controla y libera un puesto');

  const status = parseJson(run(['room', 'status', '--url', roomUrl]).stdout);
  assert.equal(status.status.room.seats[0].occupied, false);
  assert.ok(status.status.input.perSeat['1'] > 0);
  console.log('  ok   la sala registra el mando y libera el puesto al terminar');

  const doctorOutput = run(['--stdio'], {
    input: `${JSON.stringify({ op: 'doctor', url: roomUrl })}\n`,
  });
  const doctor = parseJson(doctorOutput.stdout);
  assert.equal(doctor.checks.gateway.ok, true);
  assert.equal(doctor.checks.ffmpeg.skipped, true);
  console.log('  ok   doctor no exige ffmpeg cuando la sala desactiva vídeo');

  const stopped = parseJson(run(['room', 'stop']).stdout);
  roomStarted = false;
  assert.equal(stopped.stopped, true);
  const afterStop = run(['room', 'status', '--url', roomUrl], { allowFailure: true });
  assert.notEqual(afterStop.status, 0);
  console.log('  ok   CLI cierra la sala administrada');

  console.log('CLI listo');
} finally {
  if (roomStarted) {
    run(['room', 'stop'], { allowFailure: true });
  }
  rmSync(stateDir, { recursive: true, force: true });
}
