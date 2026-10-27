// The player page's real-time side: the room's WebSocket, the video (WebCodecs onto a canvas, or the
// direct WebRTC stream), the game's sound, the controls, and the latency test. It runs outside React:
// frames are drawn the moment they're decoded, and React only reads the state below to draw the UI.
import { toast } from 'sonner';
import { createStore, saved, session } from '@/lib/store';
import { CHARACTERS, CHARACTER_IDS, DEFAULT_CAST, characterName, type Character } from '@/lib/game';

export const BUTTONS = ['a', 'b', 'x', 'y', 'up', 'down', 'left', 'right', 'lb', 'rb', 'lt', 'rt', 'start', 'back'] as const;
export const AXES = ['lx', 'ly', 'rx', 'ry'] as const;
type Button = (typeof BUTTONS)[number];
type Axis = (typeof AXES)[number];
type Pad = { b: Record<Button, boolean>; a: Record<Axis, number> };

export type Seat = { index: number; host?: boolean; occupied: boolean; name: string | null; padAge: number | null; want: string | null };
export type ChatLine = { id: number; name: string; seat: number | null; text: string };
export type FloatingEmote = { id: number; e: string; name: string; seat: number | null; left: number };
type Tone = 'ok' | 'warn' | 'bad' | '';

export const VIEWS = [
  ['mine', 'Mi pantalla'],
  ['all', 'Toda la partida'],
  ['p1', 'Jugador 1'],
  ['p2', 'Jugador 2'],
  ['p3', 'Jugador 3'],
  ['p4', 'Jugador 4'],
] as const;

const params = new URLSearchParams(location.search);
const initialCode = (params.get('code') || '').toUpperCase();

export const ui = createStore({
  code: initialCode,
  conn: { text: 'sin conectar', tone: '' as Tone },
  msg: { text: '', tone: '' as Tone },
  connected: false,
  seat: null as number | null,
  role: null as 'player' | 'spectator' | null,
  seats: [] as Seat[],
  spectators: 0,
  game: { online: false } as { online: boolean; stage?: number; characters?: number[] },
  characters: [] as string[],
  wsRtt: null as number | null,
  hasFrame: false,
  placeholder: initialCode ? 'Conectando con la partida…' : 'Escribe el código de la sala en «Sala».',
  videoWait: null as string | null, // why the room has no picture right now (vstat), or null
  video: { codec: null as string | null, fps: 0, rtt: null as number | null, tier: null as string | null, player: null as string | null, crop: null as number[] | null },
  view: saved.get('ulm-view', 'mine') || 'mine',
  quality: saved.get('ulm-quality', 'auto') || 'auto',
  sound: { available: false, on: saved.get('ulm-audio') === '1' },
  direct: { available: false, enabled: saved.get('ulm-direct', '1') === '1', showing: false, connecting: false, declined: false, reason: '' },
  chat: [] as ChatLine[],
  emotes: [] as FloatingEmote[],
  pad: { source: 'reposo', info: 'esperando…', b: {} as Record<string, boolean>, lx: 0, ly: 0 },
  latency: { busy: false, text: 'del botón a la imagen' },
  name: saved.get('ulm-name'),
  gate: { open: false, message: '' },
  blocked: null as null | 'password' | 'kicked',
});
type UiState = ReturnType<typeof ui.get>;

