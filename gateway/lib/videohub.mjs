// Who gets which video frame, and when.
//
// Each view of the game window is its own encoder (h264.mjs), cropped and scaled
// on the GPU: 'alta' (the whole window, 720p60), 'baja' (the whole window, 480p30,
// a third of the bitrate) and, in split-screen, 'p1'..'p4' (each player's part of
// the window at its own resolution, 60 fps). A view runs only while someone
// watches it (it stops after a quiet while), so a room where everyone looks at
// their own screen doesn't also encode the whole game. Which encoder and GPU do
// the work is lib/gpu.mjs's choice for this PC. A viewer watches either the whole game
// ('all') or one player's screen ('p1'..'p4', 'mine' = their own seat's). At the
// high level that is 'alta' or the player's own view; at the low level it is
// 'baja', which the page crops to the player's part itself.
//
// Every frame sent carries a sequence number and the page acknowledges it as
// soon as it arrives. Through Cloudflare's tunnel the server's own socket never
// fills up (cloudflared takes everything at once and queues it further away), so
// those acknowledgements are the only honest measure of how far behind a viewer
// is. When the oldest unacknowledged frame is older than the viewer's best round
// trip plus a small margin, the viewer stops getting frames until the next
// keyframe (one a second): a short freeze instead of delay that keeps growing. In
// 'auto' mode, a viewer that keeps skipping moves to the low level and tries the
// high one again after a quiet while (longer each time it fails).
//
// JPEG, for browsers without WebCodecs, is stop-and-wait: the next frame only
// goes out once the previous one was acknowledged.
//
// Video must come back by itself from anything short of the room closing. A
// capture with no window to capture (the game closed, restarting or minimized) is
// not the encoder's fault: views wait for the window (the room's window keeper says
// when it goes and comes back) and keep the encoder. An encoder is only given up
// when it gives no picture while the window is there; when every one has been
// given up, they are all tried again after a while. A view that runs but stops
// giving frames is restarted.
import { H264View } from './h264.mjs';
import { chooseBackend } from './gpu.mjs';
import { resolveFfmpeg, windowSelector } from './video.mjs';

export const VIDEO_H264 = 1;
export const VIDEO_JPEG = 2;
export const LEVELS = ['alta', 'baja'];
export const VIEWS = ['all', 'mine', 'p1', 'p2', 'p3', 'p4'];
const PLAYER_VIEWS = ['p1', 'p2', 'p3', 'p4'];
const TRACK_IDS = { alta: 0, baja: 1, p1: 2, p2: 3, p3: 4, p4: 5 }; // the packet's third byte

const MARGIN_MS = 160;          // queueing allowed on top of the viewer's best round trip
const MAX_INFLIGHT = 24;        // frames sent and not yet acknowledged
const DROP_WINDOW_MS = 10000;
const DOWNGRADE_DROPS = 2;      // skips within the window that move an 'auto' viewer down
const UPGRADE_AFTER_MS = 20000; // quiet time on the low level before trying the high one again
const UPGRADE_MAX_MS = 180000;
const IDLE_STOP_MS = 15000;     // a view nobody has watched for this long stops encoding
const STALL_MS = 10000;         // a running view with no frame for this long is restarted
const CAPTURE_GIVEUP_MS = 10000; // the capture failing this long with the window present: the backend's fault
const RETRY_MIN_MS = 10000;     // every backend given up: try them all again after this...
const RETRY_MAX_MS = 60000;     // ...doubling up to this

/** The mod's split-screen layouts (splitscreen.cpp), as [x, y, w, h] fractions per player. */
export function layoutFor(count, horizontal = false) {
  const two = horizontal ? [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] : [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]];
  const layouts = {
    2: two,
    3: [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
    4: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  };
  const rects = layouts[count] || [];
  return Object.fromEntries(rects.map((r, i) => [`p${i + 1}`, r]));
}

/** Binary message: [kind][flags: 1 = keyframe][track][0][sequence u32 LE][payload]. */
function packet(kind, key, track, seq, payload) {
  const header = Buffer.allocUnsafe(8);
  header[0] = kind;
  header[1] = key ? 1 : 0;
  header[2] = track;
  header[3] = 0;
  header.writeUInt32LE(seq >>> 0, 4);
  return Buffer.concat([header, payload]);
}

