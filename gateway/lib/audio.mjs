// The game's sound for the browser.
//
// The mod copies SADX's final sound mix out of the game (source/audio_tap.cpp:
// Windows' per-process loopback capture only hears silence from it) and sends it
// over local UDP while this asks for it: {"cmd":"audio"} to the mod's browser
// input port, repeated every 2 s while anyone listens. Each datagram is a 16-byte
// header ("SAUD", sequence, rate, channels, bits, float) and raw samples, which
// go into ffmpeg: Opus in 20 ms frames for low delay, written as Ogg with one
// page per packet (the muxer's default would hold a second per page). The pages
// are split back into Opus packets here, and each one goes to the viewers who
// turned sound on, over the same WebSocket as the video:
// [3][0][0][0][sequence u32 LE][Opus packet]. The page decodes them with
// WebCodecs and plays them as they come; it doesn't acknowledge them (audio is
// ~100 kbps, so a viewer whose socket is backed up just misses some).
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveFfmpeg } from './video.mjs';

export const AUDIO_OPUS = 3;
const MAX_BUFFERED = 512 << 10; // a viewer with more than this unsent skips packets
const REQUEST_EVERY_MS = 2000;  // the mod streams for 5 s after each request

/** Splits an Ogg stream into its packets (RFC 3533: pages of lacing segments; a 255 segment continues). */
export class OggPackets {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.partial = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 27) return;
      if (this.buf.readUInt32BE(0) !== 0x4f676753) { // 'OggS': lost sync, look for the next page
        const next = this.buf.indexOf('OggS', 1);
        this.buf = next < 0 ? Buffer.alloc(0) : this.buf.subarray(next);
        this.partial = [];
        continue;
      }
      const segments = this.buf[26];
      const headerLength = 27 + segments;
      if (this.buf.length < headerLength) return;
      let bodyLength = 0;
      for (let i = 0; i < segments; i++) bodyLength += this.buf[27 + i];
      if (this.buf.length < headerLength + bodyLength) return;
      let offset = headerLength;
      for (let i = 0; i < segments; i++) {
        const size = this.buf[27 + i];
        this.partial.push(this.buf.subarray(offset, offset + size));
        offset += size;
        if (size < 255) {
          const packet = Buffer.concat(this.partial);
          this.partial = [];
          this.onPacket(packet);
        }
      }
      this.buf = this.buf.subarray(headerLength + bodyLength);
    }
  }
}

/** ffmpeg's name for the raw sample format the mod reports. */
function sampleFormat(bits, isFloat) {
  if (isFloat && bits === 32) return 'f32le';
  if (!isFloat && bits === 16) return 's16le';
  if (!isFloat && bits === 24) return 's24le';
  if (!isFloat && bits === 32) return 's32le';
  return null;
}

export class GameAudio extends EventEmitter {
  constructor({ ffmpeg = 'ffmpeg', modPort = 27016, bitrate = 96, log = console.log }) {
    super();
    this.ffmpeg = resolveFfmpeg(ffmpeg);
    this.modPort = modPort;
    this.bitrate = bitrate;
    this.log = log;
    this.listeners = new Map(); // conn -> sequence
    this.socket = null;
    this.bound = false;
    this.requestTimer = null;
    this.encoder = null;
    this.format = null; // "rate/channels/bits/float" of the running encoder
    this.stopped = false;
    this.datagrams = 0;
    this.packets = 0;
    this.lastSampleAt = 0;
    this.lastPacketAt = 0;
    this.lastError = null;
  }

  get running() {
    return this.encoder !== null;
  }

  subscribe(conn) {
    if (!this.listeners.has(conn)) this.listeners.set(conn, 0);
    this._ask();
  }

  unsubscribe(conn) {
    this.listeners.delete(conn);
    if (!this.listeners.size) this._quiet();
  }

  /** Opens the socket the mod streams to and keeps asking for sound while someone listens. */
  _ask() {
    if (this.stopped) return;
    if (!this.socket) {
      const socket = dgram.createSocket('udp4');
      socket.on('message', (msg) => this._onDatagram(msg));
      socket.on('error', (err) => { this.lastError = err.message; });
      socket.once('listening', () => { this.bound = true; this._request(); });
      socket.bind(0, '127.0.0.1');
      this.socket = socket;
    }
    if (!this.requestTimer) {
      this.requestTimer = setInterval(() => this._request(), REQUEST_EVERY_MS);
      this._request();
    }
  }