const emptyPad = (): Pad => ({
  b: Object.fromEntries(BUTTONS.map((n) => [n, false])) as Record<Button, boolean>,
  a: { lx: 0, ly: 0, rx: 0, ry: 0 },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- state that isn't drawn ----------
const state = {
  ws: null as WebSocket | null,
  password: session.get(`ulm-pw-${initialCode}`),
  lastSent: '', lastPadSentAt: 0, pingAt: 0, padSeq: 0, retry: 0,
  keys: new Set<string>(), touchAxes: { lx: 0, ly: 0 }, touchButtons: new Set<string>(),
  streamOn: false,
};
let ids = 0;
const els = { canvas: null as HTMLCanvasElement | null, video: null as HTMLVideoElement | null, stage: null as HTMLElement | null };
let ctx: CanvasRenderingContext2D | null = null;
export const hooks = { focusChat: () => {} };

function setMsg(text: string, tone: Tone = '') { ui.set({ msg: { text, tone } }); }
function setConn(text: string, tone: Tone) { ui.set({ conn: { text, tone } }); }
function patchVideo(p: Partial<UiState['video']>) { ui.set((s) => ({ video: { ...s.video, ...p } })); }
function patchDirect(p: Partial<UiState['direct']>) { ui.set((s) => ({ direct: { ...s.direct, ...p } })); }
export function shareLink() { return `${location.origin}/?code=${ui.get().code}`; }

/** The canvas the video is drawn on, the element for the direct stream, and the stage (for fullscreen). */
export function attach(canvas: HTMLCanvasElement, videoEl: HTMLVideoElement, stage: HTMLElement) {
  els.canvas = canvas;
  els.video = videoEl;
  els.stage = stage;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
}

// ---------- vídeo ----------
// The host pushes video over the same WebSocket as the controls: binary messages
// [kind][flags: 1 = keyframe][track][0][sequence u32] + frame. Every frame is
// acknowledged as soon as it arrives, which is how the host keeps this viewer's
// delay from piling up. H.264 is decoded with WebCodecs and each frame is drawn
// as soon as it's decoded (requestAnimationFrame stalls in hidden or throttled
// views, and the browser shows the canvas's latest contents at the next refresh).
const VIDEO_H264 = 1, VIDEO_JPEG = 2, AUDIO_OPUS = 3;
const video = {
  codec: null as string | null, decoder: null as VideoDecoder | null, configured: null as string | null,
  waitKey: true, timestamp: 0, shown: 0, since: performance.now(), lastShownAt: 0, jpegBusy: false,
  crop: null as number[] | null,
  stats: { received: 0, decoded: 0, drawn: 0, skippedQueue: 0, maxQueue: 0 },
};
(window as any).sadxVideo = video; // for diagnosing from the console

async function pickCodec() {
  if (!('VideoDecoder' in window)) return 'jpeg';
  try {
    const check = await VideoDecoder.isConfigSupported({ codec: 'avc1.42C01E', optimizeForLatency: true });
    return check.supported ? 'h264' : 'jpeg';
  } catch {
    return 'jpeg';
  }
}

function requestVideo() {
  const s = ui.get();
  if (state.ws && state.ws.readyState === WebSocket.OPEN && video.codec) {
    state.ws.send(JSON.stringify({ t: 'video', codec: video.codec, quality: s.quality, view: s.view }));
  }
}

async function startStream() {
  if (!ui.get().code || !ui.get().connected || state.streamOn) return;
  state.streamOn = true;
  video.codec = await pickCodec();
  patchVideo({ codec: video.codec });
  requestVideo();
}

function present(source: CanvasImageSource, width: number, height: number) {
  const canvas = els.canvas;
  if (!canvas || !ctx) return;
  const c = video.crop;
  const sx = c ? Math.round(c[0] * width) : 0;
  const sy = c ? Math.round(c[1] * height) : 0;
  const sw = c ? Math.round(c[2] * width) : width;
  const sh = c ? Math.round(c[3] * height) : height;
  if (canvas.width !== sw || canvas.height !== sh) {
    canvas.width = sw;
    canvas.height = sh;
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  canvas.dataset.frames = String(Number(canvas.dataset.frames || 0) + 1);
  if (!ui.get().hasFrame) ui.set({ hasFrame: true });
  countFrame();
}

/** A frame reached the canvas (on a direct connection the browser's own statistics count them). */
function countFrame() {
  if (probe.onFrame) probe.onFrame(performance.now());
  if (rtc.showing) return;
  video.shown += 1;
  const now = performance.now();
  video.lastShownAt = now;
  if (now - video.since >= 1000) {
    patchVideo({ fps: Math.round((video.shown * 1000) / (now - video.since)) });
    video.shown = 0;
    video.since = now;
  }
}

/** WebCodecs codec string ("avc1.PPCCLL") from the SPS in a keyframe. */
function codecFromSps(au: Uint8Array) {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
      const hex = (v: number) => v.toString(16).padStart(2, '0');
      return `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`;
    }
  }
  return null;
}

function resetDecoder() {
  if (video.decoder && video.decoder.state !== 'closed') {
    try { video.decoder.close(); } catch { /* already closed */ }
  }
  video.decoder = null;
  video.configured = null;
  video.waitKey = true;
}

function onBinary(buffer: ArrayBuffer) {
  if (buffer.byteLength < 9) return;
  const head = new DataView(buffer);
  const kind = head.getUint8(0), key = head.getUint8(1) === 1, seq = head.getUint32(4, true);
  const payload = new Uint8Array(buffer, 8);
  if (kind === AUDIO_OPUS) { onAudio(payload); return; }
  // Acknowledge video on arrival: the host paces this viewer by these.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(`{"t":"va","s":${seq}}`);
  if (kind === VIDEO_JPEG) { drawJpeg(payload); return; }
  if (kind !== VIDEO_H264) return;
  if (video.waitKey && !key) return;
  if (key) {
    const codec = codecFromSps(payload) || 'avc1.42C01E';
    if (!video.decoder || codec !== video.configured) {
      resetDecoder();
      video.decoder = new VideoDecoder({
        output: (frame) => {
          video.stats.decoded += 1;
          video.stats.drawn += 1;
          present(frame, frame.displayWidth, frame.displayHeight);
          frame.close();
        },
        error: (err) => { console.warn('decodificador de vídeo:', err); resetDecoder(); },
      });
      video.decoder.configure({ codec, optimizeForLatency: true });
      video.configured = codec;
    }
    video.waitKey = false;
  }
  if (!video.decoder || video.decoder.state !== 'configured') return;
  video.stats.received += 1;
  video.stats.maxQueue = Math.max(video.stats.maxQueue, video.decoder.decodeQueueSize);
  // A device that can't keep up skips to the next keyframe instead of falling behind.
  if (video.decoder.decodeQueueSize > 4 && !key) { video.stats.skippedQueue += 1; video.waitKey = true; return; }
  video.timestamp += 16667;
  video.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: video.timestamp, data: payload }));
}

async function drawJpeg(data: Uint8Array) {
  if (video.jpegBusy) return;
  video.jpegBusy = true;
  try {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }));
    present(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
  } catch {
    /* damaged frame: the next one replaces it */
  } finally {
    video.jpegBusy = false;
  }
}

