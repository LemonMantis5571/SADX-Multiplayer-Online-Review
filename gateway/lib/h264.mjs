// H.264 encoding of the game window for the browser.
//
// One ffmpeg captures the SADX window once (gfxcapture) and encodes several views
// of it with NVENC (libx264 when there is no NVIDIA GPU): the whole window in two
// qualities and, in split-screen, each player's part of the window on its own.
// Every view is tuned for latency (no B-frames, no lookahead, output flushed
// after every frame, a keyframe every second) and written to its own local TCP
// socket. Each view's Annex B stream gets an AUD before every frame, so it splits
// into one access unit per frame; its H264Track emits each one as a 'frame' event
// and keeps the current GOP. Who gets which frame is VideoHub's job (videohub.mjs).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveFfmpeg, captureInput } from './video.mjs';

const MAX_BUFFER = 8 << 20;
const MAX_GOP = 240;

function nalTypes(au) {
  const types = [];
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      types.push(au[i + 3] & 0x1f);
      i += 3;
    }
  }
  return types;
}

/** Index of the next AUD (NAL type 9) start code at or after `from`, or -1. */
function findAud(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 9) return i;
    if (buf[i + 2] === 0 && buf[i + 3] === 1 && (buf[i + 4] & 0x1f) === 9) return i;
  }
  return -1;
}

/**
 * One view of the window: `height` (never upscaled), `bitrate` in kbps, `step` (2 = every other
 * captured frame) and `crop` ([x, y, w, h] as fractions of the window, or null for all of it).
 */
export class H264Track extends EventEmitter {
  constructor({ name, height, bitrate, step = 1, crop = null }) {
    super();
    this.name = name;
    this.configure({ height, bitrate, step, crop });
    this.gop = [];
    this.buf = Buffer.alloc(0);
    this.frames = 0;
    this.bytes = 0;
    this.lastFrameAt = 0;
    this.startedAt = 0;
    this.framesAtStart = 0;
    this.bytesAtStart = 0;
  }

  configure({ height, bitrate, step = 1, crop = null }) {
    this.height = height;
    this.bitrate = bitrate;
    this.step = step;
    this.crop = crop;
  }

  /** What has to match for a running encoder to keep this view as it is. */
  get signature() {
    return JSON.stringify([this.height, this.bitrate, this.step, this.crop]);
  }

  reset() {
    this.gop = [];
    this.buf = Buffer.alloc(0);
    this.startedAt = Date.now();
    this.framesAtStart = this.frames;
    this.bytesAtStart = this.bytes;
  }

  filter(pixfmt) {
    const parts = [];
    if (this.step > 1) parts.push(`framestep=${this.step}`);
    if (this.crop) {
      const [x, y, w, h] = this.crop;
      parts.push(`crop=w=iw*${w}:h=ih*${h}:x=iw*${x}:y=ih*${y}`);
    }
    parts.push(`scale=w=-2:h=min(${this.height}\\,ih)`, `format=${pixfmt}`);
    return parts.join(',');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) {
      this.buf = Buffer.alloc(0);
      return;
    }
    // Every access unit starts with an AUD; one ends where the next one starts.
    for (;;) {
      const start = findAud(this.buf, 0);
      if (start < 0) return;
      const next = findAud(this.buf, start + 4);
      if (next < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      const au = Buffer.from(this.buf.subarray(start, next));
      this.buf = this.buf.subarray(next);
      this._publish(au);
    }
  }

  _publish(au) {
    const key = nalTypes(au).includes(5);
    this.frames += 1;
    this.bytes += au.length;
    this.lastFrameAt = Date.now();
    if (key) this.gop = [];
    if (key || this.gop.length) this.gop.push(au);
    if (this.gop.length > MAX_GOP) this.gop = [];
    this.emit('frame', au, key);
  }

  status() {
    const span = Date.now() - this.startedAt;
    const frames = this.frames - this.framesAtStart;
    return {
      height: this.height,
      bitrateKbps: this.bitrate,
      step: this.step,
      crop: this.crop,
      frames: this.frames,
      lastFrameAt: this.lastFrameAt || null,
      measuredFps: this.startedAt && frames > 1 ? Math.round((frames / span) * 1000 * 10) / 10 : null,
      measuredKbps: this.startedAt && frames > 1 ? Math.round(((this.bytes - this.bytesAtStart) * 8) / span) : null,
    };
  }
}

export class H264Encoder extends EventEmitter {
  constructor({ ffmpeg = 'ffmpeg', source, fps = 60, encoder = 'auto', log = console.log } = {}) {
    super();
    this.ffmpeg = resolveFfmpeg(ffmpeg);
    this.source = source;
    this.fps = fps;
    this.encoders = encoder === 'auto' ? ['h264_nvenc', 'libx264'] : [encoder];
    this.encoderIndex = 0;
    this.log = log;
    this.tracks = new Map(); // name -> H264Track, kept across restarts so listeners stay attached
    this.active = [];        // tracks the running ffmpeg encodes
    this.proc = null;
    this.servers = [];
    this.restartTimer = null;
    this.restarts = 0;
    this.stopped = false;
    this.starting = false;
    this.restarting = false;
    this.startedAt = 0;
    this.lastError = null;
  }

  get encoder() {
    return this.encoders[this.encoderIndex];
  }

  get running() {
    return this.proc !== null;
  }

  get lastFrameAt() {
    return Math.max(0, ...this.active.map((t) => t.lastFrameAt));
  }

  track(name) {
    return this.tracks.get(name) || null;
  }

  /** Whether `name` is being encoded right now (views cut from the window need NVENC). */
  encoding(name) {
    return this.active.some((t) => t.name === name);
  }

