// Vídeo JPEG del juego: el respaldo para navegadores sin WebCodecs (el vídeo
// normal es H.264, ver h264.mjs) y la fuente de /api/frame.jpg para el CLI.
//
// Un único proceso ffmpeg captura la ventana de SADX y emite JPEGs concatenados
// por stdout. Los oyentes (addListener) reciben cada cuadro para empujarlo por
// WebSocket; /stream los reparte como multipart. Sin audio.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_BUFFER = 32 << 20;

export function resolveFfmpeg(configured = 'ffmpeg') {
  if (configured && configured !== 'ffmpeg' && configured !== 'ffmpeg.exe') return configured;

  const candidates = [
    process.env.UM_FFMPEG_WIN,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'universal-modder', 'ffmpeg', 'bin', 'ffmpeg.exe')
      : null,
    // Just installed with winget: on PATH only for windows opened afterwards.
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : null,
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || configured || 'ffmpeg';
}

function escapeFilterValue(value) {
  // FFmpeg parses filter options and the filtergraph in two separate passes.
  return value.replace(/[\\':]/g, '\\$&').replace(/[\\'\[\],;]/g, '\\$&');
}

function captureSource(source, maxFps = 60) {
  if (source === 'desktop') return { mode: 'gdigrab', input: source };

  const match = /^(?:exe|window_exe|title|window_title|hwnd)=(.*)$/i.exec(source);
  if (!match) throw new Error(`fuente de vídeo no reconocida: ${source}; usa exe=, title=, hwnd= o desktop`);

  const kind = source.slice(0, source.indexOf('=')).toLowerCase();
  let selector;
  if (kind === 'exe' || kind === 'window_exe') {
    let exe = path.win32.basename(match[1]);
    if (!exe.toLowerCase().endsWith('.exe')) exe += '.exe';
    selector = `window_exe=${escapeFilterValue(exe)}`;
  } else if (kind === 'hwnd') {
    if (!/^\d+$/.test(match[1])) throw new Error('hwnd debe ser un número decimal');
    selector = `hwnd=${match[1]}`;
  } else {
    selector = `window_title=${escapeFilterValue(match[1])}`;
  }

  return {
    mode: 'gfxcapture',
    input: `gfxcapture=${selector}:capture_cursor=0:max_framerate=${maxFps},hwdownload,format=bgra`,
  };
}

/** ffmpeg input arguments for a capture source (window via gfxcapture, or the desktop). */
export function captureInput(source, fps = 30, maxFps = 60) {
  const capture = captureSource(source, maxFps);
  return capture.mode === 'gfxcapture'
    ? ['-f', 'lavfi', '-i', capture.input]
    : ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', '-i', capture.input];
}

export class VideoStream {
  constructor({
    ffmpeg = 'ffmpeg',
    source = 'desktop',
    fps = 30,
    height = 720,
    quality = 6,
    log = console.log,
  } = {}) {
    this.ffmpeg = resolveFfmpeg(ffmpeg);
    this.source = source;
    this.capture = captureSource(source, fps);
    this.fps = fps;
    this.height = height;
    this.quality = quality;
    this.log = log;

    this.clients = new Set();
    this.listeners = new Set();
    this.buf = Buffer.alloc(0);
    this.proc = null;
    this.restartTimer = null;
    this.frames = 0;
    this.framesAtStart = 0;
    this.bytes = 0;
    this.lastFrameAt = 0;
    this.latestFrame = null;
    this.startedAt = 0;
    this.lastError = null;
    this.restarts = 0;
    this.stopped = false;
  }

  get running() {
    return this.proc !== null;
  }

  args() {
    const inputArgs = captureInput(this.source, this.fps, this.fps);
    const outputFilters = `scale=-2:${this.height}`;
    return [
      '-hide_banner',
      '-loglevel', 'error',
      ...inputArgs,
      '-vf', outputFilters,
      '-c:v', 'mjpeg',
      '-q:v', String(this.quality),
      '-flush_packets', '1',
      '-f', 'image2pipe',
      'pipe:1',
    ];
  }