export function setQuality(value: string) {
  saved.set('ulm-quality', value);
  ui.set({ quality: value });
  resetDecoder();
  requestVideo();
}

export function setView(value: string) {
  saved.set('ulm-view', value);
  ui.set({ view: value });
  resetDecoder();
  requestVideo();
}

// ---------- sonido ----------
// Only the game's sound (the mod sends SADX's own mix), Opus in 20 ms packets on the same WebSocket.
// Each decoded packet is scheduled right after the previous one; if playback runs more than a quarter
// of a second ahead of now (the network delivered a burst), packets are dropped to stay with the picture.
const sound = {
  ctx: null as AudioContext | null, gain: null as GainNode | null, decoder: null as AudioDecoder | null,
  next: 0, timestamp: 0, stats: { received: 0, played: 0, dropped: 0 },
};
(window as any).sadxAudio = sound;
export const soundSupported = () => 'AudioDecoder' in window && 'AudioContext' in window;

function startSound() {
  if (!sound.ctx) {
    sound.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    sound.gain = sound.ctx.createGain();
    sound.gain.connect(sound.ctx.destination);
  }
  sound.ctx.resume().catch(() => {});
  if (!sound.decoder || sound.decoder.state === 'closed') {
    sound.decoder = new AudioDecoder({
      output: playAudio,
      error: (err) => { console.warn('decodificador de sonido:', err); sound.decoder = null; },
    });
    sound.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  }
  sound.next = 0;
  send({ t: 'audio', on: true });
}

export function setSound(on: boolean) {
  saved.set('ulm-audio', on ? '1' : '0');
  ui.set((s) => ({ sound: { ...s.sound, on } }));
  if (on) startSound();
  else { send({ t: 'audio', on: false }); sound.ctx?.suspend().catch(() => {}); }
}

function playAudio(data: AudioData) {
  const actx = sound.ctx;
  if (!actx || !sound.gain) { data.close(); return; }
  const frames = data.numberOfFrames;
  const buffer = actx.createBuffer(data.numberOfChannels, frames, data.sampleRate);
  for (let ch = 0; ch < data.numberOfChannels; ch++) {
    const plane = new Float32Array(frames);
    data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
    buffer.copyToChannel(plane, ch);
  }
  data.close();
  const now = actx.currentTime;
  if (sound.next < now + 0.01) sound.next = now + 0.05; // ran dry: start again with a small cushion
  if (sound.next > now + 0.25) { sound.stats.dropped += 1; return; }
  const src = actx.createBufferSource();
  src.buffer = buffer;
  src.connect(sound.gain);
  src.start(sound.next);
  sound.next += buffer.duration;
  sound.stats.played += 1;
}

function onAudio(payload: Uint8Array) {
  if (!ui.get().sound.on || !sound.decoder || sound.decoder.state !== 'configured') return;
  sound.stats.received += 1;
  sound.timestamp += 20000;
  sound.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: sound.timestamp, data: payload }));
}

// Browsers only start sound after a click or a key: if it was on last time, the first one turns it back on.
const resumeSound = () => {
  const s = ui.get().sound;
  if (s.on && s.available && (!sound.ctx || sound.ctx.state !== 'running')) startSound();
};
window.addEventListener('pointerdown', resumeSound, { once: true });
window.addEventListener('keydown', resumeSound, { once: true });

// ---------- conexión directa (WebRTC) ----------
// When the host offers it, the video comes as RTP over UDP straight from the host's PC and the controls
// go on an unordered data channel: no detour through the tunnel, and a lost packet doesn't hold up the
// rest. The WebSocket keeps everything else, and the video falls back to it if the direct path doesn't
// come up within a few seconds or drops later.
const RTC_MIN_GAIN_MS = 20;
const rtc = {
  pc: null as RTCPeerConnection | 'pending' | null, channel: null as RTCDataChannel | null,
  showing: false, fallbackTimer: 0, statsTimer: 0,
  forced: params.get('direct') === '1', // ?direct=1 keeps it even if it isn't faster (testing)
};
(window as any).sadxRtc = rtc;

function syncDirect() {
  patchDirect({ showing: rtc.showing, connecting: rtc.pc !== null && !rtc.showing });
}

function startRtc() {
  const d = ui.get().direct;
  if (!d.enabled || !d.available || rtc.pc || d.declined || !('RTCPeerConnection' in window) || video.codec !== 'h264') return;
  rtc.pc = 'pending';
  send({ t: 'rtc', op: 'start' });
  syncDirect();
}

function stopRtc(tellHost: boolean) {
  clearTimeout(rtc.fallbackTimer);
  clearInterval(rtc.statsTimer);
  if (rtc.pc && rtc.pc !== 'pending') { try { rtc.pc.close(); } catch { /* cerrada */ } }
  rtc.pc = null;
  rtc.channel = null;
  rtc.showing = false;
  if (els.video) els.video.srcObject = null;
  if (tellHost) send({ t: 'rtc', op: 'stop' });
  syncDirect();
}

function waitIceGathering(pc: RTCPeerConnection, ms: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
  });
}