export class VideoHub {
  constructor({
    ffmpeg, source, fps = 60, height = 720, bitrate = 4000, lowHeight = 480, lowBitrate = 1200,
    playerHeight = 480, playerBitrate = 2500, encoder = 'auto', jpeg = null, seatOf = () => null, log = console.log,
  }) {
    this.log = log;
    this.jpeg = jpeg;
    this.seatOf = seatOf; // conn -> seat number or null, for 'mine'
    this.ffmpeg = resolveFfmpeg(ffmpeg);
    this.selector = windowSelector(source);
    this.forcedEncoder = encoder;
    this.fps = fps;
    this.settings = { height, bitrate, lowHeight, lowBitrate, playerHeight, playerBitrate };
    this.screens = {};   // p1..p4 -> [x, y, w, h]: the last split-screen layout the mod reported
    this.split = false;  // split-screen on right now (off in menus and cutscenes)
    this.window = { width: 1280, height: 960 }; // the game window's client area (game-window.ps1 reports it)
    this.viewers = new Map(); // conn -> viewer
    this.views = new Map();   // name -> H264View
    this.lastUse = new Map(); // name -> last time a viewer was on it
    this.backend = null;      // what encodes (lib/gpu.mjs), once chosen
    this.failedBackends = [];
    this.choosing = null;
    this.retryTimer = null;   // all backends given up: when they are tried again
    this.retryDelay = RETRY_MIN_MS;
    this.windowPresent = true; // false while the window keeper reports no game window
    this.waiting = new Set();  // views wanted while there is no window, started when it's back
    this.captureLostSince = 0; // first capture failure of the current streak with the window present (0: none)
    this.captureLostLast = 0;
    this.lastCaptureLog = 0;
    this.stopped = false;
    this.timer = setInterval(() => this._evaluate(), 1000);
  }

  /** What each view is: the whole game (two qualities) and each player's part of the split screen. */
  _definition(name) {
    const s = this.settings;
    const cpu = this.backend?.mode === 'cpu';
    if (name === 'alta') return { height: s.height, bitrate: s.bitrate, fps: cpu ? Math.min(this.fps, 30) : this.fps, crop: null };
    if (name === 'baja') return { height: s.lowHeight, bitrate: s.lowBitrate, fps: Math.min(this.fps, 30), crop: null };
    const crop = this.screens[name];
    return crop ? { height: s.playerHeight, bitrate: s.playerBitrate, fps: this.fps, crop } : null;
  }

  /** The view's encoder, created on first use; started if it isn't running. */
  _ensure(name) {
    this.lastUse.set(name, Date.now());
    if (!this.windowPresent) { this.waiting.add(name); return null; }
    if (!this.backend || !this.selector) return null;
    const def = this._definition(name);
    if (!def) return null;
    let view = this.views.get(name);
    if (!view) {
      view = new H264View({ name, ...def, selector: this.selector, ffmpeg: this.ffmpeg, log: this.log });
      view.window = { ...this.window };
      view.on('frame', (au, key) => { this.captureLostSince = 0; this._onFrame(name, au, key); });
      view.on('failed', (error) => this._backendFailed(error));
      view.on('capture-lost', (error) => this._captureLost(name, error));
      this.views.set(name, view);
    }
    if (!view.running && !view.wanted) this.log(`[vídeo] empiezo a codificar «${name}»`);
    view.start(this.backend);
    return view;
  }

  /** Picks the encoder for this PC (once), then starts whatever viewers already wait for. */
  start() {
    if (this.choosing || this.backend || this.stopped || this.retryTimer) return this.choosing;
    this.choosing = chooseBackend(this.ffmpeg, { forced: this.forcedEncoder, skip: this.failedBackends, log: this.log })
      .catch((error) => { this.log(`[vídeo] no pude elegir codificador: ${error.message}`); return null; })
      .then((backend) => {
        this.choosing = null;
        if (this.stopped) return;
        if (!backend) { this._retryAll(); return; }
        this.backend = backend;
        this.retryDelay = RETRY_MIN_MS;
        for (const v of this.viewers.values()) if (v.codec === 'h264') this._route(v, true);
      });
    return this.choosing;
  }

