// Destinos del estado de mando. El backend es la costura entre esta puerta y el
// juego: es lo único que hay que cambiar para pasar de "solo registrar" a mover
// un mando de verdad.
//
// Backends disponibles:
//   log  - registra los mandos en consola. Sirve para probar la cadena completa
//          (navegador -> gateway -> destino) sin tocar el juego.
//   udp  - manda una línea JSON por puesto a 127.0.0.1:<puerto>. Es el contrato
//          que puede consumir un puente de mandos virtuales o una lectura dentro
//          del mod.
//
// `vigem` (mandos virtuales con ViGEmBus) no está implementado: el driver no
// está instalado en esta máquina y requiere instalación con permisos de
// administrador. Ver README.md, sección "Mover el juego de verdad".
import dgram from 'node:dgram';
import crypto from 'node:crypto';

export const PAD_BUTTONS = [
  'a', 'b', 'x', 'y',
  'up', 'down', 'left', 'right',
  'lb', 'rb', 'lt', 'rt',
  'start', 'back',
];

const AXES = ['lx', 'ly', 'rx', 'ry'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, Math.round(v * 1000) / 1000)) : 0);

/** Sanea lo que llega del navegador: solo botones conocidos y ejes en [-1,1]. */
export function normalizePad(raw) {
  const srcB = (raw && typeof raw.b === 'object' && raw.b) || {};
  const srcA = (raw && typeof raw.a === 'object' && raw.a) || {};
  const b = {};
  for (const name of PAD_BUTTONS) b[name] = srcB[name] === true;
  const a = {};
  for (const name of AXES) a[name] = num(srcA[name]);
  return { b, a };
}

export function padIsIdle(pad) {
  return PAD_BUTTONS.every((n) => pad.b[n] === false) && AXES.every((n) => Math.abs(pad.a[n]) < 0.02);
}

function describe(pad) {
  const held = PAD_BUTTONS.filter((n) => pad.b[n]);
  const axes = AXES.filter((n) => Math.abs(pad.a[n]) >= 0.02).map((n) => `${n}=${pad.a[n].toFixed(2)}`);
  return [...held, ...axes].join(' ') || 'reposo';
}

class LogBackend {
  constructor({ log = console.log } = {}) {
    this.name = 'log';
    this.log = log;
    this.counts = new Map();
    this.lastPrint = new Map();
    this.totalMessages = 0;
  }

  apply(seatIndex, pad) {
    this.totalMessages += 1;
    this.counts.set(seatIndex, (this.counts.get(seatIndex) || 0) + 1);
    const now = Date.now();
    const last = this.lastPrint.get(seatIndex) || 0;
    // 4 Hz por puesto: suficiente para ver que llega sin inundar la consola.
    if (now - last < 250) return;
    this.lastPrint.set(seatIndex, now);
    this.log(`[puesto ${seatIndex}] ${describe(pad)}`);
  }

  release(_seatIndex) {}

  status() {
    return {
      backend: this.name,
      totalMessages: this.totalMessages,
      perSeat: Object.fromEntries([...this.counts].sort((a, b) => a[0] - b[0])),
    };
  }
}

class UdpBackend {
  constructor({ port = 27016, host = '127.0.0.1', log = console.log } = {}) {
    this.name = 'udp';
    this.port = port;
    this.host = host;
    this.log = log;
    this.totalMessages = 0;
    this.errors = 0;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      this.errors += 1;
      this.log(`[udp] error: ${err.message}`);
    });
    // The mod answers status requests to the address they came from: this socket.
    this.pending = new Map();
    this.socket.on('message', (data) => {
      try {
        const reply = JSON.parse(data.toString('utf8'));
        const done = this.pending.get(reply.id);
        if (done) done(reply);
      } catch { /* not a status reply */ }
    });
  }

  /** The mod's status (level, characters per seat), or null when SADX doesn't answer. */
  query(timeoutMs = 800) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (reply) => { clearTimeout(timer); this.pending.delete(id); resolve(reply); });
      this.socket.send(Buffer.from(JSON.stringify({ cmd: 'status', id }), 'utf8'), this.port, this.host, (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
      });
    });
  }

  apply(seatIndex, pad) {
    this.totalMessages += 1;
    const line = `${JSON.stringify({ seat: seatIndex, t: Date.now(), b: pad.b, a: pad.a })}\n`;
    this.socket.send(Buffer.from(line, 'utf8'), this.port, this.host, (err) => {
      if (err) this.errors += 1;
    });
  }

  release(seatIndex) {
    const line = `${JSON.stringify({ seat: seatIndex, t: Date.now(), release: true })}\n`;
    this.socket.send(Buffer.from(line, 'utf8'), this.port, this.host, () => {});
  }

  status() {
    return { backend: this.name, host: this.host, port: this.port, totalMessages: this.totalMessages, errors: this.errors };
  }
}

export function createBackend(name, opts = {}) {
  switch (name) {
    case 'log':
      return new LogBackend(opts);
    case 'udp':
      return new UdpBackend(opts);
    case 'vigem':
      throw new Error(
        'backend "vigem" no implementado: ViGEmBus no está instalado en esta máquina. ' +
          'Usa --backend log o --backend udp (ver gateway/README.md).',
      );
    default:
      throw new Error(`backend desconocido: ${name} (usa log, udp o vigem)`);
  }
}