async function onRtcOffer(sdp: string) {
  if (rtc.pc && rtc.pc !== 'pending') rtc.pc.close();
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  rtc.pc = pc;
  pc.addEventListener('track', (ev) => {
    // Play as soon as a frame is decodable: no extra playout buffer on top of the network's.
    try { (ev.receiver as any).jitterBufferTarget = 0; } catch { /* not supported */ }
    try { (ev.receiver as any).playoutDelayHint = 0; } catch { /* not supported */ }
    if (!els.video) return;
    els.video.srcObject = new MediaStream([ev.track]);
    els.video.play().catch(() => {});
    watchRtcFrames();
  });
  pc.addEventListener('datachannel', (ev) => { rtc.channel = ev.channel; });
  pc.addEventListener('connectionstatechange', () => {
    if (rtc.pc !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected') { clearTimeout(rtc.fallbackTimer); pollRtcStats(pc); }
    if (s === 'failed' || s === 'closed' || s === 'disconnected') stopRtc(true);
    syncDirect();
  });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceGathering(pc, 3000);
    if (rtc.pc !== pc) return;
    send({ t: 'rtc', op: 'answer', sdp: pc.localDescription?.sdp });
    // No direct path (strict router, firewall): stay on the tunnel.
    rtc.fallbackTimer = window.setTimeout(() => { if (rtc.pc === pc && !rtc.showing) stopRtc(true); }, 8000);
  } catch (err) {
    console.warn('conexión directa:', err);
    stopRtc(true);
  }
}

/** The direct video replaces the canvas once it has a picture (no per-frame callbacks: hidden or throttled views skip them). */
function watchRtcFrames() {
  const el = els.video;
  if (!el) return;
  const show = () => {
    if (rtc.showing || !el.srcObject) return;
    rtc.showing = true;
    ui.set({ hasFrame: true });
    syncDirect();
  };
  if (el.readyState >= 2) show();
  else el.addEventListener('loadeddata', show, { once: true });
}

/**
 * The direct path's frame rate and round trip, from the browser's own statistics. After a few seconds
 * it's compared with the WebSocket's: WebRTC's receive pipeline costs ~15 ms more than drawing decoded
 * frames on the canvas, so the direct path stays only if it saves more than that (the tunnel's detour).
 */
function pollRtcStats(pc: RTCPeerConnection) {
  clearInterval(rtc.statsTimer);
  const samples: number[] = [];
  let decided = false;
  rtc.statsTimer = window.setInterval(async () => {
    if (rtc.pc !== pc) return;
    try {
      const report = await pc.getStats();
      let selected: string | null = null;
      report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) selected = s.selectedCandidatePairId; });
      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.id === selected && s.currentRoundTripTime != null) {
          const rtt = Math.round(s.currentRoundTripTime * 1000);
          samples.push(rtt);
          patchVideo({ rtt });
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video' && rtc.showing) patchVideo({ fps: Math.round(s.framesPerSecond || 0) });
      });
      const wsRtt = ui.get().wsRtt;
      if (!decided && samples.length >= 4 && wsRtt != null && !rtc.forced) {
        decided = true;
        const direct = Math.min(...samples);
        if (wsRtt - direct < RTC_MIN_GAIN_MS) {
          stopRtc(true);
          // Don't try again on this page.
          patchDirect({ declined: true, reason: `el túnel ya es igual de rápido (${wsRtt} ms frente a ${direct} ms)` });
        }
      }
    } catch { /* closed */ }
  }, 1000);
}

function onRtcMessage(msg: any) {
  if (msg.op === 'offer') onRtcOffer(msg.sdp);
  else if (msg.op === 'unavailable') { rtc.pc = null; syncDirect(); }
  else if (msg.op === 'state' && (msg.state === 'failed' || msg.state === 'closed')) stopRtc(false);
}

export function setDirect(enabled: boolean) {
  saved.set('ulm-direct', enabled ? '1' : '0');
  patchDirect({ enabled, declined: false, reason: '' });
  if (enabled) startRtc(); else stopRtc(true);
}

