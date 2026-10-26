#!/usr/bin/env node
// CLI and JSONL control surface for an AI agent or presentation host.
// It manages the web room, drives browser seats, checks the local SADX bridge,
// captures a frame, and launches/stops the exact SADX process it started.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveFfmpeg } from './lib/video.mjs';
import { chooseBackend } from './lib/gpu.mjs';
import { HOST_SEAT } from './lib/rooms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const STATE_DIR = path.resolve(process.env.SADX_AGENT_STATE_DIR || path.join(HERE, '.agent-state'));
const ROOM_STATE = path.join(STATE_DIR, 'room.json');
const GAME_STATE = path.join(STATE_DIR, 'game.json');
const TUNNEL_STATE = path.join(STATE_DIR, 'tunnel.json');
const SETTINGS = path.join(STATE_DIR, 'settings.json'); // what `up` reuses: room code, port, named tunnel
const DIST_MODS = path.join(path.dirname(HERE), 'dist', 'mods'); // the built mod and what it needs, for `setup`
const BUTTONS = ['a', 'b', 'x', 'y', 'up', 'down', 'left', 'right', 'lb', 'rb', 'lt', 'rt', 'start', 'back'];
const AXES = ['lx', 'ly', 'rx', 'ry'];
const FIRST_GUEST_SEAT = HOST_SEAT + 1; // the host PC plays HOST_SEAT; browsers start after it

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const durationFrom = (opts, fallback) => clamp(Number(opts.duration ?? opts.durationMs ?? opts.durationms ?? fallback), 0, 30000);
const intervalFrom = (opts) => clamp(Number(opts.interval ?? opts.intervalMs ?? opts.intervalms ?? 100), 25, 500);

function help() {
  return `SADX Online agent CLI

Room:
  node gateway/agent-cli.mjs room start [--host 0.0.0.0] [--share-host IP] [--port 8080]
      [--source "exe=sonic.exe"] [--backend udp] [--no-video]
  node gateway/agent-cli.mjs room status [--url http://127.0.0.1:8080]
  node gateway/agent-cli.mjs room stop [--keep-share]
  node gateway/agent-cli.mjs room restart        same code and port; the public link keeps working

Another PC (SADX-Online-instalar.cmd):
  node gateway/agent-cli.mjs setup --sadx "C:\\...\\Sonic Adventure DX" [--light] [--cstrike "C:\\...\\Half-Life"]
      installs the mod (dist/, or the repo's latest release through gh), tunes the Mod Loader profile
      (backed up first), checks ffmpeg/cloudflared, points the Counter-Strike soldiers at the host's own
      Counter-Strike 1.6 (found in Steam's libraries unless given);
      --light: a 960x720 window for weak integrated graphics

One click (SADX-Online.cmd / SADX-Online-cerrar.cmd):
  node gateway/agent-cli.mjs up [--room CODE] [--port 8123] [--level twinklepark] [--no-share] [--no-game] [--no-open]
      room + game + public link, and opens the host panel (QR, match, players)
  node gateway/agent-cli.mjs down                 closes link, game and room

Public browser link:
  node gateway/agent-cli.mjs share start [--url http://127.0.0.1:8080]
      [--cloudflared "...\\cloudflared.exe"]
      [--tunnel NAME --hostname sadx.example.com]   fixed link (named tunnel, saved for next time)
      [--quick]                                      random trycloudflare.com link even if one is saved
  node gateway/agent-cli.mjs share status
  node gateway/agent-cli.mjs share stop

Game and mod:
  node gateway/agent-cli.mjs game start [--exe "...\\sonic.exe"]
      [--level twinklepark] [--act 1] [--no-multiplayer] [--arg <argument>]
  node gateway/agent-cli.mjs game status
  node gateway/agent-cli.mjs game focus
  node gateway/agent-cli.mjs game stop
  node gateway/agent-cli.mjs mod status [--port 27016]
  node gateway/agent-cli.mjs mod neutral [--port 27016]

Browser controls and evidence:
  node gateway/agent-cli.mjs pad --seat 2 --buttons a --ly -1 --duration 1000
  node gateway/agent-cli.mjs capture [frame.jpg] [--url http://127.0.0.1:8080]
  node gateway/agent-cli.mjs doctor [--url http://127.0.0.1:8080]
  node gateway/agent-cli.mjs test
  node gateway/agent-cli.mjs test browser [--url <enlace-publico>]

Agent integration:
  node gateway/agent-cli.mjs --stdio
  Send one JSON request per line. Supported ops: up, down, room.start, room.status,
  room.stop, room.restart, share.start, share.status, share.stop, game.start, game.status,
  game.focus, game.stop, mod.status, mod.neutral, pad, capture, doctor,
  test.browser.
  For persistent control use connect, input, then release. Replies are one
  JSON object per line.

Options:
  --json     machine-readable output (the default)
  --human    concise output for a person
  --buttons  comma-separated: ${BUTTONS.join(', ')}
  --lx/--ly/--rx/--ry normalized axes in [-1, 1]
`;
}

function parseArgs(argv) {
  const result = { positionals: [], args: [] };
  const bools = new Set(['--no-video', '--human', '--json', '--stdio', '--verify-mod', '--no-multiplayer',
    '--keep-share', '--no-share', '--no-game', '--no-open', '--quick', '--light']);
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) {
      result.positionals.push(part);
      continue;
    }
    const [key, inline] = part.includes('=') ? part.split(/=(.*)/s) : [part, undefined];
    if (bools.has(key)) {
      result[key.slice(2).replaceAll('-', '')] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[i + 1];
    if (value === undefined || (key !== '--arg' && value.startsWith('--'))) throw new Error(`falta el valor de ${key}`);
    if (inline === undefined) i += 1;
    if (key === '--arg') result.args.push(value);
    else result[key.slice(2).replaceAll('-', '')] = value;
  }
  return result;
}

function baseUrl(value) {
  return String(value || 'http://127.0.0.1:8080').replace(/\/$/, '');
}

function firstLanAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const v4 = all.filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  return v4.find((ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) || v4[0] || '127.0.0.1';
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(3000) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${data.message || text || url}`);
  return data;
}

async function getStatus(url) {
  return httpJson(`${baseUrl(url)}/api/status`);
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readState(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`no se pudo leer ${file}: ${error.message}`); }
}

function readSettings() {
  try { return readState(SETTINGS) || {}; } catch { return {}; }
}

function saveSettings(changes) {
  ensureStateDir();
  writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), ...changes }, null, 2), 'utf8');
}

async function waitForStatus(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await getStatus(url); }
    catch (error) { lastError = error; await sleep(200); }
  }
  throw new Error(`la puerta no respondió en ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`);
}

async function roomStart(opts) {
  const port = clamp(Number(opts.port || 8080), 1, 65535);
  const host = opts.host || '0.0.0.0';
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${connectHost}:${port}`;
  const shareHost = opts.sharehost || (host === '0.0.0.0' ? firstLanAddress() : host);
  try {
    const status = await getStatus(url);
    return { ok: true, alreadyRunning: true, url: `${url}/?code=${status.room.code}`, shareUrl: `http://${shareHost}:${port}/?code=${status.room.code}`, status };
  } catch {
    // No existing room at this address; start the one managed by this CLI.
  }

  ensureStateDir();
  const token = crypto.randomBytes(32).toString('hex');
  const logPath = path.join(STATE_DIR, 'room.log');
  const logFd = openSync(logPath, 'a');
  const childArgs = [SERVER, '--host', host, '--port', String(port), '--seats', String(clamp(Number(opts.seats || 4), 1, 4)),
    '--source', opts.source || 'exe=sonic.exe', '--backend', opts.backend || 'udp',
    '--udp-port', String(clamp(Number(opts.udpport || 27016), 1, 65535)), '--admin-token', token];
  if (opts.ffmpeg) childArgs.push('--ffmpeg', opts.ffmpeg);
  if (opts.fps) childArgs.push('--fps', String(opts.fps));
  if (opts.height) childArgs.push('--height', String(opts.height));
  if (opts.quality) childArgs.push('--quality', String(opts.quality));
  if (opts.room) childArgs.push('--room', String(opts.room).toUpperCase()); // keep the code (and the shared link) across restarts
  if (opts.bitrate) childArgs.push('--bitrate', String(opts.bitrate));
  if (opts.encoder) childArgs.push('--encoder', String(opts.encoder));
  if (opts.novideo) childArgs.push('--no-video');

  let child;
  try {
    child = spawn(process.execPath, childArgs, { cwd: path.dirname(HERE), detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const state = { pid: child.pid, token, url, host, port, startedAt: Date.now(), logPath };
  writeFileSync(ROOM_STATE, JSON.stringify(state, null, 2), 'utf8');

  try {
    const status = await waitForStatus(url);
    saveSettings({ room: status.room.code, port });
    return { ok: true, alreadyRunning: false, pid: child.pid, url: `${url}/?code=${status.room.code}`, shareUrl: `http://${shareHost}:${port}/?code=${status.room.code}`, code: status.room.code, status };
  } catch (error) {
    try { child.kill(); } catch { /* process may already have exited */ }
    rmSync(ROOM_STATE, { force: true });
    throw error;
  }
}

async function roomStop(opts = {}) {
  const state = readState(ROOM_STATE);
  if (!state) throw new Error('no hay una sala administrada por este CLI');
  const tunnel = readState(TUNNEL_STATE);
  // The tunnel only points at the local port: a room that comes back on the same port and code keeps the link.
  if (tunnel?.localUrl === state.url && !opts.keepshare) await shareStop();
  await httpJson(`${state.url}/api/admin/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(2500),
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await getStatus(state.url); }
    catch { rmSync(ROOM_STATE, { force: true }); return { ok: true, stopped: true, pid: state.pid }; }
    await sleep(150);
  }
  throw new Error('se pidió cerrar la sala, pero el proceso sigue respondiendo');
}

/** Stops and starts the room with the same code and port, leaving the public link (and the game) running. */
async function roomRestart(opts = {}) {
  const state = readState(ROOM_STATE);
  if (!state) throw new Error('no hay una sala administrada por este CLI');
  const status = await getStatus(state.url);
  await roomStop({ keepshare: true });
  return roomStart({ ...opts, host: opts.host || state.host, port: state.port, room: opts.room || status.room.code });
}

async function roomStatus(opts = {}) {
  const status = await getStatus(opts.url);
  const url = baseUrl(opts.url);
  return { ok: true, url: `${url}/?code=${status.room.code}`, code: status.room.code, status };
}

function resolveCloudflared(requested) {
  const explicit = requested || process.env.SADX_CLOUDFLARED;
  if (explicit) {
    const direct = path.resolve(explicit);
    if (existsSync(direct)) return direct;
    const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [explicit], {
      encoding: 'utf8', windowsHide: true,
    });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
    throw new Error(`no encuentro cloudflared: ${explicit}`);
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const bundled = path.join(localAppData, 'SADXOnline', 'cloudflared.exe');
    if (existsSync(bundled)) return bundled;

    const packages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of readdirSync(packages)) {
        if (!entry.startsWith('Cloudflare.cloudflared_')) continue;
        const candidate = path.join(packages, entry, 'cloudflared.exe');
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* WinGet may not be installed. */ }
  }

  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['cloudflared'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
  throw new Error('cloudflared no está instalado; instálalo desde la página oficial de Cloudflare y vuelve a intentar');
}

function inspectTunnelProcess(state) {
  if (process.platform !== 'win32') throw new Error('el control seguro del túnel está implementado para Windows');
  const pid = Number(state.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('PID guardado del túnel inválido');
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if (!$p) { exit 3 }; $s=[DateTime]$p.CreationDate; $e=[DateTimeOffset]::FromUnixTimeMilliseconds(${Number(state.startedAt)}).LocalDateTime; if ([Math]::Abs(($s-$e).TotalSeconds) -gt 15) { exit 4 }; [pscustomobject]@{exe=$p.ExecutablePath; commandLine=$p.CommandLine} | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status === 3) return { running: false, processFound: false, pid };
  if (result.status === 4) return { running: false, processFound: true, processMatches: false, pid };
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Windows no pudo comprobar el proceso cloudflared');
  let actual;
  try { actual = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('Windows devolvió datos inválidos del proceso cloudflared'); }
  const expectedExe = path.resolve(state.exe).toLowerCase();
  const actualExe = path.resolve(actual.exe || '').toLowerCase();
  const commandLine = String(actual.commandLine || '');
  const hasTunnelArgs = /(?:^|\s)tunnel(?:\s|$)/i.test(commandLine) && commandLine.includes(state.localUrl);
  const processMatches = actualExe === expectedExe && hasTunnelArgs;
  return {
    running: processMatches,
    processFound: true,
    processMatches,
    pid,
    exe: actual.exe,
  };
}

function tunnelLink(state) {
  return state.url ? `${state.url}/?code=${state.code}` : null;
}

function readTunnelUrl(logPath) {
  try {
    const log = readFileSync(logPath, 'utf8');
    const match = log.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/i);
    return match ? match[0] : null;
  } catch { return null; }
}

async function waitForTunnelUrl(state, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = readTunnelUrl(state.logPath);
    if (url) return url;
    if (child.exitCode !== null) throw new Error(`cloudflared terminó al abrir el túnel (código ${child.exitCode})`);
    await sleep(200);
  }
  throw new Error(`cloudflared no publicó una URL en ${timeoutMs} ms; revisa ${state.logPath}`);
}

function checkTunnelWithPublicDns(state) {
  if (process.platform !== 'win32') return false;
  let host;
  try { host = new URL(state.url).hostname; }
  catch { return false; }
  if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(host)) return false;

  const dnsScript = `$answers=Resolve-DnsName -Name '${host}' -Server '8.8.8.8' -Type A -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'A' } | Select-Object -ExpandProperty IPAddress; $answers`;
  const dns = spawnSync('powershell.exe', ['-NoProfile', '-Command', dnsScript], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  const addresses = [...(dns.stdout || '').matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((match) => match[0]);
  for (const address of addresses) {
    const result = spawnSync('curl.exe', [
      '--resolve', `${host}:443:${address}`,
      '--max-time', '4', '--silent', '--show-error',
      '--write-out', '\n__SADX_HTTP_STATUS__=%{http_code}',
      `${state.url}/api/status`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = result.stdout || '';
    const marker = '\n__SADX_HTTP_STATUS__=';
    const markerAt = output.lastIndexOf(marker);
    if (result.status !== 0 || markerAt < 0 || Number(output.slice(markerAt + marker.length)) !== 200) continue;
    try {
      const status = JSON.parse(output.slice(0, markerAt));
      if (status.room?.code === state.code) return true;
    } catch { /* another response is not a valid room check */ }
  }
  return false;
}

async function checkPublicTunnel(state, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'el enlace todavía no responde';
  let dnsCacheCleared = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${state.url}/api/status`, { signal: AbortSignal.timeout(3000) });
      const data = await response.json();
      if (response.ok && data.room?.code === state.code) return { reachable: true, error: null };
      lastError = `el enlace respondió HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
      if (process.platform === 'win32' && error.cause?.code === 'ENOTFOUND' && checkTunnelWithPublicDns(state)) {
        return { reachable: true, error: null, dnsFallback: '8.8.8.8' };
      }
      if (!dnsCacheCleared && process.platform === 'win32' && error.cause?.code === 'ENOTFOUND') {
        const cleared = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Clear-DnsClientCache'], {
          encoding: 'utf8', windowsHide: true,
        });
        dnsCacheCleared = cleared.status === 0;
      }
    }
    await sleep(750);
  }
  return { reachable: false, error: lastError };
}

async function shareStart(opts = {}) {
  const roomState = readState(ROOM_STATE);
  const localUrl = baseUrl(opts.url || roomState?.url || 'http://127.0.0.1:8080');
  const room = await getStatus(localUrl);
  const existing = readState(TUNNEL_STATE);
  if (existing) {
    const processInfo = inspectTunnelProcess(existing);
    if (processInfo.running) {
      if (existing.localUrl !== localUrl) {
        throw new Error(`ya hay un túnel activo para ${existing.localUrl}; ciérralo antes de exponer otra sala`);
      }
      if (!existing.url) {
        existing.url = await waitForTunnelUrl(existing, { exitCode: null });
        writeFileSync(TUNNEL_STATE, JSON.stringify(existing, null, 2), 'utf8');
      }
      const reachability = await checkPublicTunnel(existing, 3000);
      return {
        ok: true,
        alreadyRunning: true,
        url: tunnelLink(existing),
        publicBaseUrl: existing.url,
        localUrl,
        code: existing.code,
        ...reachability,
      };
    }
    if (processInfo.processFound) throw new Error('el PID guardado pertenece a otro proceso; no lo cierro ni borro el estado del túnel');
    rmSync(TUNNEL_STATE, { force: true });
  }

  // A named tunnel (the host's own Cloudflare account and domain) gives the same link every time; without
  // one, cloudflared makes a quick tunnel with a new random trycloudflare.com address.
  if (opts.tunnel || opts.hostname) {
    if (!opts.tunnel || !opts.hostname) throw new Error('un túnel con nombre necesita --tunnel y --hostname');
    if (!/^[a-z0-9.-]+$/i.test(String(opts.hostname))) throw new Error(`nombre de host inválido: ${opts.hostname}`);
    saveSettings({ share: { tunnel: String(opts.tunnel), hostname: String(opts.hostname).toLowerCase() } });
  }
  const named = opts.quick ? null : readSettings().share || null;
  const executable = resolveCloudflared(opts.cloudflared);
  ensureStateDir();
  const logPath = path.join(STATE_DIR, 'tunnel.log');
  const logFd = openSync(logPath, 'w');
  const args = named
    ? ['tunnel', '--no-autoupdate', 'run', '--url', localUrl, named.tunnel]
    : ['tunnel', '--no-autoupdate', '--url', localUrl];
  let child;
  try {
    child = spawn(executable, args, { cwd: HERE, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
  } finally {
    closeSync(logFd);
  }
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();

  const state = {
    pid: child.pid,
    exe: executable,
    args,
    localUrl,
    code: room.room.code,
    startedAt: Date.now(),
    logPath,
    url: named ? `https://${named.hostname}` : null,
    named: Boolean(named),
  };
  writeFileSync(TUNNEL_STATE, JSON.stringify(state, null, 2), 'utf8');
  try {
    if (!named) {
      state.url = await waitForTunnelUrl(state, child);
      writeFileSync(TUNNEL_STATE, JSON.stringify(state, null, 2), 'utf8');
    }
    const reachability = await checkPublicTunnel(state, named ? 30000 : 15000);
    if (named && !reachability.reachable && child.exitCode !== null) throw new Error(`cloudflared terminó (código ${child.exitCode}); revisa ${logPath}`);
    return {
      ok: true,
      alreadyRunning: false,
      pid: state.pid,
      url: tunnelLink(state),
      publicBaseUrl: state.url,
      localUrl,
      code: state.code,
      ...reachability,
    };
  } catch (error) {
    await shareStop();
    throw error;
  }
}

async function shareStatus() {
  const state = readState(TUNNEL_STATE);
  if (!state) return { ok: true, managed: false, running: false };
  const processInfo = inspectTunnelProcess(state);
  if (!processInfo.running) {
    if (processInfo.processFound) throw new Error('el PID guardado pertenece a otro proceso; conserva el estado del túnel para revisarlo');
    rmSync(TUNNEL_STATE, { force: true });
    return { ok: true, managed: true, running: false, alreadyExited: true, pid: state.pid };
  }
  if (!state.url) {
    state.url = readTunnelUrl(state.logPath);
    if (state.url) writeFileSync(TUNNEL_STATE, JSON.stringify(state, null, 2), 'utf8');
  }
  const reachability = state.url
    ? await checkPublicTunnel(state, 3000)
    : { reachable: false, error: 'cloudflared todavía no anunció la URL pública' };
  return {
    ok: true,
    managed: true,
    running: true,
    ready: Boolean(state.url),
    pid: state.pid,
    url: tunnelLink(state),
    publicBaseUrl: state.url,
    localUrl: state.localUrl,
    code: state.code,
    logPath: state.logPath,
    ...reachability,
  };
}

async function shareStop() {
  const state = readState(TUNNEL_STATE);
  if (!state) return { ok: true, stopped: false, alreadyStopped: true };
  const processInfo = inspectTunnelProcess(state);
  if (!processInfo.running) {
    if (processInfo.processFound) throw new Error('el PID guardado pertenece a otro proceso; no lo cierro ni borro su estado');
    rmSync(TUNNEL_STATE, { force: true });
    return { ok: true, stopped: false, alreadyExited: true, pid: state.pid };
  }
  const killed = spawnSync('taskkill.exe', ['/PID', String(state.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const afterKill = inspectTunnelProcess(state);
    if (!afterKill.processFound) {
      rmSync(TUNNEL_STATE, { force: true });
      return { ok: true, stopped: true, pid: state.pid, url: tunnelLink(state) };
    }
    if (!afterKill.processMatches) throw new Error('el PID del túnel cambió de propietario durante el cierre; conservé el estado');
    await sleep(150);
  }
  throw new Error(killed.stderr.trim() || killed.stdout.trim() || 'cloudflared sigue abierto después de pedir el cierre');
}

function makePad(opts) {
  const b = Object.fromEntries(BUTTONS.map((name) => [name, false]));
  const rawButtons = Array.isArray(opts.buttons) ? opts.buttons.join(',') : String(opts.buttons || '');
  const names = rawButtons.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  for (const name of names) {
    if (!(name in b)) throw new Error(`botón desconocido: ${name}`);
    b[name] = true;
  }
  const axes = opts.axes && typeof opts.axes === 'object' ? opts.axes : {};
  const a = Object.fromEntries(AXES.map((name) => [name, clamp(Number(axes[name] ?? opts[name] ?? 0), -1, 1)]));
  return { b, a };
}

function websocketUrl(url, code, seat, name) {
  const target = new URL(baseUrl(url));
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/ws';
  target.search = new URLSearchParams({ code, seat: String(seat), name }).toString();
  return target.href;
}

async function connectSeat(url, code, seat, name) {
  if (typeof WebSocket !== 'function') throw new Error('Node 22 o posterior es necesario para WebSocket');
  const ws = new WebSocket(websocketUrl(url, code, seat, name));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('el gateway no asignó el puesto a tiempo')), 5000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { ws.close(); } catch { /* ignored */ } reject(error); }
      else resolve(value);
    };
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === 'welcome') finish(null, { ws, seat: message.seat, welcome: message });
      if (message.t === 'error') finish(new Error(message.message || 'gateway rechazó la conexión'));
    });
    ws.addEventListener('error', () => finish(new Error('falló la conexión WebSocket')));
    ws.addEventListener('close', () => finish(new Error('el gateway cerró la conexión')));
  });
}

