// The SADX process the room runs: launch with a stage and characters, restart
// with new ones, and bring it back if it crashes.
//
// It shares `.agent-state/game.json` with agent-cli.mjs, so a game started by
// `game start` is adopted here and `game stop` (which removes that file) counts
// as stopping on purpose rather than as a crash.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

// What the mod and SADX Mod Loader accept on the command line (testspawn.cpp).
export const LEVELS = [
  'emeraldcoast', 'windyvalley', 'twinklepark', 'speedhighway', 'redmountain', 'skydeck', 'lostworld',
  'icecap', 'casinopolis', 'finalegg', 'hotshelter', 'hedgehoghammer', 'chaos0', 'chaos2', 'chaos4',
  'chaos6', 'perfectchaos', 'egghornet', 'eggwalker', 'eggviper', 'zero', 'e101', 'e101r',
  'stationsquare', 'eggcarrieroutside', 'eggcarrierinside', 'mysticruins', 'past', 'twinklecircuit',
  'skychase1', 'skychase2', 'sandhill', 'ssgarden', 'ecgarden', 'mrgarden', 'chaorace',
];
export const CHARACTERS = ['sonic', 'tails', 'knuckles', 'amy', 'big', 'gamma', 'eggman', 'tikal', 'metalsonic',
  // Counter-Strike soldiers on Sonic's movement (mod/src/cs), with models and sounds from the host's CS 1.6
  'cs_terror', 'cs_leet', 'cs_arctic', 'cs_guerilla', 'cs_gign', 'cs_gsg9', 'cs_sas', 'cs_urban'];
export const MODES = ['coop', 'battle'];

export const DEFAULT_CONFIG = {
  level: 'twinklepark',
  act: 1,
  mode: 'coop',
  characters: ['sonic', 'tails', 'knuckles', 'amy'],
};

const CRASH_WINDOW_MS = 120000;
const MAX_CRASH_RESTARTS = 3;

/** Checks and normalizes a game config from the host panel. */
export function cleanConfig(raw = {}, base = DEFAULT_CONFIG) {
  const level = LEVELS.includes(raw.level) ? raw.level : base.level;
  const act = Number.isInteger(Number(raw.act)) ? Math.max(0, Math.min(5, Number(raw.act))) : base.act;
  const mode = MODES.includes(raw.mode) ? raw.mode : base.mode;
  const list = Array.isArray(raw.characters) ? raw.characters : base.characters;
  const characters = list.filter((c) => CHARACTERS.includes(c)).slice(0, 4);
  return { level, act, mode, characters: characters.length ? characters : base.characters };
}

export function gameArgs(config) {
  const args = ['--level', config.level, '--act', String(config.act), '--multi', String(config.characters.length), config.mode];
  config.characters.forEach((c, i) => args.push(`-p${i + 1}`, c));
  return args;
}

/** Reads back a config from command-line arguments (for a game the CLI started). */
function configFromArgs(args = []) {
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const multi = args.indexOf('--multi');
  const characters = [1, 2, 3, 4].map((n) => at(`-p${n}`)).filter(Boolean);
  return cleanConfig({
    level: at('--level'),
    act: at('--act'),
    mode: multi >= 0 ? args[multi + 2] : undefined,
    characters,
  });
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class GameManager {
  constructor({ exe, stateFile, configFile, log = console.log }) {
    this.exe = exe;
    this.stateFile = stateFile;
    this.configFile = configFile;
    this.log = log;
    this.pid = null;
    this.config = this._loadConfig();
    this.crashes = [];
    this.restarts = 0;
    this.lastExit = null;
    this.busy = false;
    this.adopt();
    this.timer = setInterval(() => this._watch(), 2000);
  }

  _loadConfig() {
    try { return cleanConfig(JSON.parse(readFileSync(this.configFile, 'utf8'))); } catch { return { ...DEFAULT_CONFIG }; }
  }

  _readState() {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return null; }
  }

  /** Takes over a game started by agent-cli (game.json) if it's still running. */
  adopt() {
    const state = this._readState();
    if (!state || !alive(state.pid) || state.pid === this.pid) return false;
    this.pid = state.pid;
    if (Array.isArray(state.args) && state.args.includes('--multi')) this.config = configFromArgs(state.args);
    this.log(`[juego] SADX en marcha (pid ${state.pid}): ${this.describe()}`);
    return true;
  }

  get running() {
    return alive(this.pid);
  }

  describe(config = this.config) {
    return `${config.level} acto ${config.act}, ${config.mode}, ${config.characters.join(' / ')}`;
  }

  async start(config = this.config) {
    if (!existsSync(this.exe)) throw new Error(`no existe el ejecutable: ${this.exe}`);
    this.config = cleanConfig(config, this.config);
    const args = gameArgs(this.config);
    const child = spawn(this.exe, args, { cwd: path.dirname(this.exe), detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
    this.pid = child.pid;
    writeFileSync(this.stateFile, JSON.stringify({ pid: child.pid, exe: this.exe, args, startedAt: Date.now() }, null, 2), 'utf8');
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    this.log(`[juego] SADX arrancado (pid ${child.pid}): ${this.describe()}`);
    return this.status();
  }

  async stop() {
    const pid = this.pid;
    this.pid = null;
    rmSync(this.stateFile, { force: true }); // on purpose: the watchdog must not bring it back
    if (alive(pid)) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true });
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    }
    return this.status();
  }

  /** New stage or characters: SADX reads them only at launch, so this restarts it. */
  async restart(config) {
    if (this.busy) throw new Error('el juego ya se está reiniciando');
    this.busy = true;
    try {
      await this.stop();
      await new Promise((r) => setTimeout(r, 800));
      return await this.start(config);
    } finally {
      this.busy = false;
    }
  }

  async _watch() {
    if (this.busy) return;
    if (!this.pid) { this.adopt(); return; } // a game the CLI started after the room
    if (alive(this.pid)) return;
    // The process is gone. If game.json is still there, nobody stopped it: it crashed.
    const state = this._readState();
    if (!state || state.pid !== this.pid) { this.pid = null; return; }
    const now = Date.now();
    this.lastExit = now;
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASH_RESTARTS) {
      this.log(`[juego] SADX se cerró ${MAX_CRASH_RESTARTS} veces en 2 min; no lo vuelvo a abrir solo`);
      this.pid = null;
      rmSync(this.stateFile, { force: true });
      return;
    }
    this.crashes.push(now);
    this.restarts += 1;
    this.log(`[juego] SADX se cerró solo; lo vuelvo a abrir (${this.describe()})`);
    this.busy = true;
    try { await this.start(this.config); }
    catch (err) { this.log(`[juego] no pude reabrirlo: ${err.message}`); this.pid = null; }
    finally { this.busy = false; }
  }

  status() {
    return {
      running: this.running,
      pid: this.pid,
      exe: this.exe,
      config: this.config,
      args: gameArgs(this.config),
      autoRestarts: this.restarts,
      lastCrashAt: this.lastExit,
      busy: this.busy,
    };
  }

  close() {
    clearInterval(this.timer);
  }
}