// ---------- conexión ----------
export function connect() {
  const code = ui.get().code;
  if (!code) {
    setMsg('Escribe el código de la sala o abre el enlace que te pasaron.', 'warn');
    ui.set({ placeholder: 'Falta el código de la sala.' });
    return;
  }
  closeSocket();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ui.set({ blocked: null });
  let url = `${proto}//${location.host}/ws?code=${encodeURIComponent(code)}&name=${encodeURIComponent(saved.get('ulm-name'))}`;
  if (state.password) url += `&pw=${encodeURIComponent(state.password)}`;
  setConn('conectando…', 'warn');
  setMsg('');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.addEventListener('open', () => {
    ui.set({ connected: true, placeholder: 'Esperando el vídeo del anfitrión…' });
    state.retry = 0;
    setConn('conectado', 'ok');
    state.pingAt = Date.now();
    ws.send(JSON.stringify({ t: 'ping', id: state.pingAt }));
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') { onBinary(ev.data); return; }
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'welcome':
      case 'assigned': {
        setSeat(Number.isInteger(msg.seat) ? msg.seat : null);
        applySeats(msg);
        const seat = ui.get().seat;
        setMsg(seat ? `Juegas en el puesto ${seat}.` : 'Estás mirando: elige un puesto libre para jugar.', seat ? 'ok' : 'warn');
        // A new connection starts without sound on the host's side: ask again if it was playing.
        if (msg.t === 'welcome' && ui.get().sound.on && sound.ctx && sound.ctx.state === 'running') send({ t: 'audio', on: true });
        if (msg.t === 'assigned' && seat) {
          toast(benched(seat) ? `Tomaste el puesto ${seat}: entras en la próxima partida` : `Ahora juegas con ${characterOf(seat).name}`);
        }
        startStream().then(startRtc);
        break;
      }
      case 'seats': applySeats(msg); break;
      case 'released':
        setSeat(null);
        applySeats(msg);
        setMsg('Soltaste el puesto: sigues mirando.', 'warn');
        break;
      case 'pong': ui.set({ wsRtt: Date.now() - msg.id }); break;
      case 'vstat':
        if (msg.transport !== 'rtc') patchVideo({ rtt: msg.rtt }); // on a direct connection the page measures it (getStats)
        patchVideo({ tier: msg.tier });
        setVideoWait(msg.wait);
        // No frame for a while (game closed, network): the reading drops to 0 instead of keeping the last one.
        if (!rtc.showing && ui.get().video.fps && performance.now() - video.lastShownAt > 1500) patchVideo({ fps: 0 });
        break;
      case 'vtier':
        // The next keyframe comes from another encoding (another quality, or someone else's screen).
        resetDecoder();
        video.crop = Array.isArray(msg.crop) ? msg.crop : null;
        patchVideo({ tier: msg.tier, player: msg.player || null, crop: video.crop });
        break;
      case 'rtc': onRtcMessage(msg); break;
      case 'claim-result':
        if (!msg.ok) { setMsg(msg.message || 'No hay un puesto libre.', 'warn'); toast(msg.message || 'No hay un puesto libre'); }
        break;
      case 'notice': toast(msg.message); setMsg(msg.message, 'warn'); break;
      case 'audio': if (!msg.available) ui.set((s) => ({ sound: { ...s.sound, available: false } })); break;
      case 'chat-history': ui.set({ chat: (msg.messages || []).map(chatLine) }); break;
      case 'chat': ui.set((s) => ({ chat: [...s.chat, chatLine(msg)].slice(-60) })); break;
      case 'emote': floatEmote(msg); break;
      case 'kicked': turnedAway('kicked', msg.message || 'El anfitrión te sacó de la sala.'); break;
      case 'error':
        if (msg.code === 'password') { turnedAway('password', msg.message); break; }
        if (msg.code === 'kicked') { turnedAway('kicked', msg.message); break; }
        setMsg(msg.message, 'bad');
        setConn(msg.message, 'bad');
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (state.ws !== ws) return; // replaced by a new connection, which owns the state now
    const wasConnected = ui.get().connected;
    ui.set({ connected: false, wsRtt: null });
    state.streamOn = false;
    resetDecoder();
    stopRtc(false); // the host dropped its side with the WebSocket
    setSeat(null, true);
    setVideoWait(null);
    patchVideo({ fps: 0, rtt: null });
    if (ui.get().blocked) return; // turned away by the host: reconnecting would only bounce again
    setConn('desconectado', 'bad');
    // Reconnect by itself after a network blip (the room code still works while the host runs).
    const delay = Math.min(8000, 1000 * 2 ** state.retry++);
    ui.set({ placeholder: wasConnected ? 'Se cortó la conexión. Reconectando…' : 'No se pudo conectar. Reintentando…' });
    setTimeout(() => { if (state.ws === ws) connect(); }, delay);
  });

  ws.addEventListener('error', () => setConn('error de conexión', 'bad'));
}

/** The host said no: a password is needed (or was wrong), or we were kicked out. */
function turnedAway(reason: 'password' | 'kicked', message: string) {
  ui.set({ blocked: reason, placeholder: message });
  setConn(reason === 'password' ? 'falta la contraseña' : 'fuera de la sala', 'bad');
  setMsg(message, 'bad');
  if (reason === 'password') {
    ui.set({ gate: { open: true, message: state.password ? 'Esa contraseña no es. Prueba otra vez.' : 'El anfitrión puso una contraseña para entrar.' } });
  } else {
    toast(message);
  }
}

export function submitPassword(pw: string) {
  if (!pw) return;
  state.password = pw;
  session.set(`ulm-pw-${ui.get().code}`, pw);
  ui.set({ gate: { open: false, message: '' } });
  connect();
}

function closeSocket() {
  const ws = state.ws;
  state.ws = null;
  if (ws) { try { ws.close(); } catch { /* ya cerrado */ } }
  ui.set({ connected: false });
}

const VIDEO_WAIT: Record<string, string> = {
  window: 'El juego del anfitrión se está abriendo o se cerró: el vídeo vuelve solo.',
  encoder: 'El anfitrión está preparando el vídeo…',
};

function setVideoWait(reason: unknown) {
  const text = typeof reason === 'string' ? VIDEO_WAIT[reason] ?? null : null;
  if (ui.get().videoWait !== text) ui.set({ videoWait: text });
}

function setSeat(seat: number | null, disconnected = false) {
  ui.set({ seat, role: disconnected ? null : seat ? 'player' : 'spectator' });
}