async function pad(opts) {
  const url = baseUrl(opts.url);
  const status = await getStatus(url);
  const code = String(opts.code || status.room.code).toUpperCase();
  const requestedSeat = clamp(Number(opts.seat || FIRST_GUEST_SEAT), 1, status.seats || 4);
  const durationMs = durationFrom(opts, 500);
  const intervalMs = intervalFrom(opts);
  const state = makePad(opts);
  const session = await connectSeat(url, code, requestedSeat, opts.name || 'agent-cli');
  let sent = 0;
  const send = (value) => {
    if (session.ws.readyState !== WebSocket.OPEN) throw new Error('el puesto se desconectó durante la prueba');
    session.ws.send(JSON.stringify({ t: 'pad', b: value.b, a: value.a }));
    sent += 1;
  };
  const idle = { b: Object.fromEntries(BUTTONS.map((name) => [name, false])), a: Object.fromEntries(AXES.map((name) => [name, 0])) };
  try {
    const until = Date.now() + durationMs;
    do {
      send(state);
      const left = until - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(intervalMs, left));
    } while (Date.now() < until);
    send(idle);
    await sleep(40);
    session.ws.send(JSON.stringify({ t: 'release' }));
    await sleep(40);
    session.ws.close();
    return { ok: true, seat: session.seat, durationMs, sent, pad: state };
  } catch (error) {
    try { session.ws.send(JSON.stringify({ t: 'release' })); session.ws.close(); } catch { /* already closed */ }
    throw error;
  }
}