  /** Every backend was given up (or none works yet): forget that and try them all again in a while. */
  _retryAll(delay = this.retryDelay) {
    if (this.retryTimer || this.stopped) return;
    this.log(`[vídeo] ningún codificador dio imagen; vuelvo a probarlos todos en ${Math.round(delay / 1000)} s`);
    this.retryDelay = Math.min(RETRY_MAX_MS, delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.failedBackends = [];
      this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** The chosen backend gave no picture with the real capture: try the next one for every view. */
  _backendFailed(error) {
    if (!this.backend || this.choosing) return;
    this.log(`[vídeo] ${this.backend.key} no funciona con la captura real (${error}); pruebo el siguiente`);
    this.failedBackends.push(this.backend.key);
    this.backend = null;
    this.captureLostSince = 0;
    const running = [...this.views.entries()].filter(([, view]) => view.wanted).map(([name]) => name);
    for (const view of this.views.values()) view.stop();
    this.start()?.then(() => { for (const name of running) this._ensure(name); });
  }

  /**
   * gfxcapture found nothing to capture. Normally the window is gone or minimized for a moment and the view
   * just retries; only when it keeps failing with the window there is the backend's capture device at fault.
   */
  _captureLost(name, error) {
    const now = Date.now();
    if (now - this.lastCaptureLog > 30000) {
      this.lastCaptureLog = now;
      this.log(`[vídeo] «${name}» no encuentra la ventana del juego; reintento hasta que aparezca`);
    }
    if (!this.windowPresent) return;
    // Only a streak counts: failures that stopped a while ago (nobody watched since) start a new one.
    if (!this.captureLostSince || now - this.captureLostLast > CAPTURE_GIVEUP_MS) this.captureLostSince = now;
    this.captureLostLast = now;
    if (now - this.captureLostSince > CAPTURE_GIVEUP_MS) this._backendFailed(error);
  }

  /** The window keeper found no game window (closed or restarting): views wait for it instead of failing. */
  windowGone() {
    if (!this.windowPresent) return;
    this.windowPresent = false;
    this.captureLostSince = 0;
    for (const [name, view] of this.views) {
      if (!view.wanted) continue;
      this.waiting.add(name);
      view.stop();
    }
    this.log('[vídeo] no hay ventana del juego: el vídeo sigue en cuanto vuelva');
  }

  /** The game window is back: the waiting views start now, and given-up backends get another chance. */
  windowBack() {
    if (this.windowPresent) return;
    this.windowPresent = true;
    this.log('[vídeo] volvió la ventana del juego');
    if (!this.backend && !this.choosing) {
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      this.failedBackends = [];
      this.retryDelay = RETRY_MIN_MS;
    }
    const recent = [...this.waiting].filter((name) => Date.now() - (this.lastUse.get(name) || 0) < IDLE_STOP_MS);
    this.waiting.clear();
    if (this.backend) for (const name of recent) this._ensure(name);
    else this.start()?.then(() => { for (const name of recent) this._ensure(name); });
  }

  get running() {
    return [...this.views.values()].some((view) => view.running);
  }

  get lastFrameAt() {
    return Math.max(0, ...[...this.views.values()].map((view) => view.lastFrameAt));
  }

  /** The game window's size (game-window.ps1): crops are in its pixels, so running views start again. */
  setWindowSize(width, height) {
    if (!width || !height || (width === this.window.width && height === this.window.height)) return;
    this.window = { width, height };
    for (const view of this.views.values()) {
      view.window = { ...this.window };
      if (view.wanted) view.restart(this.backend);
    }
  }

  /**
   * What the mod says about split-screen: whether it's on and, when it is, each player's part of
   * the window. The players' views are re-cut only when that layout changes (a new player count).
   */
  setLayout({ split, screens }) {
    if (screens && Object.keys(screens).length) {
      const next = Object.fromEntries(Object.entries(screens).filter(([k]) => PLAYER_VIEWS.includes(k)).sort());
      if (JSON.stringify(next) !== JSON.stringify(this.screens)) {
        this.screens = next;
        this.log(`[vídeo] pantalla dividida: ${Object.keys(next).length} jugadores`);
        for (const [name, view] of this.views) {
          const def = this._definition(name);
          if (!def) { view.stop(); this.views.delete(name); continue; }
          if (view.configure(def) && view.wanted) view.restart(this.backend);
        }
      }
    }
    if (split !== undefined && Boolean(split) !== this.split) {
      this.split = Boolean(split);
      for (const v of this.viewers.values()) if (v.codec === 'h264') this._route(v);
    }
  }

  /** codec: 'h264' | 'jpeg'; mode: 'auto' | 'alta' | 'baja'; view: 'all' | 'mine' | 'p1'..'p4'. */
  subscribe(conn, { codec = 'h264', mode = 'auto', view = 'all', mobile = false } = {}) {
    this.unsubscribe(conn);
    const v = {
      conn,
      codec: codec === 'jpeg' && this.jpeg ? 'jpeg' : 'h264',
      mode: LEVELS.includes(mode) ? mode : 'auto',
      view: VIEWS.includes(view) ? view : 'all',
      mobile: mobile === true,
      level: mode === 'baja' || (mode === 'auto' && mobile === true) ? 1 : 0,
      track: null,
      crop: null,
      seq: 0,
      inflight: new Map(), // seq -> sent at
      needKey: true,
      rtt: null,
      minRtt: Infinity,
      samples: [],
      drops: [],
      levelSince: Date.now(),
      upgradeWait: UPGRADE_AFTER_MS,
      lastUpgradeAt: 0,
      sent: 0,
      skipped: 0,
      jpegPending: false,
      jpegSentAt: 0,
      stopJpeg: null,
    };
    this.viewers.set(conn, v);
    if (v.codec === 'jpeg') {
      v.stopJpeg = this.jpeg.addListener((jpeg) => this._sendJpeg(v, jpeg));
      return;
    }
    this._route(v, true);
  }

  unsubscribe(conn) {
    const v = this.viewers.get(conn);
    if (!v) return;
    if (v.stopJpeg) v.stopJpeg();
    this.viewers.delete(conn);
  }

  /** The viewer's seat changed ('mine' follows it). */
  reroute(conn) {
    const v = this.viewers.get(conn);
    if (v && v.codec === 'h264') this._route(v);
  }

  /**
   * The viewer's direct connection came up or went away: frames switch between RTP and the WebSocket,
   * and either way the page starts over at the next keyframe. On a direct connection the low level isn't
   * needed for pacing (no acks to fall behind on), so a desktop 'auto' viewer goes back to the high one.
   */
  transportChanged(conn) {
    const v = this.viewers.get(conn);
    if (!v || v.codec !== 'h264') return;
    if (conn.rtc?.connected && v.mode === 'auto' && !v.mobile && v.level !== 0) { v.level = 0; v.levelSince = Date.now(); }
    this._route(v, true);
  }

  /** The page received frame `seq` (acknowledgements arrive in order: TCP). */
  ack(conn, seq) {
    const v = this.viewers.get(conn);
    if (!v || !Number.isFinite(seq)) return;
    const now = Date.now();
    if (v.codec === 'jpeg') {
      if (v.jpegPending) this._sample(v, now - v.jpegSentAt);
      v.jpegPending = false;
      return;
    }
    for (const [s, sentAt] of v.inflight) {
      if (s > seq) break;
      if (s === seq) this._sample(v, now - sentAt);
      v.inflight.delete(s);
    }
  }

  _sample(v, ms) {
    const now = Date.now();
    v.rtt = v.rtt == null ? ms : v.rtt * 0.85 + ms * 0.15;
    v.samples.push([now, ms]);
    while (v.samples.length && now - v.samples[0][0] > 10000) v.samples.shift();
    // The best recent round trip is the path's delay with nothing queued.
    v.minRtt = v.samples.reduce((m, s) => Math.min(m, s[1]), Infinity);
  }

  /** The player view this viewer wants right now, or null for the whole game. */
  _playerView(v) {
    if (!this.split) return null; // menus and cutscenes fill the window: everyone sees all of it
    const seat = v.view === 'mine' ? this.seatOf(v.conn) : null;
    const name = v.view === 'mine' ? (seat ? `p${seat}` : null) : v.view;
    return name && this.screens[name] ? name : null;
  }

  /** Picks the track (and the crop the page applies) for the viewer's view and level; tells the page on a change. */
  _route(v, force = false) {
    const player = this._playerView(v);
    let track = v.level === 1 ? 'baja' : 'alta';
    // Without a GPU encoder, players' screens aren't encoded on their own: the page crops the whole game.
    if (player && v.level === 0 && this.backend?.mode !== 'cpu') track = player;
    const crop = player && track !== player ? this.screens[player] : null;
    this._ensure(track);
    if (!force && track === v.track && JSON.stringify(crop) === JSON.stringify(v.crop)) return;
    v.track = track;
    v.crop = crop;
    v.needKey = true; // the new encoding starts at its next keyframe (within a second)
    if (v.conn.rtc) v.conn.rtc.needKey = true; // same on a direct connection: no P-frames of another view
    v.inflight.clear();
    v.conn.send({ t: 'vtier', tier: LEVELS[v.level], mode: v.mode, view: v.view, player, track, crop });
  }

  _setLevel(v, level) {
    v.level = level;
    v.levelSince = Date.now();
    this._route(v, true);
  }

  _behind(v, now) {
    if (v.inflight.size >= MAX_INFLIGHT) return true;
    const oldest = v.inflight.values().next().value; // Map keeps insertion order
    if (oldest === undefined) return false;
    const base = Number.isFinite(v.minRtt) ? v.minRtt : 150;
    return now - oldest > base + MARGIN_MS;
  }

  _onFrame(track, au, key) {
    const now = Date.now();
    const id = TRACK_IDS[track] ?? 0;
    for (const v of this.viewers.values()) {
      if (v.codec !== 'h264' || v.track !== track) continue;
      if (v.conn.closed) { this.unsubscribe(v.conn); continue; }
      // Direct connection (rtc.mjs): RTP over UDP, the browser's own jitter buffer and NACK/PLI instead of acks.
      if (v.conn.rtc?.connected) {
        if (v.conn.rtc.sendFrame(au, key)) v.sent += 1;
        else v.skipped += 1;
        continue;
      }
      if (v.needKey && !key) { v.skipped += 1; continue; }
      if (this._behind(v, now)) {
        if (!v.needKey) v.drops.push(now); // start of a skip: count it once
        v.needKey = true;
        v.skipped += 1;
        continue;
      }
      v.needKey = false;
      v.seq += 1;
      v.inflight.set(v.seq, now);
      v.sent += 1;
      v.conn.sendBinary(packet(VIDEO_H264, key, id, v.seq, au));
    }
  }

  _sendJpeg(v, jpeg) {
    if (v.conn.closed) return;
    if (v.jpegPending && Date.now() - v.jpegSentAt < 2000) { v.skipped += 1; return; }
    v.seq += 1;
    v.jpegPending = true;
    v.jpegSentAt = Date.now();
    v.sent += 1;
    v.conn.sendBinary(packet(VIDEO_JPEG, true, 0, v.seq, jpeg));
  }

  _evaluate() {
    const now = Date.now();
    for (const v of [...this.viewers.values()]) {
      if (v.conn.closed) { this.unsubscribe(v.conn); continue; }
      v.drops = v.drops.filter((t) => now - t < DROP_WINDOW_MS);
      if (v.codec === 'h264') {
        if (v.track) this.lastUse.set(v.track, now);
        if (v.mode === 'auto' && !v.mobile && !v.conn.rtc?.connected) {
          if (v.level === 0 && v.drops.length >= DOWNGRADE_DROPS) {
            // Failing again soon after an upgrade: wait longer before the next try.
            if (now - v.lastUpgradeAt < 30000) v.upgradeWait = Math.min(v.upgradeWait * 2, UPGRADE_MAX_MS);
            this.log(`[vídeo] ${v.conn.remoteAddress} baja de calidad (${v.drops.length} saltos, rtt ${Math.round(v.rtt || 0)} ms)`);
            v.drops = [];
            this._setLevel(v, 1);
          } else if (v.level === 1 && v.drops.length === 0 && now - v.levelSince > v.upgradeWait) {
            v.lastUpgradeAt = now;
            this._setLevel(v, 0);
          } else if (v.level === 0 && now - v.lastUpgradeAt > 90000) {
            v.upgradeWait = UPGRADE_AFTER_MS; // a long good run resets the backoff
          }
        }
        this._route(v); // a seat change ('mine') or a view that stopped or started encoding
      }
      v.conn.send({
        t: 'vstat',
        codec: v.codec,
        tier: LEVELS[v.level],
        mode: v.mode,
        mobile: v.mobile,
        view: v.view,
        track: v.track,
        transport: v.conn.rtc?.connected ? 'rtc' : 'ws',
        rtt: v.rtt == null ? null : Math.round(v.rtt),
        drops: v.drops.length,
        // Why no picture comes, for the page to say so: no game window (closed or restarting), or no encoder yet.
        wait: !this.windowPresent ? 'window' : !this.backend && v.codec === 'h264' ? 'encoder' : null,
      });
    }
    // Views nobody watches stop encoding (one viewer moving to another view, or everyone leaving).
    for (const [name, view] of this.views) {
      if (view.wanted && now - (this.lastUse.get(name) || 0) > IDLE_STOP_MS) {
        this.log(`[vídeo] nadie mira «${name}»: dejo de codificarla`);
        view.stop();
      }
    }
    // Stalled views: running, but no frame for a while (a capture that hung, a window that stopped drawing).
    for (const [name, view] of this.views) {
      if (!view.wanted || !view.running || !this.windowPresent) continue;
      if (now - Math.max(view.startedAt, view.lastFrameAt) > STALL_MS) {
        // A game that stays frozen (its crash dialog, say) gets restarted every time, but logged once a minute.
        if (now - (view.stallLoggedAt || 0) > 60000) {
          view.stallLoggedAt = now;
          this.log(`[vídeo] «${name}» lleva ${Math.round(STALL_MS / 1000)} s sin cuadros: la reinicio`);
        }
        view.restart(this.backend);
      }
    }
    // Someone waits for H.264 and nothing encodes it: make sure an encoder is (being) chosen.
    if (!this.backend && this.windowPresent && [...this.viewers.values()].some((v) => v.codec === 'h264')) this.start();
  }

  status() {
    return {
      running: this.running,
      encoder: this.backend ? `${this.backend.encoder} (${this.backend.mode})` : this.choosing ? 'eligiendo…' : this.retryTimer ? 'reintentando' : 'ninguno',
      gpu: this.backend?.gpu ?? null,
      lastError: [...this.views.values()].map((view) => view.lastError).find(Boolean) ?? null,
      lastFrameAt: this.lastFrameAt || null,
      window: { ...this.window, present: this.windowPresent },
      views: Object.fromEntries([...this.views.entries()].map(([name, view]) => [name, view.status()])),
      split: this.split,
      screens: this.screens,
      viewers: [...this.viewers.values()].map((v) => ({
        address: v.conn.remoteAddress,
        codec: v.codec,
        mode: v.mode,
        mobile: v.mobile,
        view: v.view,
        track: v.track,
        level: LEVELS[v.level],
        transport: v.conn.rtc?.connected ? 'rtc' : 'ws',
        rttMs: v.rtt == null ? null : Math.round(v.rtt),
        minRttMs: Number.isFinite(v.minRtt) ? v.minRtt : null,
        inflight: v.inflight.size,
        sent: v.sent,
        skipped: v.skipped,
        recentDrops: v.drops.length,
      })),
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.viewers.clear();
    for (const view of this.views.values()) view.stop();
  }
}