  start() {
    if (this.proc || this.stopped) return;
    const args = this.args();
    this.log(`[video] ${this.ffmpeg} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = err.message;
      this.log(`[video] no se pudo lanzar ffmpeg: ${err.message}`);
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this.framesAtStart = this.frames;

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.lastError = text.split('\n').slice(-1)[0];
        this.log(`[video] ffmpeg: ${this.lastError}`);
      }
    });
    proc.on('error', (err) => {
      this.lastError = err.message;
      this.proc = null;
      this.log(`[video] error de proceso: ${err.message}`);
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.log(`[video] ffmpeg terminó (código ${code})`);
      // The game can close and reopen while the room stays up. Keep looking for it,
      // even before the first viewer connects or after a clean FFmpeg exit.
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, Math.min(5000, 1000 * this.restarts));
    });
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) {
      this.buf = Buffer.alloc(0);
      this.lastError = 'buffer de vídeo desbordado';
      return;
    }

    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1);
        return;
      }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      const jpeg = this.buf.subarray(start, end + 2);
      this.buf = this.buf.subarray(end + 2);
      this._publish(jpeg);
    }
  }

  _publish(jpeg) {
    this.frames += 1;
    this.bytes += jpeg.length;
    this.lastFrameAt = Date.now();
    this.lastError = null;
    this.restarts = 0;
    this.latestFrame = Buffer.from(jpeg);
    for (const listener of this.listeners) listener(this.latestFrame);
    if (this.clients.size === 0) return;

    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      'ascii',
    );
    const packet = Buffer.concat([header, jpeg, Buffer.from('\r\n', 'ascii')]);

    for (const client of this.clients) {
      if (client.blocked) continue; // el espectador va por detrás: se salta frames
      try {
        if (!client.res.write(packet)) client.blocked = true;
      } catch {
        this._detach(client);
      }
    }
  }

  /** Calls `fn(jpeg)` for every new frame (WebSocket viewers). Returns the function that removes it. */
  addListener(fn) {
    this.listeners.add(fn);
    this.start();
    return () => this.listeners.delete(fn);
  }

  /** Añade un espectador. Devuelve la función para quitarlo. */
  subscribe(res) {
    const client = { res, blocked: false };
    res.on('drain', () => {
      client.blocked = false;
    });
    res.on('close', () => this._detach(client));
    res.on('error', () => this._detach(client));
    this.clients.add(client);
    this.log(`[video] espectador conectado (${this.clients.size})`);
    this.start();
    if (this.buf.length === 0 && this.lastFrameAt === 0) {
      // Aún sin frame: el flujo empieza en cuanto ffmpeg entregue el primero.
    }
    return () => this._detach(client);
  }

  _detach(client) {
    if (!this.clients.delete(client)) return;
    try {
      client.res.end();
    } catch {
      /* ya cerrado */
    }
    this.log(`[video] espectador desconectado (${this.clients.size})`);
  }

  status() {
    return {
      running: this.running,
      source: this.source,
      capture: this.capture.mode,
      fps: this.fps,
      height: this.height,
      quality: this.quality,
      viewers: this.clients.size,
      frames: this.frames,
      bytes: this.bytes,
      restarts: this.restarts,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt || null,
      measuredFps:
        this.startedAt && this.frames - this.framesAtStart > 1
          ? Math.round(((this.frames - this.framesAtStart) / (Date.now() - this.startedAt)) * 1000 * 10) / 10
          : null,
    };
  }

  /** Returns a copy of the most recently captured JPEG, if one exists. */
  latest() {
    return this.latestFrame ? Buffer.from(this.latestFrame) : null;
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const client of [...this.clients]) this._detach(client);
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ya muerto */
      }
      this.proc = null;
    }
  }
}