/** A seat past the running match's player count (the mod reports no character for it). */
export function benched(seatIndex: number, s: UiState = ui.get()) {
  return Boolean(s.game.online && Array.isArray(s.game.characters) && s.game.characters[seatIndex - 1] === -1);
}

export function characterOf(seatIndex: number, s: UiState = ui.get()): Character {
  if (benched(seatIndex, s)) {
    const want = s.seats.find((x) => x.index === seatIndex)?.want;
    return want && CHARACTER_IDS[want] !== undefined ? CHARACTERS[CHARACTER_IDS[want]] : { name: 'Sin personaje', color: '#62666d', short: String(seatIndex) };
  }
  const list = s.game.online && Array.isArray(s.game.characters) ? s.game.characters : DEFAULT_CAST;
  return CHARACTERS[list[seatIndex - 1]] || { name: `Jugador ${seatIndex}`, color: '#5e6ad2', short: String(seatIndex) };
}

function applySeats(msg: any) {
  const before = new Map(ui.get().seats.map((s) => [s.index, s]));
  const patch: Partial<UiState> = {};
  if (Array.isArray(msg.seats)) patch.seats = msg.seats;
  if (Number.isInteger(msg.spectators)) patch.spectators = msg.spectators;
  if (msg.game) patch.game = msg.game;
  if (msg.options?.characters) patch.characters = msg.options.characters;
  ui.set(patch);
  if (msg.features) {
    const s = ui.get();
    if (Boolean(msg.features.audio) !== s.sound.available) ui.set({ sound: { ...s.sound, available: Boolean(msg.features.audio) } });
    if (Boolean(msg.features.rtc) !== s.direct.available) {
      patchDirect({ available: Boolean(msg.features.rtc) });
      if (msg.features.rtc && state.streamOn) startRtc();
    }
  }
  // Who came and went (not for our own seat).
  const s = ui.get();
  for (const seat of s.seats) {
    const old = before.get(seat.index);
    if (!old || seat.index === s.seat) continue;
    if (!old.occupied && seat.occupied) toast(`${seat.name || 'Alguien'} juega con ${characterOf(seat.index).name}`);
    if (old.occupied && !seat.occupied) toast(`${old.name || 'Alguien'} dejó a ${characterOf(seat.index).name}`);
  }
}

export function send(obj: unknown) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

export function claimSeat(index?: number) {
  if (index === undefined) { if (ui.get().role === 'spectator') send({ t: 'claim' }); return; }
  if (ui.get().seat) send({ t: 'release' }); // switching characters: let go of the current one first
  send({ t: 'claim', seat: index });
}

export function release() { send({ t: 'release' }); }

export function joinRoom(raw: string) {
  const code = raw.trim().toUpperCase();
  if (!code) return;
  state.password = session.get(`ulm-pw-${code}`);
  ui.set({ code });
  history.replaceState(null, '', `?code=${code}`);
  state.lastSent = '';
  connect();
}

export function saveName(raw: string) {
  const name = raw.trim().slice(0, 24);
  saved.set('ulm-name', name);
  ui.set({ name });
  if (name) { send({ t: 'name', name }); toast(`Ahora eres ${name}`); }
}

export function setWant(character: string) {
  send({ t: 'want', character: character || null });
  const name = characterName(character);
  toast(name ? `Pediste ser ${name} en la próxima partida` : 'Te da igual el personaje');
}

export async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareLink());
    toast('Enlace copiado: pásalo a tus amigos');
  } catch {
    toast(shareLink());
  }
}

// ---------- chat y emotes ----------
function chatLine(m: any): ChatLine {
  return { id: ++ids, name: m.name || 'alguien', seat: m.seat ?? null, text: String(m.text ?? '') };
}

/** An emote rises over the video, above the sender's seat (spectators: somewhere in the middle). */
function floatEmote(m: any) {
  const emote: FloatingEmote = {
    id: ++ids, e: m.e, name: m.name || '', seat: m.seat ?? null,
    left: m.seat ? 14 + (m.seat - 1) * 24 : 40 + Math.random() * 20,
  };
  ui.set((s) => ({ emotes: [...s.emotes, emote] }));
  setTimeout(() => ui.set((s) => ({ emotes: s.emotes.filter((x) => x.id !== emote.id) })), 2500);
}

export function sendChat(text: string) {
  const body = text.trim();
  if (body) send({ t: 'chat', text: body });
}

export function sendEmote(e: string) { send({ t: 'emote', e }); }

// ---------- medir el retraso ----------
// The whole trip, as a player feels it: the page presses A (jump), the host's game reacts, the picture
// comes back. Each drawn frame is shrunk to 64x48 and compared with the previous one; first the picture
// is watched still for a moment (water, idle animations move it a bit), then the press, and the first
// frame that changes clearly more than that counts as the answer. Five jumps, the median is shown.
const probe = {
  busy: false, press: false, onFrame: null as null | ((now: number) => void),
  canvas: null as HTMLCanvasElement | null, ctx: null as CanvasRenderingContext2D | null, prev: null as Uint8ClampedArray | null,
};

