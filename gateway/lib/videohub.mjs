// Who gets which video frame, and when.
//
// One ffmpeg encodes several views of the game window on the GPU (h264.mjs):
// 'alta' (the whole window, 720p60), 'baja' (the whole window, 480p30, a third of
// the bitrate) and, in split-screen, 'p1'..'p4' (each player's part of the
// window at its own resolution, 60 fps). A viewer watches either the whole game
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
import { H264Encoder } from './h264.mjs';

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
    this.fps = fps;
    this.settings = { height, bitrate, lowHeight, lowBitrate, playerHeight, playerBitrate };
    this.screens = {};   // p1..p4 -> [x, y, w, h]: the last split-screen layout the mod reported
    this.split = false;  // split-screen on right now (off in menus and cutscenes)
    this.viewers = new Map(); // conn -> viewer
    this.encoder = new H264Encoder({ ffmpeg, source, fps, encoder, log });
    this.encoder.on('track', (track) => track.on('frame', (au, key) => this._onFrame(track.name, au, key)));
    this.encoder.setViews(this._views());
    this.timer = setInterval(() => this._evaluate(), 1000);
  }

  _views() {
    const s = this.settings;
    // The low level runs at half the rate: framestep passes every other frame on at once (fps would hold one back).
    const views = [
      { name: 'alta', height: s.height, bitrate: s.bitrate },
      { name: 'baja', height: s.lowHeight, bitrate: s.lowBitrate, step: this.fps > 30 ? 2 : 1 },
    ];
    for (const [name, crop] of Object.entries(this.screens)) {
      views.push({ name, height: s.playerHeight, bitrate: s.playerBitrate, crop });
    }
    return views;
  }

  start() {
    this.encoder.start();
  }

  get running() {
    return this.encoder.running;
  }

  get lastFrameAt() {
    return this.encoder.lastFrameAt;
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
        this.encoder.setViews(this._views());
      }
    }
    if (split !== undefined && Boolean(split) !== this.split) {
      this.split = Boolean(split);
      for (const v of this.viewers.values()) if (v.codec === 'h264') this._route(v);
    }
  }

  /** codec: 'h264' | 'jpeg'; mode: 'auto' | 'alta' | 'baja'; view: 'all' | 'mine' | 'p1'..'p4'. */
  subscribe(conn, { codec = 'h264', mode = 'auto', view = 'all' } = {}) {
    this.unsubscribe(conn);
    const v = {
      conn,
      codec: codec === 'jpeg' && this.jpeg ? 'jpeg' : 'h264',
      mode: LEVELS.includes(mode) ? mode : 'auto',
      view: VIEWS.includes(view) ? view : 'all',
      level: mode === 'baja' ? 1 : 0,
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
   * needed for pacing (no acks to fall behind on), so an 'auto' viewer goes back to the high one.
   */
  transportChanged(conn) {
    const v = this.viewers.get(conn);
    if (!v || v.codec !== 'h264') return;
    if (conn.rtc?.connected && v.mode === 'auto' && v.level !== 0) { v.level = 0; v.levelSince = Date.now(); }
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
    if (player && v.level === 0 && this.encoder.encoding(player)) track = player;
    const crop = player && track !== player ? this.screens[player] : null;
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
        if (v.mode === 'auto' && !v.conn.rtc?.connected) {
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
        view: v.view,
        track: v.track,
        transport: v.conn.rtc?.connected ? 'rtc' : 'ws',
        rtt: v.rtt == null ? null : Math.round(v.rtt),
        drops: v.drops.length,
      });
    }
  }

  status() {
    return {
      ...this.encoder.status(),
      split: this.split,
      screens: this.screens,
      viewers: [...this.viewers.values()].map((v) => ({
        address: v.conn.remoteAddress,
        codec: v.codec,
        mode: v.mode,
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
    clearInterval(this.timer);
    this.viewers.clear();
    this.encoder.stop();
  }
}
