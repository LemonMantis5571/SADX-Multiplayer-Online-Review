// The column next to the game: who plays, the next match's pick, chat, name, your controller, the keys,
// and the room (code, link, direct connection).
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { CHARACTER_IDS, EMOTES, characterName, isSoldier } from '@/lib/game';
import {
  benched, characterOf, claimSeat, hooks, joinRoom, keepGameKeys, measureLatency, saveName, sendChat, sendEmote, setDirect, setWant, ui,
} from './room';

export function Sidebar() {
  return (
    <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1 [&>*]:shrink-0">
      <SeatsCard />
      <NextMatchCard />
      <ChatCard />
      <NameCard />
      <PadCard />
      <KeysCard />
      <RoomCard />
    </aside>
  );
}

function Section({ title, aside, children, className, id }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <Card size="sm" className={cn('gap-3', className)} id={id}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="eyebrow">{title}</CardTitle>
        {aside && <div className="text-xs text-ink-subtle">{aside}</div>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SeatsCard() {
  const s = useStore(ui, (x) => ({ seats: x.seats, seat: x.seat, seatChanging: x.seatChanging, connected: x.connected, game: x.game }));
  const taken = s.seats.filter((x) => x.occupied).length;
  return (
    <Section title="Jugadores" aside={s.seats.length ? `${taken}/${s.seats.length}` : ''}>
      <div id="seats" className="grid gap-1.5">
        {s.seats.map((seat) => {
          const ch = characterOf(seat.index);
          const mine = seat.index === s.seat;
          const onBench = benched(seat.index);
          const wants = seat.occupied && !onBench ? characterName(seat.want) : null;
          return (
            <div
              key={seat.index}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-2.5 py-2',
                mine ? 'border-hairline-strong bg-secondary' : 'border-transparent',
              )}
            >
              <Avatar color={ch.color} label={ch.short} dim={!seat.occupied} />
              <div className="min-w-0 flex-1">
                <div className={cn('truncate text-sm font-medium', seat.occupied ? 'text-ink' : 'text-ink-subtle')}>
                  {seat.occupied ? seat.name || 'Jugador' : 'Libre'}
                </div>
                <div className="truncate text-xs text-ink-subtle">
                  {seat.host
                    ? `${ch.name} · juega en la PC del anfitrión`
                    : onBench ? `puesto ${seat.index} · entra en la próxima partida` : `${ch.name} · puesto ${seat.index}`}
                  {wants && wants !== ch.name && <span className="text-ink-muted"> → quiere {wants}</span>}
                </div>
              </div>
              {mine ? (
                <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">TÚ</span>
              ) : seat.host ? (
                <span className="rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-subtle">PC</span>
              ) : !seat.occupied && s.connected ? (
                <Button size="sm" variant="secondary" disabled={s.seatChanging} onClick={() => claimSeat(seat.index)}>
                  {s.seatChanging ? 'Cambiando…' : s.seat ? 'Cambiar' : 'Jugar'}
                </Button>
              ) : (
                <span title={seat.occupied ? 'mando activo' : ''}
                  className={cn('size-2 rounded-full', seat.occupied && seat.padAge != null && seat.padAge < 1500 ? 'bg-success' : 'bg-hairline-tertiary')} />
              )}
            </div>
          );
        })}
        {!s.seats.length && <p className="text-sm text-ink-subtle">Esperando a la sala…</p>}
      </div>
    </Section>
  );
}

/** A character's initial on a dark disc, with its color as a thin ring (identity, not decoration). */
function Avatar({ color, label, dim }: { color: string; label: string; dim?: boolean }) {
  return (
    <span
      className={cn('grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-ink', dim && 'opacity-50')}
      style={{ background: `color-mix(in oklch, ${color} 22%, var(--color-surface-2))`, boxShadow: `inset 0 0 0 1.5px ${color}` }}
    >
      {label}
    </span>
  );
}