async function openAgentSession(opts, context) {
  if (context.session) throw new Error(`el agente ya controla el puesto ${context.session.seat}; envía release primero`);
  const url = baseUrl(opts.url);
  const status = await getStatus(url);
  const code = String(opts.code || status.room.code).toUpperCase();
  const seat = clamp(Number(opts.seat || FIRST_GUEST_SEAT), 1, status.seats || 4);
  const session = await connectSeat(url, code, seat, opts.name || 'ai-agent');
  const pingTimer = setInterval(() => {
    if (session.ws.readyState !== WebSocket.OPEN) {
      clearInterval(pingTimer);
      return;
    }
    session.ws.send(JSON.stringify({ t: 'ping', id: Date.now() }));
  }, 5000);
  pingTimer.unref();
  context.session = { ...session, url, code, pingTimer };
  return { ok: true, connected: true, seat: session.seat, code, welcome: session.welcome };
}

async function sessionInput(opts, context) {
  if (!context.session) return pad(opts);
  const state = makePad(opts);
  const durationMs = durationFrom(opts, 250);
  const intervalMs = intervalFrom(opts);
  const ws = context.session.ws;
  if (ws.readyState !== WebSocket.OPEN) throw new Error('el puesto del agente ya se desconectó');
  let sent = 0;
  const until = Date.now() + durationMs;
  do {
    ws.send(JSON.stringify({ t: 'pad', b: state.b, a: state.a }));
    sent += 1;
    const left = until - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  } while (Date.now() < until);
  return { ok: true, seat: context.session.seat, durationMs, sent, pad: state, stillConnected: ws.readyState === WebSocket.OPEN };
}

async function closeAgentSession(context) {
  if (!context.session) return { ok: true, released: false };
  const { ws, seat, pingTimer } = context.session;
  const idle = { b: Object.fromEntries(BUTTONS.map((name) => [name, false])), a: Object.fromEntries(AXES.map((name) => [name, 0])) };
  try {
    clearInterval(pingTimer);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'pad', b: idle.b, a: idle.a }));
      await sleep(40);
      ws.send(JSON.stringify({ t: 'release' }));
      await sleep(40);
      ws.close();
    }
  } finally {
    context.session = null;
  }
  return { ok: true, released: true, seat };
}

async function capture(opts) {
  const url = baseUrl(opts.url);
  const status = await getStatus(url);
  const code = String(opts.code || status.room.code).toUpperCase();
  const response = await fetch(`${url}/api/frame.jpg?code=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  const out = path.resolve(opts.out || opts.positionals?.[0] || 'sadx-frame.jpg');
  mkdirSync(path.dirname(out), { recursive: true });
  const data = Buffer.from(await response.arrayBuffer());
  writeFileSync(out, data);
  return { ok: true, path: out, bytes: data.length, capturedAt: new Date().toISOString() };
}

function modRequest(command, port = 27016, timeoutMs = 1000) {
  const socket = dgram.createSocket('udp4');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`SADX no respondió en 127.0.0.1:${port}; ¿está abierto con el mod online?`)), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString('utf8'));
        if (response.id === id) finish(null, response);
      } catch { /* ignore unrelated datagrams */ }
    });
    const payload = Buffer.from(JSON.stringify({ cmd: command, id }), 'utf8');
    socket.send(payload, port, '127.0.0.1', (error) => { if (error) finish(error); });
  });
}

async function modStatus(opts = {}) {
  const status = await modRequest('status', clamp(Number(opts.port || 27016), 1, 65535));
  return { ok: true, mod: status };
}

async function modNeutral(opts = {}) {
  const port = clamp(Number(opts.port || 27016), 1, 65535);
  const socket = dgram.createSocket('udp4');
  const payload = Buffer.from(JSON.stringify({ cmd: 'releaseAll' }), 'utf8');
  await new Promise((resolve, reject) => socket.send(payload, port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  socket.close();
  return { ok: true, releasedAllSeats: true, mod: await modRequest('status', port) };
}

async function gameStart(opts) {
  const configured = opts.exe || process.env.SADX_EXE || readSettings().gameExe;
  if (!configured) throw new Error('no sé dónde está SADX: ejecuta setup --sadx "<carpeta de SADX>" o pasa --exe');
  const exe = path.resolve(configured);
  if (!existsSync(exe)) throw new Error(`no existe el ejecutable: ${exe}`);
  ensureStateDir();
  const old = readState(GAME_STATE);
  if (old) {
    const current = inspectGameProcess(old);
    if (current.running) throw new Error(`ya hay una instancia administrada (pid ${old.pid}); usa game stop primero`);
    if (current.processFound) throw new Error(`el PID guardado ${old.pid} pertenece a otro proceso; revisa ${GAME_STATE} antes de iniciar`);
    rmSync(GAME_STATE, { force: true });
  }
  const defaultArgs = opts.nomultiplayer || opts.noMultiplayer
    ? (opts.level ? ['--level', String(opts.level), ...(opts.act !== undefined ? ['--act', String(opts.act)] : [])] : [])
    : [
        '--level', String(opts.level || 'twinklepark'),
        '--act', String(opts.act ?? '1'),
        '--multi', '4', 'coop',
        '-p1', 'sonic', '-p2', 'tails', '-p3', 'knuckles', '-p4', 'amy',
      ];
  const args = opts.args.length ? opts.args : defaultArgs;
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  await sleep(1200);
  if (child.exitCode !== null) throw new Error(`el juego terminó durante el arranque (código ${child.exitCode}, señal ${child.signalCode || 'ninguna'})`);
  child.unref();
  const state = { pid: child.pid, exe, args, startedAt: Date.now() };
  writeFileSync(GAME_STATE, JSON.stringify(state, null, 2), 'utf8');
  let focus = null;
  try { focus = focusGameWindow(child.pid); }
  catch (error) { focus = { ok: false, error: error.message }; }
  return {
    ok: true,
    pid: child.pid,
    exe,
    args,
    running: true,
    focused: Boolean(focus?.ok),
    focusError: focus?.error || null,
    defaultMultiplayerArgs: args.includes('--multi'),
  };
}

function inspectGameProcess(state) {
  if (process.platform !== 'win32') throw new Error('el cierre seguro de la instancia se implementó para Windows');
  const pid = Number(state.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('PID guardado inválido');
  const expected = path.resolve(state.exe).toLowerCase();
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if (!$p -or !$p.ExecutablePath) { exit 3 }; $s=[DateTime]$p.CreationDate; $e=[DateTimeOffset]::FromUnixTimeMilliseconds(${Number(state.startedAt)}).LocalDateTime; if ([Math]::Abs(($s-$e).TotalSeconds) -gt 15) { exit 4 }; $p.ExecutablePath`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status === 3) return { running: false, processFound: false, pid };
  if (result.status === 4) return { running: false, processFound: true, processMatches: false, pid };
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Windows no pudo comprobar el proceso del juego');
  const actual = result.stdout.trim().toLowerCase();
  if (actual !== expected) return { running: false, processFound: true, processMatches: false, pid, actualExe: result.stdout.trim() };
  return { running: true, processFound: true, processMatches: true, pid, exe: result.stdout.trim() };
}