function frameChange(source: CanvasImageSource | null = rtc.showing ? els.video : els.canvas) {
  if (!probe.canvas) {
    probe.canvas = document.createElement('canvas');
    probe.canvas.width = 64;
    probe.canvas.height = 48;
    probe.ctx = probe.canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!source || !probe.ctx) return 0;
  probe.ctx.drawImage(source, 0, 0, 64, 48);
  const px = probe.ctx.getImageData(0, 0, 64, 48).data;
  let d = 0;
  const prev = probe.prev;
  if (prev) for (let i = 0; i < px.length; i += 4) d += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]) + Math.abs(px[i + 2] - prev[i + 2]);
  probe.prev = px;
  return d / (64 * 48);
}

function watchFrames(ms: number, until: (change: number) => boolean = () => false) {
  return new Promise<{ changes: number[]; at: number | null }>((resolve) => {
    const changes: number[] = [];
    let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
    let copy: MediaStreamTrack | null = null;
    let poll = 0;
    const finish = (at: number | null) => {
      clearTimeout(timer);
      clearInterval(poll);
      probe.onFrame = null;
      reader?.cancel().catch(() => {});
      copy?.stop();
      resolve({ changes, at });
    };
    const timer = setTimeout(() => finish(null), ms);
    const look = (now: number, source?: CanvasImageSource) => {
      const c = frameChange(source);
      if (rtc.showing && c === 0 && changes.length) return; // same picture as the last sample
      changes.push(c);
      if (until(c)) finish(now);
    };
    // The canvas reports each frame it draws. The direct video's frames are read off its track as they
    // are decoded (Chromium), or sampled every 4 ms: what the element shows depends on page rendering.
    probe.onFrame = (now) => look(now);
    const track = rtc.showing ? (els.video?.srcObject as MediaStream | null)?.getVideoTracks()[0] : null;
    const Processor = (window as any).MediaStreamTrackProcessor;
    if (track && Processor) {
      probe.onFrame = null;
      copy = track.clone();
      reader = new Processor({ track: copy }).readable.getReader();
      (async () => {
        for (;;) {
          const { value: frame, done } = await reader!.read().catch(() => ({ value: undefined, done: true }));
          if (done || !frame) return;
          look(performance.now(), frame);
          frame.close();
        }
      })();
    } else if (rtc.showing) {
      poll = window.setInterval(() => probe.onFrame?.(performance.now()), 4);
    }
  });
}

export async function measureLatency() {
  const s = ui.get();
  if (!s.seat) { toast('Toma un puesto para medir el retraso'); return; }
  if (benched(s.seat)) { toast('Tu puesto no juega en esta partida'); return; }
  if (probe.busy || !s.hasFrame) return;
  probe.busy = true;
  const results: number[] = [];
  try {
    for (let trial = 1; trial <= 5; trial++) {
      ui.set({ latency: { busy: true, text: `midiendo… ${trial}/5 (no toques el mando)` } });
      probe.prev = null;
      const still = (await watchFrames(700)).changes.slice(1).sort((a, b) => a - b);
      const noise = still.length ? still[Math.floor(still.length * 0.9)] : 0;
      const pressedAt = performance.now();
      probe.press = true;
      flush();
      setTimeout(() => { probe.press = false; flush(); }, 150);
      const seen = await watchFrames(1500, (c) => c > noise * 2 + 3);
      if (seen.at) results.push(seen.at - pressedAt);
      await sleep(1100); // let the character land
    }
  } finally {
    probe.busy = false;
    probe.press = false;
  }
  if (!results.length) { ui.set({ latency: { busy: false, text: 'no vi cambiar la imagen: prueba con «Ver: mi pantalla»' } }); return; }
  results.sort((a, b) => a - b);
  const median = Math.round(results[results.length >> 1]);
  ui.set({ latency: { busy: false, text: `≈ ${median} ms del botón a la imagen (${results.length} saltos: ${results.map(Math.round).join(', ')})` } });
}

// ---------- entrada: mando, teclado, táctil ----------
function gamepadPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    const pad = emptyPad();
    const map: Record<string, number> = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
    for (const [name, idx] of Object.entries(map)) {
      const btn = gp.buttons[idx];
      if (btn) pad.b[name as Button] = btn.pressed || btn.value > 0.5;
    }
    const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : Math.round(v * 1000) / 1000);
    pad.a.lx = dz(gp.axes[0] || 0);
    pad.a.ly = dz(gp.axes[1] || 0);
    pad.a.rx = dz(gp.axes[2] || 0);
    pad.a.ry = dz(gp.axes[3] || 0);
    return { pad, source: `mando: ${gp.id.slice(0, 32)}` };
  }
  return null;
}

function keyboardPad() {
  const k = state.keys;
  const pad = emptyPad();
  const map: Record<string, Button> = { j: 'a', ' ': 'a', k: 'b', u: 'x', i: 'y', Enter: 'start', q: 'lb', e: 'rb', Shift: 'lt', o: 'rt' };
  for (const [key, btn] of Object.entries(map)) if (k.has(key.toLowerCase()) || k.has(key)) pad.b[btn] = true;
  pad.a.lx = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
  pad.a.ly = (k.has('s') ? 1 : 0) - (k.has('w') ? 1 : 0);
  pad.a.rx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
  pad.a.ry = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
  return pad;
}