  /**
   * The views to encode, as [{name, height, bitrate, step, crop}]. A view that keeps its name keeps
   * its H264Track. Restarts ffmpeg (a second without video) only when something actually changed.
   */
  setViews(views) {
    let changed = false;
    const keep = new Set();
    for (const view of views) {
      keep.add(view.name);
      const existing = this.tracks.get(view.name);
      if (!existing) {
        const track = new H264Track(view);
        this.tracks.set(view.name, track);
        this.emit('track', track);
        changed = true;
        continue;
      }
      const before = existing.signature;
      existing.configure(view);
      if (existing.signature !== before) changed = true;
    }
    for (const name of [...this.tracks.keys()]) {
      if (!keep.has(name)) { this.tracks.delete(name); changed = true; }
    }
    if (changed && (this.proc || this.restartTimer)) this.restart();
    return changed;
  }

  /** Without NVENC, encoding several views at 60 fps on the CPU would starve the game: whole window only. */
  _plannedTracks() {
    const all = [...this.tracks.values()];
    if (this.encoder === 'h264_nvenc') return all;
    return all.filter((t) => !t.crop);
  }

  _encodeArgs(track) {
    const rate = `${track.bitrate}k`;
    const gop = String(Math.max(1, Math.round(this.fps / track.step)));
    const encode = this.encoder === 'h264_nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0',
         '-rc', 'cbr', '-rc-lookahead', '0', '-forced-idr', '1']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-x264-params', 'repeat-headers=1:sliced-threads=1'];
    return [
      ...encode,
      '-profile:v', 'baseline', '-bf', '0', '-g', gop,
      '-b:v', rate, '-maxrate', rate, '-bufsize', `${Math.round(track.bitrate / 3)}k`,
      '-bsf:v', 'dump_extra=freq=keyframe,h264_metadata=aud=insert',
      '-fps_mode', 'passthrough', '-flush_packets', '1', '-muxdelay', '0',
    ];
  }

  async start() {
    if (this.proc || this.stopped || this.starting) return;
    this.starting = true;
    try {
      await this._start();
    } finally {
      this.starting = false;
    }
  }

  async _start() {
    const tracks = this._plannedTracks();
    if (!tracks.length) return;
    // One local socket per view: ffmpeg connects to each when it opens its outputs.
    this.servers = await Promise.all(tracks.map((track) => new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        socket.on('data', (chunk) => track._onData(chunk));
        socket.on('error', () => {});
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    })));
    if (this.stopped) { this._closeServers(); return; }

    const pixfmt = this.encoder === 'h264_nvenc' ? 'nv12' : 'yuv420p';
    const graph = `[0:v]split=${tracks.length}${tracks.map((_, i) => `[s${i}]`).join('')};` +
      tracks.map((t, i) => `[s${i}]${t.filter(pixfmt)}[v${i}]`).join(';');
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // The capture itself is capped at the stream's rate: an fps filter would hold a frame back.
      ...captureInput(this.source, this.fps, this.fps),
      '-filter_complex', graph,
    ];
    tracks.forEach((track, i) => {
      args.push('-map', `[v${i}]`, ...this._encodeArgs(track), '-f', 'h264', `tcp://127.0.0.1:${this.servers[i].address().port}?tcp_nodelay=1`);
    });
    this.log(`[h264] ${this.encoder}: ${tracks.map((t) => t.name).join(', ')}`);
    this.log(`[h264] ${this.ffmpeg} ${args.join(' ')}`);

    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      this.lastError = err.message;
      this._closeServers();
      return;
    }
    this.proc = proc;
    this.active = tracks;
    this.startedAt = Date.now();
    const framesBefore = tracks.map((t) => t.frames);
    for (const track of tracks) track.reset();

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.lastError = text.split('\n').slice(-1)[0];
        this.log(`[h264] ffmpeg: ${this.lastError}`);
      }
    });
    proc.on('error', (err) => { this.lastError = err.message; });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.active = [];
      this._closeServers();
      if (this.stopped || this.restarting) return;
      const produced = tracks.some((t, i) => t.frames > framesBefore[i]);
      if (produced) this.restarts = 0;
      // No output at all from this encoder (no NVIDIA GPU, driver issue): try the next one.
      if (!produced && code !== 0 && this.encoderIndex + 1 < this.encoders.length && /nvenc|encoder|device|driver|session/i.test(this.lastError || '')) {
        this.log(`[h264] ${this.encoder} no disponible; uso ${this.encoders[this.encoderIndex + 1]}`);
        this.encoderIndex += 1;
      }
      this.restarts += 1;
      this.log(`[h264] ffmpeg terminó (código ${code})`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, Math.min(5000, 1000 * this.restarts));
    });
  }

  /** New views: stop the running ffmpeg and start one with the current set. */
  restart() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const proc = this.proc;
    if (!proc) { this.start(); return; }
    this.restarting = true;
    proc.once('exit', () => {
      this.restarting = false;
      this.start();
    });
    try { proc.kill(); } catch { /* ya terminó */ }
  }

  _closeServers() {
    for (const server of this.servers) { try { server.close(); } catch { /* cerrado */ } }
    this.servers = [];
  }

  status() {
    return {
      running: this.proc !== null,
      encoder: this.encoder,
      fps: this.fps,
      restarts: this.restarts,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt || null,
      views: Object.fromEntries([...this.tracks.values()].map((t) => [t.name, { ...t.status(), encoding: this.active.includes(t) }])),
    };
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ya terminó */ }
      this.proc = null;
    }
    this._closeServers();
  }
}