function gameStatus() {
  const state = readState(GAME_STATE);
  if (!state) return { ok: true, managed: false, running: false };
  return { ok: true, managed: true, ...inspectGameProcess(state), exe: state.exe, args: state.args, startedAt: state.startedAt };
}

function focusGameWindow(pid) {
  if (process.platform !== 'win32') throw new Error('enfoque de ventana disponible solo en Windows');
  const focusScript = path.join(HERE, 'lib', 'focus-game-window.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', focusScript, '-TargetPid', String(pid)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Windows no pudo enfocar la ventana (código ${result.status})`);
  return { ok: true, focused: true, pid };
}
function gameFocus() {
  const state = readState(GAME_STATE);
  if (!state) throw new Error('no hay una instancia de SADX administrada por este CLI');
  const processInfo = inspectGameProcess(state);
  if (!processInfo.running) throw new Error('la instancia administrada de SADX ya no está abierta');
  return focusGameWindow(processInfo.pid);
}

async function gameStop() {
  const state = readState(GAME_STATE);
  if (!state) return { ok: true, stopped: false, alreadyStopped: true };
  const processInfo = inspectGameProcess(state);
  if (!processInfo.running) {
    if (processInfo.processFound) throw new Error('el PID guardado pertenece a otro proceso; no lo cierro ni borro su estado');
    rmSync(GAME_STATE, { force: true });
    return { ok: true, stopped: false, alreadyExited: true, pid: processInfo.pid };
  }
  const pid = processInfo.pid;
  const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  if (killed.status !== 0) {
    const afterKill = inspectGameProcess(state);
    if (afterKill.processFound) throw new Error(killed.stderr.trim() || killed.stdout.trim() || 'taskkill no pudo cerrar el juego');
    rmSync(GAME_STATE, { force: true });
    return { ok: true, stopped: false, alreadyExited: true, pid };
  }
  rmSync(GAME_STATE, { force: true });
  return { ok: true, stopped: true, pid };
}

async function doctor(opts = {}) {
  const checks = {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node },
    gateway: null,
    ffmpeg: null,
    video: null,
    sadxMod: null,
  };
  try {
    const status = await getStatus(opts.url);
    checks.gateway = { ok: true, url: baseUrl(opts.url), code: status.room.code, inputBackend: status.input.backend, video: status.video };
  } catch (error) { checks.gateway = { ok: false, error: error.message }; }
  const needsVideo = !opts.novideo && checks.gateway?.video?.disabled !== true;
  if (needsVideo) {
    const ffmpeg = resolveFfmpeg(opts.ffmpeg || 'ffmpeg');
    const version = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
    checks.ffmpeg = { ok: version.status === 0, path: ffmpeg, error: version.error?.message || null };
    const video = checks.gateway?.video;
    const ageMs = video?.lastFrameAt ? Date.now() - video.lastFrameAt : null;
    const frames = Object.values(video?.views || {}).reduce((sum, view) => sum + (view.frames || 0), 0);
    const hasFreshFrame = frames > 0 && ageMs !== null && ageMs < 2500;
    checks.video = {
      ok: Boolean(video?.running && hasFreshFrame),
      running: Boolean(video?.running),
      frames,
      frameAgeMs: ageMs,
      encoder: video?.encoder || null,
      views: Object.fromEntries(Object.entries(video?.views || {}).map(([name, view]) => [name, view.measuredFps])),
      error: hasFreshFrame ? null : video?.lastError || 'el stream no ha entregado un cuadro reciente',
    };
  } else {
    checks.ffmpeg = { ok: true, skipped: true, reason: opts.novideo ? 'video desactivado por el CLI' : 'video desactivado en la sala' };
    checks.video = { ok: true, skipped: true };
  }
  try {
    const mod = await modRequest('status', clamp(Number(opts.udpport || 27016), 1, 65535), 700);
    checks.sadxMod = {
      ok: Boolean(mod.multiplayerEnabled && mod.multiplayerActive),
      multiplayerEnabled: mod.multiplayerEnabled,
      multiplayerActive: mod.multiplayerActive,
      playerCount: mod.playerCount,
      stage: mod.stage,
      error: mod.multiplayerEnabled && mod.multiplayerActive ? null : 'el modo multijugador del mod no está activo',
    };
  } catch (error) { checks.sadxMod = { ok: false, error: error.message }; }
  return { ok: Object.values(checks).every((check) => check?.ok), checks };
}

function browserTest(opts = {}) {
  if (process.platform !== 'win32') throw new Error('la prueba de navegador necesita Windows y Edge');
  const cli = path.join(HERE, 'agent-cli.mjs');
  const script = path.join(HERE, 'test', 'browser-keyboard.mjs');
  const focus = spawnSync(process.execPath, [cli, 'game', 'focus'], {
    cwd: path.dirname(HERE), encoding: 'utf8', windowsHide: false, timeout: 10000,
  });
  if (focus.error) throw focus.error;
  if (focus.status !== 0) return { ok: false, output: [], error: focus.stderr.trim() || focus.stdout.trim() || 'no pude traer SADX al frente' };
  const args = [script];
  if (opts.url) args.push('--url', String(opts.url));
  const result = spawnSync(process.execPath, args, {
    cwd: path.dirname(HERE), encoding: 'utf8', windowsHide: false, timeout: 60000,
    env: process.env,
  });
  if (result.error) throw result.error;
  const output = (result.stdout || '').trim();
  return {
    ok: result.status === 0,
    output: output ? output.split(/\r?\n/) : [],
    error: result.status === 0 ? null : (result.stderr || `prueba de navegador terminó con código ${result.status}`).trim(),
  };
}

// What the stream needs from SADX Mod Loader (mods/.modloader/profiles/<active>.json, "Graphics").
const RECOMMENDED_GRAPHICS = {
  EnablePauseOnInactive: false, // keeps running and sounding without focus
  HorizontalResolution: 1280,   // 640x480 for each player in 4-way split screen
  VerticalResolution: 960,
  Enable43ResolutionRatio: false,
  ScreenMode: 0,                // windowed (the custom mode ran at ~12 fps)
  EnableResizableWindow: true,
  EnableKeepResolutionRatio: false,
  CustomWindowWidth: 1280,
  CustomWindowHeight: 960,
  RenderBackend: 1,             // Direct3D 9: Direct3D 11 (OIT) ran SADX at 6-47 fps
  EnableVsync: false,           // VSync made the captured rate worse
};

// Busy-waits a whole core for no visible gain on the stream (SADX: 1.2 cores with it, 0.4-0.5 without,
// same frame rate): setup turns it off where an earlier version of this project turned it on.
const UNWANTED_MODS = ['sadx-frame-limit'];

// The built mod: mod/build.ps1 writes dist/mods, or setup takes it from this repo's latest GitHub release
// (asset MOD_ZIP) and notes the tag in RELEASE_MARK, to replace it when a newer release comes out.
const MOD_ZIP = 'sadx-online-mod.zip';
const RELEASE_MARK = path.join(path.dirname(DIST_MODS), 'release.json');
const BUILD_HINT = 'o compílalo con Visual Studio 2022: powershell -ExecutionPolicy Bypass -File mod\\build.ps1';

/** owner/name of this repo on GitHub, from its git remotes. */
function repoSlug() {
  const remotes = spawnSync('git', ['-C', path.dirname(HERE), 'remote', '-v'], { encoding: 'utf8', windowsHide: true });
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/.exec(remotes.stdout || '');
  return match ? match[1] : 'LemonMantis5571/SADX-Multiplayer-Online';
}

/** Makes sure dist/mods holds the built mod; returns where it came from. */
function ensureModPackage() {
  const built = existsSync(path.join(DIST_MODS, 'sadx-multiplayer', 'sadx-multiplayer.dll'));
  let mark = null;
  try { mark = readState(RELEASE_MARK); } catch { /* rewritten below */ }
  if (built && !mark) return 'compilado en esta PC (mod/build.ps1)';

  const slug = repoSlug();
  // Just installed with winget: on PATH only for windows opened afterwards.
  const installed = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');
  const ghExe = existsSync(installed) ? installed : 'gh';
  const gh = (args) => spawnSync(ghExe, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const view = gh(['release', 'view', '--repo', slug, '--json', 'tagName']);
  if (view.error || view.status !== 0) {
    const reason = view.error ? 'GitHub CLI (gh) no está instalado' : (view.stderr || '').trim().split(/\r?\n/)[0];
    if (built) return `release ${mark.tag} (no pude ver si hay una más nueva: ${reason})`;
    throw new Error(`no pude bajar el mod de ${slug}: ${reason}. Instala GitHub CLI y entra con tu cuenta `
      + `(winget install --id GitHub.cli --exact; gh auth login), ${BUILD_HINT}`);
  }
  const tag = JSON.parse(view.stdout).tagName;
  if (built && mark?.tag === tag) return `release ${tag}`;

  const download = path.join(STATE_DIR, 'download');
  rmSync(download, { recursive: true, force: true });
  mkdirSync(download, { recursive: true });
  const got = gh(['release', 'download', tag, '--repo', slug, '--pattern', MOD_ZIP, '--dir', download]);
  if (got.error || got.status !== 0) throw new Error(`no pude bajar ${MOD_ZIP} de la release ${tag}: ${(got.stderr || got.error?.message || '').trim()}`);
  rmSync(DIST_MODS, { recursive: true, force: true });
  mkdirSync(DIST_MODS, { recursive: true });
  // Windows' own bsdtar reads zip files; a GNU tar earlier on PATH (Git for Windows) does not.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const unzip = spawnSync(tar, ['-xf', path.join(download, MOD_ZIP), '-C', DIST_MODS], { encoding: 'utf8', windowsHide: true });
  if (unzip.error || unzip.status !== 0) throw new Error(`no pude descomprimir ${MOD_ZIP}: ${(unzip.stderr || unzip.error?.message || '').trim()}`);
  writeFileSync(RELEASE_MARK, JSON.stringify({ tag, repo: slug }, null, 2), 'utf8');
  rmSync(download, { recursive: true, force: true });
  return `release ${tag} (descargada de ${slug})`;
}

// The Counter-Strike soldiers (mod/src/cs) wear the host's own Counter-Strike 1.6 models and sounds, never
// shipped here: the mod reads [CounterStrike] Path, the Half-Life folder with cstrike\ and valve\ inside, from
// sadx-online.ini in its folder. Without it they are stand-in soldiers.
const CS_MODEL = path.join('cstrike', 'models', 'player', 'gign', 'gign.mdl');
const CS_INI = 'sadx-online.ini';

/** Steam's library folders on this PC, from its registry key and libraryfolders.vdf. */
function steamLibraries() {
  const roots = [];
  const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
  const match = /SteamPath\s+REG_SZ\s+(.+)/.exec(reg.stdout || '');
  if (match) roots.push(path.resolve(match[1].trim()));
  roots.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'));
  const libraries = new Map(); // by lowercase path: Windows folders ignore case
  const add = (dir) => libraries.set(dir.toLowerCase(), dir);
  for (const root of roots) {
    if (existsSync(root)) add(root);
    try {
      const vdf = readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) add(path.resolve(m[1].replaceAll('\\\\', '\\')));
    } catch { /* no Steam there */ }
  }
  return [...libraries.values()];
}

/** The Half-Life folder holding Counter-Strike 1.6, from a folder given (it or its cstrike\) or Steam's libraries. */
function findCounterStrike(given) {
  const candidates = given ? [path.resolve(String(given))]
    : steamLibraries().map((lib) => path.join(lib, 'steamapps', 'common', 'Half-Life'));
  for (const dir of candidates) {
    for (const halfLife of [dir, path.dirname(dir)]) {
      if (existsSync(path.join(halfLife, CS_MODEL))) return halfLife;
    }
  }
  return null;
}

/** --light: a smaller window for weak integrated graphics (each player then sees 480x360). */
function graphicsFor(opts) {
  if (!opts.light) return RECOMMENDED_GRAPHICS;
  return { ...RECOMMENDED_GRAPHICS, HorizontalResolution: 960, VerticalResolution: 720, CustomWindowWidth: 960, CustomWindowHeight: 720 };
}

/**
 * Prepares a PC to host: installs the mod from dist/ into SADX (SADX Multiplayer with the browser bridge,
 * built by mod/build.ps1 or taken from the repo's latest release), tunes the active Mod Loader profile,
 * remembers where sonic.exe is, and says what's missing (Node, ffmpeg with gfxcapture, cloudflared).
 * Whatever it replaces is copied to <SADX>/sadx-online-backups/<time>/ first.
 */
async function setup(opts = {}) {
  const given = opts.sadx || opts.positionals?.[1];
  if (!given) throw new Error('falta la carpeta de SADX: setup --sadx "C:\\...\\Sonic Adventure DX"');
  let dir = path.resolve(String(given));
  if (/\.exe$/i.test(dir)) dir = path.dirname(dir);
  const exe = path.join(dir, 'sonic.exe');
  if (!existsSync(exe)) throw new Error(`no encuentro sonic.exe en ${dir}`);
  if (!existsSync(path.join(dir, 'mods', '.modloader', 'SADXModLoader.dll'))) {
    throw new Error(`${dir} no tiene SADX Mod Loader: instala el SADX Mod Installer (convierte el juego e instala SA Mod Manager) y abre SA Mod Manager una vez`);
  }
  const done = [];
  const todo = [];
  const optional = [];
  const backups = path.join(dir, 'sadx-online-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const backup = (from, name) => {
    mkdirSync(backups, { recursive: true });
    cpSync(from, path.join(backups, name), { recursive: true });
  };

  // The mods.
  let mods = [];
  try {
    done.push(`mod: ${ensureModPackage()}`);
    mods = readdirSync(DIST_MODS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    todo.push(error.message);
  }
  for (const mod of mods) {
    const target = path.join(dir, 'mods', mod);
    if (existsSync(target)) backup(target, path.join('mods', mod));
    cpSync(path.join(DIST_MODS, mod), target, { recursive: true, force: true });
    done.push(`mod ${mod} instalado en ${target}`);
  }

  // Counter-Strike, optional: the folder given, the one found last time, or the one in Steam.
  const modDir = path.join(dir, 'mods', 'sadx-multiplayer');
  if (existsSync(modDir)) {
    const remembered = readSettings().cstrike;
    const halfLife = opts.cstrike ? findCounterStrike(opts.cstrike)
      : (remembered && findCounterStrike(remembered)) || findCounterStrike();
    // UTF-16 with its mark: the mod reads it with GetPrivateProfileStringW, so any folder name works.
    const ini = `[CounterStrike]\r\nPath=${halfLife || ''}\r\n`;
    writeFileSync(path.join(modDir, CS_INI), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ini, 'utf16le')]));
    if (halfLife) {
      saveSettings({ cstrike: halfLife });
      done.push(`Counter-Strike 1.6: ${halfLife} (modelos y sonidos de los soldados)`);
    } else if (opts.cstrike) {
      todo.push(`no encuentro Counter-Strike 1.6 en ${opts.cstrike} (busco ${CS_MODEL}): pasa la carpeta Half-Life`);
    } else {
      optional.push('Counter-Strike 1.6 para los soldados (sin él son maniquíes): instálalo en Steam (steam://install/10) y repite setup');
    }
  }

  // The active profile: mods enabled and the graphics settings the stream needs.
  const profiles = path.join(dir, 'mods', '.modloader', 'profiles');
  let profileFile = path.join(profiles, 'Default.json');
  try {
    const list = JSON.parse(readFileSync(path.join(profiles, 'Profiles.json'), 'utf8'));
    const entry = list.ProfilesList?.[list.ProfileIndex ?? 0];
    if (entry?.Filename) profileFile = path.join(profiles, entry.Filename);
  } catch { /* older manager: Default.json */ }
  if (existsSync(profileFile)) {
    backup(profileFile, path.basename(profileFile));
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    const graphics = graphicsFor(opts);
    profile.Graphics = { ...(profile.Graphics || {}), ...graphics };
    const off = (profile.EnabledMods || []).filter((m) => UNWANTED_MODS.includes(m));
    profile.EnabledMods = [...new Set([...(profile.EnabledMods || []).filter((m) => !UNWANTED_MODS.includes(m)), ...mods])];
    writeFileSync(profileFile, JSON.stringify(profile, null, 2), 'utf8');
    const enabled = mods.length ? `${mods.join(' y ')} activado, ` : '';
    done.push(`perfil ${path.basename(profileFile)}: ${enabled}ventana ${graphics.HorizontalResolution}x${graphics.VerticalResolution}, Direct3D 9, sin pausa sin foco`);
    if (off.length) done.push(`${off.join(', ')} desactivado (gastaba un núcleo entero sin mejorar los fps)`);
  } else {
    todo.push(`no encontré el perfil del Mod Loader (${profileFile}): abre SA Mod Manager una vez y repite setup`);
  }

  // The tools.
  if (Number(process.versions.node.split('.')[0]) < 22) todo.push('Node 22 o más nuevo: winget install --id OpenJS.NodeJS.LTS --exact');
  const ffmpeg = resolveFfmpeg('ffmpeg');
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-h', 'filter=gfxcapture'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0 && /gfxcapture/i.test(probe.stdout || '')) done.push(`ffmpeg con gfxcapture: ${ffmpeg}`);
  else todo.push('ffmpeg 8 o más nuevo (captura de ventanas gfxcapture): winget install --id Gyan.FFmpeg --exact');
  try { done.push(`cloudflared: ${resolveCloudflared()}`); }
  catch { todo.push('cloudflared (enlace público): winget install --id Cloudflare.cloudflared --exact'); }
  if (probe.status === 0) {
    // The same check the room does when it starts: which GPU and encoder will carry the video here.
    const backend = await chooseBackend(ffmpeg, { log: () => {} });
    if (!backend) todo.push('ningún codificador de vídeo funciona con este ffmpeg');
    else if (backend.mode === 'cpu') done.push('vídeo: sin codificador de GPU, libx264 en la CPU (solo la partida entera, a 30 fps)');
    else done.push(`vídeo: ${backend.encoder} en ${backend.gpu}`);
  }
  if (!existsSync(path.join(HERE, 'node_modules', 'werift'))) {
    // npm is npm.cmd on Windows, so it goes through the shell: one command line, no separate arguments.
    const npm = spawnSync('npm install --no-fund --no-audit', { cwd: HERE, encoding: 'utf8', windowsHide: true, shell: true });
    if (npm.status === 0) done.push('conexión directa (WebRTC): werift instalado');
    else todo.push('conexión directa (opcional): npm install en la carpeta gateway');
  }

  saveSettings({ gameExe: exe });
  done.push(`la sala abrirá ${exe}`);
  return { ok: todo.length === 0, gameExe: exe, done, todo, optional, backups: existsSync(backups) ? backups : null };
}

function printSetup(result) {
  const lines = ['', '  Preparación de SADX Online', ''];
  for (const line of result.done) lines.push(`  ok    ${line}`);
  for (const line of result.todo) lines.push(`  falta ${line}`);
  for (const line of result.optional || []) lines.push(`  opcional ${line}`);
  if (result.backups) lines.push('', `  Copia de lo que reemplacé: ${result.backups}`);
  lines.push('', result.todo.length
    ? '  Instala lo que falta y vuelve a ejecutar esto (no repite nada que ya esté).'
    : '  Listo. Para jugar: SADX-Online.cmd', '');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Opens a local page in the host's default browser. */
function openInBrowser(url) {
  if (process.platform !== 'win32') return false;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
  return true;
}

/**
 * One click: the room (same code and port as last time), SADX through the room (so it can restart and
 * bring it back), the public link, and the host panel in the browser.
 */
async function up(opts = {}) {
  const settings = readSettings();
  const port = clamp(Number(opts.port || settings.port || 8123), 1, 65535);
  const room = await roomStart({ ...opts, port, room: opts.room || settings.room });
  const state = readState(ROOM_STATE);
  const base = state?.url || `http://127.0.0.1:${port}`;
  const code = room.code || room.status?.room?.code;
  const result = { ok: true, code, localUrl: `${base}/?code=${code}`, game: null, share: null, panel: null };

  if (!opts.nogame && state?.token) {
    const auth = { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' };
    const admin = await httpJson(`${base}/api/admin/state`, { headers: auth });
    if (admin.game?.running) result.game = { running: true, pid: admin.game.pid, alreadyRunning: true };
    else {
      const config = {};
      if (opts.level) config.level = String(opts.level);
      if (opts.act !== undefined) config.act = Number(opts.act);
      const started = await httpJson(`${base}/api/admin/game`, {
        method: 'POST', headers: auth, body: JSON.stringify(config), signal: AbortSignal.timeout(20000),
      });
      result.game = { running: Boolean(started.game?.running), pid: started.game?.pid ?? null, config: started.game?.config };
    }
  }
  if (!opts.noshare) {
    try {
      const share = await shareStart({ ...opts, url: base });
      result.share = { url: share.url, reachable: share.reachable, fixed: Boolean(readState(TUNNEL_STATE)?.named) };
    } catch (error) {
      result.share = { url: null, error: error.message };
    }
  }
  if (!opts.noopen && state?.token) {
    result.panel = openInBrowser(`${base}/host?admin=${state.token}`) ? 'abierto en tu navegador' : null;
  }
  return result;
}

/** Closes everything `up` started: the public link, the game and the room. */
async function down() {
  const result = { ok: true, share: await shareStop(), game: await gameStop(), room: null };
  if (readState(ROOM_STATE)) result.room = await roomStop();
  return result;
}

function printUp(result) {
  const lines = ['', '  SADX Online listo', ''];
  if (result.share?.url) {
    lines.push(`  Pasa este enlace:  ${result.share.url}`);
    if (!result.share.fixed) lines.push('                     (cambia cada vez; para uno fijo mira el README: "Enlace fijo")');
  } else if (result.share?.error) {
    lines.push(`  Sin enlace público: ${result.share.error}`);
  }
  lines.push(`  En esta PC / WiFi: ${result.localUrl}`);
  if (result.game) lines.push(`  Juego: ${result.game.running ? `abierto (pid ${result.game.pid})` : 'no arrancó: revisa el panel'}`);
  if (result.panel) lines.push('  Panel del anfitrión: abierto en tu navegador (QR, partida, jugadores)');
  lines.push('', '  Para cerrar todo: SADX-Online-cerrar.cmd (o: node gateway/agent-cli.mjs down)', '');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function getPath(value, key) {
  return key.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((node, part) => node == null ? undefined : node[part], value);
}

async function runScenario(opts) {
  const file = path.resolve(opts.file || opts.positionals?.[0] || '');
  if (!file || !existsSync(file)) throw new Error(`no encuentro el escenario: ${file}`);
  const scenario = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(scenario.steps)) throw new Error('el escenario necesita un array "steps"');
  const results = [];
  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index];
    if (step.waitMs) await sleep(clamp(Number(step.waitMs), 0, 60000));
    let result;
    if (step.op === 'room.status') result = await roomStatus(step);
    else if (step.op === 'game.status') result = gameStatus();
    else if (step.op === 'mod.status') result = await modStatus(step);
    else if (step.op === 'mod.neutral') result = await modNeutral(step);
    else if (step.op === 'pad') result = await pad(step);
    else if (step.op === 'capture') result = await capture(step);
    else throw new Error(`paso ${index + 1}: operación no permitida: ${step.op}`);
    const failures = [];
    for (const [key, expected] of Object.entries(step.expect || {})) {
      const actual = getPath(result, key);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ key, expected, actual });
    }
    results.push({ index: index + 1, op: step.op, ok: failures.length === 0, result, failures });
    if (failures.length) break;
  }
  return { ok: results.length === scenario.steps.length && results.every((entry) => entry.ok), scenario: scenario.name || path.basename(file), results };
}

