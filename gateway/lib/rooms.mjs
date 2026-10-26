// Salas y puestos. Un puesto = un mando asignado dentro del juego.
// El mod de SADX reparte hasta PLAYER_MAX puestos locales (4); la sala espeja esa
// capacidad para que el anfitrión sepa qué navegador ocupa cada mando.
export const SEAT_MAX = 4;

// Player 1 is whoever sits at the host PC (its keyboard and controllers drive it in the game): no browser
// can take that seat, so the host always has a character.
export const HOST_SEAT = 1;
export const HOST_NAME = 'Anfitrión';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I/O/0/1

export function makeRoomCode(length = 5) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export class Room {
  constructor(code, seatCount = SEAT_MAX) {
    this.code = code;
    this.createdAt = Date.now();
    this.seats = Array.from({ length: seatCount }, (_, i) => ({
      index: i + 1,
      host: i + 1 === HOST_SEAT,
      clientId: null,
      name: null,
      since: null,
      pad: null,
      lastPadAt: 0,
      want: null, // character picked in the lobby, applied on the next game restart
    }));
  }

  /** Whether a browser can sit in seat `index` (1-based) right now. */
  isFree(index) {
    const seat = this.seats[index - 1];
    return Boolean(seat && !seat.host && seat.clientId === null);
  }

  /** Takes seat `wanted` (1-based) if it's free, or the first free seat when `wanted` is 0. */
  claim(clientId, name = null, wanted = 0) {
    const seat = wanted
      ? (this.isFree(wanted) ? this.seats[wanted - 1] : null)
      : this.seats.find((s) => this.isFree(s.index));
    if (!seat) return null;
    seat.clientId = clientId;
    seat.name = name || `invitado-${seat.index}`;
    seat.since = Date.now();
    seat.pad = null;
    seat.lastPadAt = 0;
    seat.want = null;
    return seat;
  }

  setWant(clientId, character) {
    const seat = this.seatOf(clientId);
    if (seat) seat.want = character;
    return seat;
  }

  rename(clientId, name) {
    const seat = this.seatOf(clientId);
    if (seat) seat.name = name;
    return seat;
  }

  seatOf(clientId) {
    return this.seats.find((s) => s.clientId === clientId) || null;
  }

  setPad(clientId, pad) {
    const seat = this.seatOf(clientId);
    if (!seat) return null;
    seat.pad = pad;
    seat.lastPadAt = Date.now();
    return seat;
  }

  free(clientId) {
    const seat = this.seatOf(clientId);
    if (!seat) return null;
    seat.clientId = null;
    seat.name = null;
    seat.since = null;
    seat.pad = null;
    seat.lastPadAt = 0;
    seat.want = null;
    return seat;
  }

  /** Marca como libres los puestos cuyo WebSocket ya no existe. */
  prunePresent(clientIds) {
    let changed = false;
    for (const seat of this.seats) {
      if (seat.clientId && !clientIds.has(seat.clientId)) {
        seat.clientId = null;
        seat.name = null;
        seat.since = null;
        seat.pad = null;
        seat.lastPadAt = 0;
        seat.want = null;
        changed = true;
      }
    }
    return changed;
  }

  snapshot() {
    return {
      code: this.code,
      seats: this.seats.map((s) => ({
        index: s.index,
        host: s.host,
        occupied: s.host || s.clientId !== null,
        name: s.host ? HOST_NAME : s.name,
        since: s.since,
        padAge: s.lastPadAt ? Date.now() - s.lastPadAt : null,
        want: s.want,
      })),
    };
  }
}