function NextMatchCard() {
  const s = useStore(ui, (x) => ({ seats: x.seats, seat: x.seat, characters: x.characters, game: x.game }));
  const mine = s.seats.find((x) => x.index === s.seat);
  if (!mine) return null;
  const options = (s.characters.length ? s.characters : Object.keys(CHARACTER_IDS)).filter((k) => characterName(k));
  return (
    <Section title="Próxima partida" id="wantCard">
      <Select value={mine.want || 'none'} onValueChange={(v) => setWant(v === 'none' ? '' : v)}>
        <SelectTrigger id="wantSelect" className="w-full" aria-label="Personaje que quieres en la próxima partida">
          <SelectValue />
        </SelectTrigger>
        <SelectContent onCloseAutoFocus={keepGameKeys}>
          <SelectItem value="none">Me da igual</SelectItem>
          {options.map((k) => <SelectItem key={k} value={k}>Quiero ser {characterName(k)}</SelectItem>)}
        </SelectContent>
      </Select>
      <p id="wantHint" className="mt-2 text-xs leading-relaxed text-ink-subtle">
        {benched(mine.index)
          ? 'Tu puesto no juega en esta partida: elige personaje y el anfitrión te mete en la próxima.'
          : 'El anfitrión ve lo que elige cada uno y reinicia la partida cuando estén listos.'}
      </p>
    </Section>
  );
}

function ChatCard() {
  const chat = useStore(ui, (x) => x.chat);
  const seats = useStore(ui, (x) => x.seats); // colors follow the characters
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { hooks.focusChat = () => inputRef.current?.focus(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [chat]);
  return (
    <Section title="Chat" aside={<span className="inline-flex items-center gap-1"><Kbd>T</Kbd> para escribir</span>}>
      <div ref={logRef} id="chatLog" aria-live="polite" className="mb-3 grid max-h-48 gap-1 overflow-y-auto text-[13px] [overflow-wrap:anywhere]">
        {chat.length ? chat.map((m) => (
          <div key={m.id} className="leading-snug">
            <b className="mr-1.5 font-semibold" style={{ color: m.seat && seats.length ? characterOf(m.seat).color : 'var(--color-ink-muted)' }}>{m.name}</b>
            <span className="text-ink-muted">{m.text}</span>
          </div>
        )) : <div className="text-xs text-ink-tertiary">Nadie escribió todavía.</div>}
      </div>
      <div id="emotes" className="mb-3 flex flex-wrap gap-1">
        {EMOTES.map((e) => (
          <Button key={e} type="button" variant="ghost" size="sm" title={`Mandar ${e}`} onClick={() => sendEmote(e)}
            className="min-w-9 px-2 text-[15px] font-bold">{e}</Button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); sendChat(text); setText(''); inputRef.current?.blur(); }}>
        <Input ref={inputRef} id="chatInput" maxLength={160} placeholder="Escribe algo…" autoComplete="off" aria-label="Mensaje"
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') inputRef.current?.blur(); }} />
        <Button type="submit" variant="secondary">Enviar</Button>
      </form>
    </Section>
  );
}

function NameCard() {
  const saved = useStore(ui, (x) => x.name);
  const [name, setName] = useState(saved);
  return (
    <Section title="Tu nombre">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); saveName(name); (document.activeElement as HTMLElement)?.blur(); }}>
        <Input id="nameInput" maxLength={24} placeholder="¿Cómo te llamas?" autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} />
        <Button id="nameBtn" type="submit" variant="secondary">Guardar</Button>
      </form>
    </Section>
  );
}

function PadCard() {
  const pad = useStore(ui, (x) => x.pad);
  const latency = useStore(ui, (x) => x.latency);
  const on = (b: string) => (pad.b[b] ? 'fill-ink' : 'fill-surface-4');
  return (
    <Section title="Tu mando" aside={<span id="srcChip" className="font-mono">{pad.source}</span>}>
      <svg viewBox="0 0 220 120" aria-hidden className="mx-auto mb-2 w-full max-w-[280px]">
        <rect x="6" y="18" width="208" height="92" rx="40" className="fill-surface-2 stroke-hairline-strong" />
        <rect x="30" y="4" width="46" height="14" rx="6" className={on('lb')} />
        <rect x="144" y="4" width="46" height="14" rx="6" className={on('rb')} />
        <circle cx="62" cy="64" r="26" className="fill-canvas stroke-hairline-strong" />
        <circle cx={62 + pad.lx * 14} cy={64 + pad.ly * 14} r="11" className="fill-primary" />
        {([['y', 160, 44], ['x', 140, 64], ['b', 180, 64], ['a', 160, 84]] as const).map(([b, x, y]) => (
          <g key={b}>
            <circle cx={x} cy={y} r="10" className={on(b)} />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="10" className={pad.b[b] ? 'fill-canvas' : 'fill-ink-muted'}>{b.toUpperCase()}</text>
          </g>
        ))}
        <rect x="98" y="58" width="24" height="10" rx="5" className={on('start')} />
      </svg>
      <div id="padInfo" className="font-mono text-xs text-ink-subtle">{pad.info}</div>
      <div className="mt-3 flex items-center gap-3">
        <Button id="latBtn" type="button" variant="secondary" size="sm" disabled={latency.busy} onClick={measureLatency}
          title="Tu personaje salta 5 veces: mide del botón hasta que cambia la imagen">
          Medir retraso
        </Button>
        <span id="latText" className="text-xs text-ink-subtle">{latency.text}</span>
      </div>
    </Section>
  );
}