async function operate(request, context = { session: null }) {
  const op = request.op || request.command;
  if (op === 'room.start') return roomStart(request);
  if (op === 'room.stop') return roomStop(request);
  if (op === 'room.restart') return roomRestart(request);
  if (op === 'up') return up(request);
  if (op === 'setup') return setup(request);
  if (op === 'down') return down();
  if (op === 'room.status' || op === 'status') return roomStatus(request);
  if (op === 'share.start') return shareStart(request);
  if (op === 'share.status') return shareStatus();
  if (op === 'share.stop') return shareStop();
  if (op === 'game.start') return gameStart({ ...request, args: request.args || [] });
  if (op === 'game.status') return gameStatus();
  if (op === 'game.focus') return gameFocus();
  if (op === 'game.stop') return gameStop();
  if (op === 'mod.status') return modStatus(request);
  if (op === 'mod.neutral') return modNeutral(request);
  if (op === 'pad') return pad(request);
  if (op === 'connect') return openAgentSession(request, context);
  if (op === 'input') return sessionInput(request, context);
  if (op === 'release') return closeAgentSession(context);
  if (op === 'capture') return capture(request);
  if (op === 'doctor') return doctor(request);
  if (op === 'test.browser') return browserTest(request);
  if (op === 'scenario') return runScenario(request);
  throw new Error(`operación desconocida: ${op}`);
}