function touchPad() {
  const pad = emptyPad();
  for (const name of BUTTONS) pad.b[name] = state.touchButtons.has(name);
  pad.a.lx = state.touchAxes.lx;
  pad.a.ly = state.touchAxes.ly;
  return pad;
}

function activePad() {
  const gp = gamepadPad();
  const kb = keyboardPad();
  const tb = touchPad();
  const pad = emptyPad();
  for (const n of BUTTONS) pad.b[n] = Boolean(gp?.pad.b[n] || kb.b[n] || tb.b[n]);
  if (probe.press) pad.b.a = true; // the latency test's jump
  for (const n of AXES) pad.a[n] = Math.max(-1, Math.min(1, (gp?.pad.a[n] || 0) + kb.a[n] + tb.a[n]));
  const anyKb = BUTTONS.some((n) => kb.b[n]) || AXES.some((n) => kb.a[n] !== 0);
  const anyTouch = BUTTONS.some((n) => tb.b[n]) || state.touchAxes.lx || state.touchAxes.ly;
  const anyGamepad = gp && (BUTTONS.some((n) => gp.pad.b[n]) || AXES.some((n) => gp.pad.a[n] !== 0));
  const sources: string[] = [];
  if (anyKb) sources.push('teclado');
  if (anyTouch) sources.push('táctil');
  if (anyGamepad && gp) sources.push(gp.source);
  return { pad, source: sources.join(' + ') || 'reposo' };
}

function sendIfChanged(pad: Pad, force = false) {
  const s = ui.get();
  if (!s.connected || s.seat === null || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const signature = JSON.stringify(pad);
  if (!force && signature === state.lastSent) return;
  // `n` lets the host drop a state that arrives after a newer one (the direct channel doesn't keep order).
  const message = JSON.stringify({ t: 'pad', n: ++state.padSeq, b: pad.b, a: pad.a });
  if (rtc.channel && rtc.channel.readyState === 'open') rtc.channel.send(message);
  else state.ws.send(message);
  state.lastSent = signature;
  state.lastPadSentAt = Date.now();
}

// Discrete events (key, button, stick) go out at once: waiting for the 33 ms
// sampling added delay and swallowed short presses.
function flush() { sendIfChanged(activePad().pad); }

let lastPadView = '';
function tick() {
  const { pad, source } = activePad();
  const s = ui.get();
  const spectator = s.role === 'spectator';
  const now = Date.now();
  sendIfChanged(pad);
  if (s.connected && state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Controller keepalive: lets the mod clear a stuck button if the release message is lost.
    if (now - state.lastPadSentAt >= 250) sendIfChanged(pad, true);
    if (now - state.pingAt > 2000) {
      state.pingAt = now;
      state.ws.send(JSON.stringify({ t: 'ping', id: now }));
    }
  }
  const shown = spectator ? emptyPad() : pad;
  const held = BUTTONS.filter((n) => pad.b[n]);
  const ax = AXES.filter((n) => Math.abs(pad.a[n]) > 0.02).map((n) => `${n}=${pad.a[n].toFixed(2)}`);
  const next = {
    source: spectator ? 'espectador' : source,
    info: spectator ? 'solo observas' : ([...held, ...ax].join(' ') || 'reposo'),
    b: { ...shown.b }, lx: shown.a.lx, ly: shown.a.ly,
  };
  const key = JSON.stringify(next);
  if (key !== lastPadView) { lastPadView = key; ui.set({ pad: next }); }
}
setInterval(tick, 33);

export function touchStick(lx: number, ly: number) {
  state.touchAxes.lx = lx;
  state.touchAxes.ly = ly;
  flush();
}

export function touchButton(name: string, down: boolean) {
  if (down) state.touchButtons.add(name); else state.touchButtons.delete(name);
  flush();
}

// ---------- teclado ----------
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else els.stage?.requestFullscreen?.().catch(() => {});
}

/** For the page's dropdowns: closing one doesn't put the focus back on its button, where Space and the arrows
 * would open it again instead of reaching the game. */
export const keepGameKeys = (e: Event) => e.preventDefault();

const typing = (e: KeyboardEvent) => {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement
    || Boolean(t.closest('[role="listbox"],[role="dialog"],[role="alertdialog"]'));
};
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.key === 'f' || e.key === 'F') { if (!e.repeat) toggleFullscreen(); return; }
  if ((e.key === 'm' || e.key === 'M') && ui.get().sound.available) { if (!e.repeat) setSound(!ui.get().sound.on); return; }
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); state.keys.clear(); flush(); hooks.focusChat(); return; }
  if (e.key === 'v' || e.key === 'V') {
    // Cycle: my screen -> the whole game -> each player's.
    if (!e.repeat) {
      const values = VIEWS.map(([v]) => v as string);
      const next = values[(values.indexOf(ui.get().view) + 1) % values.length];
      setView(next);
      toast(`Ver: ${VIEWS.find(([v]) => v === next)?.[1]}`);
    }
    return;
  }
  state.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
  flush();
});
window.addEventListener('keyup', (e) => {
  state.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  flush();
});
window.addEventListener('blur', () => { state.keys.clear(); flush(); });
window.addEventListener('gamepadconnected', (e) => toast(`Mando conectado: ${e.gamepad.id.slice(0, 40)}`));