const KEYS: [string[], string][] = [
  [['W', 'A', 'S', 'D'], 'moverse'],
  [['J', 'Espacio'], 'A · saltar'],
  [['K'], 'B · acción, spin dash'],
  [['U', 'I'], 'X · Y'],
  [['Q', 'E'], 'LB · RB'],
  [['⇧', 'O'], 'LT · RT (girar cámara)'],
  [['←', '→'], 'stick derecho'],
  [['Enter'], 'Start'],
  [['F'], 'pantalla completa'],
  [['V'], 'cambiar lo que ves'],
  [['M'], 'sonido del juego'],
];

// A Counter-Strike soldier's buttons: X fires (held, the rifle keeps firing; an empty clip reloads), B changes
// weapon (rifle, AWP, Desert Eagle, knife), Y throws an HE grenade (three, one back every ten seconds).
const SOLDIER_KEYS: [string[], string][] = [
  [['W', 'A', 'S', 'D'], 'moverse'],
  [['J', 'Espacio'], 'A · saltar'],
  [['U'], 'X · disparar (mantén con el rifle)'],
  [['K'], 'B · cambiar de arma'],
  [['I'], 'Y · granada'],
  ...KEYS.slice(4),
];

function KeysCard() {
  const soldier = useStore(ui, (x) => {
    const list = x.game.online && Array.isArray(x.game.characters) ? x.game.characters : [];
    return x.seat ? isSoldier(list[x.seat - 1]) : false;
  });
  return (
    <Section title={soldier ? 'Controles · soldado' : 'Controles'}>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-[13px]">
        {(soldier ? SOLDIER_KEYS : KEYS).map(([keys, label]) => (
          <div key={label} className="contents">
            <div className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</div>
            <div className="text-ink-muted">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        También sirve un mando conectado a tu equipo (Xbox, PlayStation vía Steam) o los botones táctiles.
      </p>
    </Section>
  );
}

function RoomCard() {
  const code = useStore(ui, (x) => x.code);
  const msg = useStore(ui, (x) => x.msg);
  const direct = useStore(ui, (x) => x.direct);
  const [value, setValue] = useState(code);
  const directState = !direct.enabled ? ''
    : direct.showing ? 'activa'
    : direct.connecting ? 'conectando…'
    : direct.declined ? 'no hace falta' : 'no disponible en tu red';
  return (
    <Section title="Sala">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); joinRoom(value); }}>
        <Input id="codeInput" maxLength={8} placeholder="código" className="font-mono uppercase tracking-[0.12em]"
          value={value} onChange={(e) => setValue(e.target.value)} />
        <Button id="joinBtn" type="submit">Entrar</Button>
      </form>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <span className="text-ink-subtle">enlace</span>
        <span id="linkChip" className="truncate font-mono text-ink-muted">{location.host}/?code={code || '----'}</span>
      </div>
      {direct.available && 'RTCPeerConnection' in window && (
        <label id="directRow" className="mt-2 flex cursor-pointer items-center justify-between gap-3 text-xs"
          title={direct.declined ? `Sin conexión directa: ${direct.reason}` : 'Vídeo y mando por UDP directo a la PC del anfitrión, sin pasar por el túnel. Si tu red no lo permite, sigue por el túnel.'}>
          <span className="text-ink-subtle">Conexión directa {directState && <span id="directState" className="text-ink-muted">· {directState}</span>}</span>
          <Switch id="directToggle" size="sm" checked={direct.enabled} onCheckedChange={setDirect} />
        </label>
      )}
      <p id="msg" className={cn('mt-3 min-h-5 text-xs',
        msg.tone === 'ok' ? 'text-success' : msg.tone === 'warn' ? 'text-warning' : msg.tone === 'bad' ? 'text-destructive' : 'text-ink-subtle')}>
        {msg.text}
      </p>
    </Section>
  );
}