async function runStdio() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const context = { session: null };
  let queue = Promise.resolve();
  input.on('line', (line) => {
    queue = queue.then(async () => {
      try { process.stdout.write(`${JSON.stringify(await operate(JSON.parse(line), context))}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); }
    });
  });
  await new Promise((resolve) => input.on('close', resolve));
  await queue;
  await closeAgentSession(context);
}

function print(value, human = false) {
  if (!human) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value.url) process.stdout.write(`Sala: ${value.url}\n`);
  else if (value.path) process.stdout.write(`Frame guardado: ${value.path} (${value.bytes} bytes)\n`);
  else if (value.pid) process.stdout.write(`PID ${value.pid}\n`);
  else if (value.stopped) process.stdout.write('cerrado\n');
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(help());
    return;
  }
  if (argv.includes('--stdio')) return runStdio();
  const opts = parseArgs(argv.filter((arg) => arg !== '--stdio'));
  const [group, action] = opts.positionals;
  let result;
  if (group === 'room' && action === 'start') result = await roomStart(opts);
  else if (group === 'room' && action === 'stop') result = await roomStop(opts);
  else if (group === 'room' && action === 'restart') result = await roomRestart(opts);
  else if (group === 'setup') {
    result = await setup(opts);
    if (opts.human) { printSetup(result); if (!result.ok) process.exitCode = 1; return; }
  } else if (group === 'up') {
    result = await up(opts);
    if (opts.human) { printUp(result); return; }
  } else if (group === 'down') result = await down();
  else if (group === 'room' && action === 'status') result = await roomStatus(opts);
  else if (group === 'share' && action === 'start') result = await shareStart(opts);
  else if (group === 'share' && action === 'status') result = await shareStatus();
  else if (group === 'share' && action === 'stop') result = await shareStop();
  else if (group === 'game' && action === 'start') result = await gameStart(opts);
  else if (group === 'game' && action === 'status') result = gameStatus();
  else if (group === 'game' && action === 'focus') result = gameFocus();
  else if (group === 'game' && action === 'stop') result = await gameStop();
  else if (group === 'mod' && action === 'status') result = await modStatus(opts);
  else if (group === 'mod' && action === 'neutral') result = await modNeutral(opts);
  else if (group === 'pad') result = await pad(opts);
  else if (group === 'capture') result = await capture({ ...opts, positionals: opts.positionals.slice(1) });
  else if (group === 'doctor') result = await doctor(opts);
  else if (group === 'test' && action === 'browser') result = browserTest(opts);
  else if (group === 'test') {
    for (const suite of ['smoke.mjs', 'agent-cli-smoke.mjs']) {
      const run = spawnSync(process.execPath, [path.join(HERE, 'test', suite)], { cwd: path.dirname(HERE), encoding: 'utf8', windowsHide: true });
      process.stdout.write(run.stdout || '');
      process.stderr.write(run.stderr || '');
      if (run.status !== 0) {
        process.exitCode = run.status || 1;
        return;
      }
    }
    return;
  } else if (group === 'scenario') result = await runScenario({ ...opts, file: action || opts.file });
  else throw new Error('comando no reconocido; usa --help');
  print(result, Boolean(opts.human));
  if (result?.ok === false) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
