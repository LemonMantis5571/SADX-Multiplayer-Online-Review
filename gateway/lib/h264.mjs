// H.264 encoding of the game window for the browser: one view, one ffmpeg.
//
// Each view (the whole game in two qualities, or one player's part of the split screen) is its own
// ffmpeg process with its own gfxcapture, which crops and scales the window on the GPU; what follows
// depends on the backend lib/gpu.mjs picked for this PC (on NVIDIA the captured texture goes straight
// into NVENC). Separate processes let views start when someone watches them and stop when nobody does,
// without disturbing the others. Every view is tuned for latency (no B-frames, no lookahead, output
// flushed after every frame, a keyframe every second) and its Annex B stream gets an AUD before every
// frame, so it splits into one access unit per frame: each one is emitted as a 'frame' event and the
// current GOP is kept. Who gets which frame is VideoHub's job (videohub.mjs).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ENCODE_ARGS, captureTail, deviceArgs } from './gpu.mjs';

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

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * One view of the window: `crop` ([x, y, w, h] as fractions, or null for all of it), `height` (never
 * upscaled), `bitrate` in kbps and `fps` (the capture's own rate cap).
 */
export class H264View extends EventEmitter {
  constructor({ name, crop = null, height, bitrate, fps, selector, ffmpeg, log = console.log }) {
    super();
    this.name = name;
    this.selector = selector; // gfxcapture's window selector
    this.ffmpeg = ffmpeg;
    this.log = log;
    this.configure({ crop, height, bitrate, fps });
    this.backend = null;
    this.window = { width: 1280, height: 960 };
    this.proc = null;
    this.wanted = false;
    this.restartTimer = null;
    this.restarts = 0;
    this.gop = [];
    this.buf = Buffer.alloc(0);
    this.scanFrom = 0;
    this.frames = 0;
    this.bytes = 0;
    this.lastFrameAt = 0;
    this.startedAt = 0;
    this.framesAtStart = 0;
    this.bytesAtStart = 0;
    this.lastError = null;
  }

  /** New settings; true when they differ (a running view then needs a restart). */
  configure({ crop = null, height, bitrate, fps }) {
    const before = JSON.stringify([this.crop, this.height, this.bitrate, this.fps]);
    this.crop = crop;
    this.height = height;
    this.bitrate = bitrate;
    this.fps = fps;
    return JSON.stringify([this.crop, this.height, this.bitrate, this.fps]) !== before;
  }

  get running() {
    return this.proc !== null;
  }

  /** gfxcapture's options: the crop in window pixels, and the size to scale to (on the GPU). */
  captureOptions() {
    const W = this.window.width;
    const H = this.window.height;
    const parts = [this.selector, 'capture_cursor=0', `max_framerate=${this.fps}`];
    let w = W;
    let h = H;
    if (this.crop) {
      const [x, y, cw, ch] = this.crop;
      const left = Math.round(x * W);
      const top = Math.round(y * H);
      const right = Math.max(0, W - Math.round((x + cw) * W));
      const bottom = Math.max(0, H - Math.round((y + ch) * H));
      parts.push(`crop_left=${left}`, `crop_top=${top}`, `crop_right=${right}`, `crop_bottom=${bottom}`);
      w = W - left - right;
      h = H - top - bottom;
    }
    // Only a smaller picture is asked for; otherwise the capture keeps the window's (cropped) size.
    if (h > this.height) {
      parts.push(`width=${even((w * this.height) / h)}`, `height=${even(this.height)}`, 'resize_mode=scale', 'scale_mode=bilinear');
    }
    return parts.join(':');
  }

  args() {
    const rate = `${this.bitrate}k`;
    return [
      '-hide_banner', '-loglevel', 'error',
      ...deviceArgs(this.backend),
      '-filter_complex', `gfxcapture=${this.captureOptions()}${captureTail(this.backend)}[v]`,
      '-map', '[v]',
      ...ENCODE_ARGS[this.backend.encoder],
      // A keyframe every second of real time (the capture's rate varies with the game's).
      '-bf', '0', '-g', String(Math.max(1, this.fps)), '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-b:v', rate, '-maxrate', rate, '-bufsize', `${Math.round(this.bitrate / 3)}k`,
      '-bsf:v', 'dump_extra=freq=keyframe,h264_metadata=aud=insert',
      '-fps_mode', 'passthrough', '-flush_packets', '1', '-muxdelay', '0',
      '-f', 'h264', 'pipe:1',
    ];
  }

  /** Starts encoding (when the backend and the window are known); a view that's wanted keeps restarting. */
  start(backend = this.backend) {
    this.wanted = true;
    this.backend = backend;
    if (this.proc || !this.backend || this.restartTimer) return;
    const args = this.args();
    this.log(`[h264 ${this.name}] ${this.ffmpeg} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.lastError = err.message;
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this.framesAtStart = this.frames;
    this.bytesAtStart = this.bytes;
    this.buf = Buffer.alloc(0);
    this.scanFrom = 0;
    this.pending = null;
    this.gop = [];
    let produced = false;
    let captureLost = false; // gfxcapture itself failed (e.g. "Failed to find capture source"): no window

    proc.stdout.on('data', (chunk) => { produced = true; this._onData(chunk); });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        if (/Parsed_gfxcapture/.test(text)) captureLost = true;
        this.lastError = text.split('\n').slice(-1)[0];
        this.log(`[h264 ${this.name}] ffmpeg: ${this.lastError}`);
      }
    });
    proc.on('error', (err) => { this.lastError = err.message; });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (!this.wanted) return;
      // No output at all. If the capture found no window (the game is closed, restarting or minimized),
      // the view keeps retrying with the same backend; otherwise the backend doesn't work with the real
      // capture and the hub picks another one.
      if (!produced && code !== 0) this.emit(captureLost ? 'capture-lost' : 'failed', this.lastError);
      if (produced) this.restarts = 0;
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.wanted) this.start();
      }, Math.min(5000, 1000 * this.restarts));
    });
  }

  stop() {
    this.wanted = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try { proc.kill(); } catch { /* ya terminó */ }
    }
  }

  /** Stop and start again (new crop, window size or backend); the next frame out is a keyframe. */
  restart(backend = this.backend) {
    const wanted = this.wanted;
    this.stop();
    this.backend = backend;
    if (wanted) this.start(backend);
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) {
      this.buf = Buffer.alloc(0);
      this.scanFrom = 0;
      return;
    }
    // Every access unit starts with an AUD; one ends where the next one starts. The scan resumes where
    // the last one stopped instead of going over the whole buffer again for every chunk.
    for (;;) {
      const start = findAud(this.buf, 0);
      if (start < 0) return;
      const next = findAud(this.buf, Math.max(start + 4, this.scanFrom));
      if (next < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        this.scanFrom = Math.max(0, this.buf.length - 5);
        return;
      }
      const au = Buffer.from(this.buf.subarray(start, next));
      this.buf = this.buf.subarray(next);
      this.scanFrom = 0;
      this._publish(au);
    }
  }

  _publish(au) {
    const types = nalTypes(au);
    // A unit without a picture (headers only, or an encoder's extra delimiter) belongs to the next frame.
    if (!types.some((t) => t >= 1 && t <= 5)) {
      this.pending = this.pending ? Buffer.concat([this.pending, au]) : au;
      return;
    }
    if (this.pending) { au = Buffer.concat([this.pending, au]); this.pending = null; }
    const key = types.includes(5);
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
      encoding: this.running,
      height: this.height,
      bitrateKbps: this.bitrate,
      fps: this.fps,
      crop: this.crop,
      frames: this.frames,
      lastFrameAt: this.lastFrameAt || null,
      lastError: this.lastError,
      measuredFps: this.running && this.startedAt && frames > 1 ? Math.round((frames / span) * 1000 * 10) / 10 : null,
      measuredKbps: this.running && this.startedAt && frames > 1 ? Math.round(((this.bytes - this.bytesAtStart) * 8) / span) : null,
    };
  }
}