  _request() {
    if (!this.listeners.size) { this._quiet(); return; }
    if (this.bound) this.socket.send('{"cmd":"audio","on":true}', this.modPort, '127.0.0.1', () => {});
  }

  /** Nobody listens: tell the mod to stop and let the encoder go. */
  _quiet() {
    if (this.requestTimer) { clearInterval(this.requestTimer); this.requestTimer = null; }
    if (this.socket && this.bound) {
      try { this.socket.send('{"cmd":"audio","on":false}', this.modPort, '127.0.0.1', () => {}); } catch { /* cerrado */ }
    }
    this._stopEncoder();
  }

  _onDatagram(msg) {
    if (msg.length <= 16 || msg.toString('latin1', 0, 4) !== 'SAUD' || !this.listeners.size) return;
    const rate = msg.readUInt32LE(8);
    const channels = msg[12];
    const bits = msg[13];
    const isFloat = msg[14] === 1;
    const format = `${rate}/${channels}/${bits}/${isFloat ? 'f' : 'i'}`;
    if (format !== this.format) {
      const name = sampleFormat(bits, isFloat);
      if (!name || !rate || !channels) { this.lastError = `formato de sonido desconocido: ${format}`; return; }
      this._stopEncoder();
      this._startEncoder(name, rate, channels);
      this.format = format;
      this.log(`[audio] sonido del juego: ${rate} Hz, ${channels} canales, ${bits} bits${isFloat ? ' float' : ''}`);
    }
    this.datagrams += 1;
    this.lastSampleAt = Date.now();
    if (this.encoder && this.encoder.stdin.writable) this.encoder.stdin.write(msg.subarray(16));
  }

  _startEncoder(sampleFmt, rate, channels) {
    const encoder = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer',
      '-f', sampleFmt, '-ar', String(rate), '-ac', String(channels), '-i', 'pipe:0',
      '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', `${this.bitrate}k`, '-application', 'lowdelay', '-frame_duration', '20',
      '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1', // 0 means "default" (1 s): 20 ms = a page per packet
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.encoder = encoder;
    encoder.stdin.on('error', () => {});
    encoder.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) { this.lastError = text.split('\n').slice(-1)[0]; this.log(`[audio] ffmpeg: ${this.lastError}`); }
    });
    const ogg = new OggPackets((packet) => this._onPacket(packet));
    encoder.stdout.on('data', (chunk) => ogg.push(chunk));
    const ended = () => {
      if (this.encoder !== encoder) return;
      this.encoder = null;
      this.format = null; // the next datagram starts a new one
    };
    encoder.on('exit', ended);
    encoder.on('error', (err) => { this.lastError = err.message; ended(); });
  }

  _stopEncoder() {
    const encoder = this.encoder;
    this.encoder = null;
    this.format = null;
    if (encoder) { try { encoder.stdin.end(); encoder.kill(); } catch { /* ya terminó */ } }
  }

  _onPacket(packet) {
    // The stream starts with two header packets the page doesn't need.
    const head = packet.toString('latin1', 0, 8);
    if (head === 'OpusHead' || head === 'OpusTags') return;
    this.packets += 1;
    this.lastPacketAt = Date.now();
    for (const [conn, seq] of this.listeners) {
      if (conn.closed) { this.listeners.delete(conn); continue; }
      if (conn.buffered > MAX_BUFFERED) continue;
      const header = Buffer.alloc(8);
      header[0] = AUDIO_OPUS;
      header.writeUInt32LE((seq + 1) >>> 0, 4);
      this.listeners.set(conn, seq + 1);
      conn.sendBinary(Buffer.concat([header, packet]));
    }
  }

  status() {
    return {
      running: this.running,
      format: this.format,
      bitrateKbps: this.bitrate,
      listeners: this.listeners.size,
      datagrams: this.datagrams,
      packets: this.packets,
      lastSampleAt: this.lastSampleAt || null,
      lastPacketAt: this.lastPacketAt || null,
      lastError: this.lastError,
    };
  }

  stop() {
    this.stopped = true;
    this._quiet();
    this.listeners.clear();
    if (this.socket) { try { this.socket.close(); } catch { /* cerrado */ } this.socket = null; this.bound = false; }
  }
}
