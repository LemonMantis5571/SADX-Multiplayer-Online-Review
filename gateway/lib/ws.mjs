// Servidor WebSocket mínimo (RFC 6455), sin dependencias externas.
// Cubre lo que necesita esta puerta: handshake, texto, ping/pong, cierre y
// fragmentación básica. No implementa extensiones (permessage-deflate).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20; // 1 MiB: aquí solo viajan estados de mando
const MAX_BUFFER = 4 << 20;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

let nextId = 1;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export class WsConnection extends EventEmitter {
  constructor(socket, req, url) {
    super();
    this.id = `c${nextId++}`;
    this.socket = socket;
    this.req = req;
    this.url = url;
    this.remoteAddress = socket.remoteAddress || '?';
    this.closed = false;
    this.lastSeen = Date.now();
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOpcode = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
    socket.setNoDelay(true);
  }

  send(obj) {
    if (this.closed || !this.socket.writable) return false;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    try {
      return this.socket.write(frame(OP_TEXT, payload));
    } catch {
      this._teardown();
      return false;
    }
  }

  /** Sends a binary message (video). */
  sendBinary(payload) {
    if (this.closed || !this.socket.writable) return false;
    try {
      return this.socket.write(frame(OP_BIN, payload));
    } catch {
      this._teardown();
      return false;
    }
  }

  /** Bytes queued in the socket that the network hasn't taken yet: how far behind this viewer is. */
  get buffered() {
    return this.socket.writableLength || 0;
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this.socket.write(frame(OP_CLOSE, payload));
    } catch {
      /* el socket ya no acepta escrituras: da igual */
    }
    this._teardown();
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ya destruido */
    }
    this.emit('close');
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) {
      this.close(1009, 'buffer');
      return;
    }

    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;

      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        if (hi !== 0) {
          this.close(1009, 'frame too large');
          return;
        }
        len = b.readUInt32BE(6);
        off = 10;
      }

      if (len > MAX_FRAME) {
        this.close(1009, 'frame too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (b.length < off + 4) return;
        maskKey = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;

      let payload;
      if (masked) {
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) payload[i] = b[off + i] ^ maskKey[i & 3];
      } else {
        // Los clientes deben enmascarar; se acepta igualmente para ser tolerante.
        payload = Buffer.from(b.subarray(off, off + len));
      }

      this.buf = b.subarray(off + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      this._teardown();
      return;
    }
    if (opcode === OP_PING) {
      if (!this.closed && this.socket.writable) {
        try {
          this.socket.write(frame(OP_PONG, payload));
        } catch {
          this._teardown();
        }
      }
      return;
    }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CONT) {
      if (!this.frag) return; // continuación sin inicio: se ignora
      this.frag = Buffer.concat([this.frag, payload]);
      if (this.frag.length > MAX_FRAME) {
        this.close(1009, 'message too large');
        return;
      }
      if (!fin) return;
      const whole = this.frag;
      const wholeOpcode = this.fragOpcode;
      this.frag = null;
      this.fragOpcode = 0;
      this._deliver(wholeOpcode, whole);
      return;
    }

    if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (!fin) {
        this.frag = payload;
        this.fragOpcode = opcode;
        return;
      }
      this._deliver(opcode, payload);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) {
      let text;
      try {
        text = payload.toString('utf8');
      } catch {
        return;
      }
      this.emit('message', text);
    } else {
      this.emit('binary', payload);
    }
  }
}

export function attachWsServer(httpServer, { path: wsPath = '/ws', onConnection, onReject } = {}) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (wsPath && url.pathname !== wsPath) {
      onReject?.(req, socket, 'ruta desconocida');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      onReject?.(req, socket, 'handshake inválido');
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = new WsConnection(socket, req, url);
    if (head && head.length) conn._onData(head);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection?.(conn, req, url);
  });

  return {
    connections,
    broadcast(obj) {
      for (const c of connections) c.send(obj);
    },
    closeAll() {
      for (const c of connections) c.close(1001, 'servidor cerrando');
    },
  };
}
