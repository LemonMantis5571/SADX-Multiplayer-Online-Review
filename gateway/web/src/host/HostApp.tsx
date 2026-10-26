// The host panel (only from this PC, with the room's admin token): invite (link + QR), password, the
// match (level, mode, characters, restart), who's in each seat (and kicking), and the video streams.
import { useCallback, useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { toast } from 'sonner';
import { Copy, ExternalLink, Power, RotateCcw, UserX } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { session } from '@/lib/store';
import { CHAR_NAMES, LEVEL_NAMES, MOD_CHARS } from '@/lib/game';

type GameConfig = { level: string; act: number; mode: string; characters: string[] };
type ViewStatus = { height: number; measuredFps: number | null; measuredKbps: number | null; encoding: boolean; lastFrameAt: number | null };
type AdminState = {
  room: string; password: boolean; localUrl: string; shareUrl: string | null;
  seats: { index: number; host?: boolean; occupied: boolean; name: string | null; want: string | null; ip: string | null; padAge: number | null }[];
  spectators: { name: string | null; ip: string }[];
  game: { running?: boolean; pid?: number | null; busy?: boolean; config?: GameConfig; autoRestarts?: number; managed?: boolean };
  mod: { online: boolean; characters?: number[] };
  video: null | {
    running: boolean; encoder: string; split: boolean; lastError: string | null; views: Record<string, ViewStatus>;
    viewers: { address: string; codec: string; view: string; track: string; mode: string; transport?: string; rttMs: number | null; minRttMs: number | null; inflight: number; sent: number; skipped: number }[];
  };
  audio: null | { listeners: number; format: string | null };
  options: { levels: string[]; characters: string[]; modes: string[] };
};

// The token comes once in the address (?admin=, from the launcher) and stays in this tab only.
const params = new URLSearchParams(location.search);
const token = params.get('admin') || session.get('sadx-admin');
if (params.get('admin')) { session.set('sadx-admin', token); history.replaceState(null, '', location.pathname); }

async function api(method: string, route: string, body?: unknown): Promise<AdminState> {
  const res = await fetch(`/api/admin/${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && route === 'state') throw new Error('Sin acceso: abre este panel desde el lanzador (lleva el token de la sala).');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

const VIEW_NAMES: Record<string, string> = { alta: 'Toda · alta', baja: 'Toda · baja', p1: 'Jugador 1', p2: 'Jugador 2', p3: 'Jugador 3', p4: 'Jugador 4' };

export function HostApp() {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<GameConfig | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api('GET', 'state');
      setState(next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // The form follows the running match until the host changes something.
  useEffect(() => {
    if (!touched && state?.game.config) setForm({ ...state.game.config, characters: [...state.game.config.characters] });
  }, [state, touched]);

  const run = async (action: () => Promise<AdminState>, done?: string) => {
    try { setState(await action()); if (done) toast(done); } catch (e) { toast((e as Error).message); }
  };

  const g = state?.game;
  const running = Boolean(g?.running);
  const gameTone = running ? 'bg-success' : g?.busy ? 'bg-warning' : 'bg-destructive';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-dvh bg-background">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex min-h-14 max-w-[1280px] flex-wrap items-center gap-3 px-4 py-2">
            <span aria-hidden className="inline-block size-5 rounded-full border-[3.5px] border-primary" />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold tracking-[-0.3px]">SADX Online</div>
              <div className="text-xs text-ink-subtle">Panel del anfitrión · sala <span className="font-mono text-ink">{state?.room ?? '—'}</span></div>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <StatusPill tone={error ? 'bg-destructive' : gameTone}>
                {error || (running ? `juego en marcha (pid ${g?.pid})` : g?.busy ? 'reiniciando…' : 'juego cerrado')}
              </StatusPill>
              <StatusPill tone={state?.shareUrl ? 'bg-success' : 'bg-warning'}>{state?.shareUrl ? 'enlace público activo' : 'solo local'}</StatusPill>
            </div>
          </div>
        </header>

        <main className="mx-auto grid max-w-[1280px] gap-4 p-4 md:grid-cols-2">
          <InviteCard state={state} />
          <SecurityCard state={state} onSave={(pw) => run(() => api('POST', 'password', { password: pw }), pw ? 'Contraseña activada' : 'Contraseña quitada')} />
          {state && form && (
            <MatchCard
              state={state}
              form={form}
              busy={busy}
              onChange={(next) => { setForm(next); setTouched(true); }}
              onApply={async () => {
                setBusy(true);
                toast('Reiniciando SADX…');
                await run(() => api('POST', 'game', form), 'Partida reiniciada');
                setTouched(false);
                setBusy(false);
              }}
              onStop={() => run(() => api('POST', 'game/stop'), 'Juego cerrado')}
            />
          )}
          {state && <PlayersCard state={state} onKick={(seat) => run(() => api('POST', 'kick', { seat }), 'Jugador fuera')} />}
          {state && <VideoCard state={state} />}
        </main>
      </div>
      <Toaster position="top-right" />
    </TooltipProvider>
  );
}

function StatusPill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 text-xs text-ink-muted">
      <span className={cn('size-1.5 rounded-full', tone)} />{children}
    </span>
  );
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader><CardTitle className="eyebrow">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function InviteCard({ state }: { state: AdminState | null }) {
  const svg = useMemo(() => {
    if (!state?.shareUrl) return null;
    const qr = qrcode(0, 'M');
    qr.addData(state.shareUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [state?.shareUrl]);
  const copy = async () => {
    if (!state?.shareUrl) return;
    try { await navigator.clipboard.writeText(state.shareUrl); toast('Enlace copiado'); } catch { toast(state.shareUrl); }
  };
  return (
    <Section title="Invitar">
      <div className="flex flex-wrap gap-5">
        <div className="grid size-40 shrink-0 place-items-center rounded-xl bg-white p-2.5 text-center text-xs text-[#62666d]">
          {/* The QR svg is generated locally from the room's own link. */}
          {svg ? <div className="size-full [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} /> : 'sin enlace público'}
        </div>
        <div className="grid min-w-52 flex-1 content-start gap-3">
          <div>
            <div className="text-xs text-ink-subtle">Enlace público</div>
            <div className="font-mono text-[13px] break-all text-ink">{state?.shareUrl ?? 'sin enlace público (ejecuta share start)'}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!state?.shareUrl} onClick={copy}><Copy />Copiar enlace</Button>
            <Button size="sm" variant="secondary" disabled={!state} onClick={() => state && window.open(state.localUrl, '_blank')}><ExternalLink />Abrir para jugar</Button>
          </div>
          <div>
            <div className="text-xs text-ink-subtle">Esta PC / tu WiFi</div>
            <div className="font-mono text-[13px] break-all text-ink-muted">{state?.localUrl ?? '—'}</div>
          </div>
          <p className="text-xs leading-relaxed text-ink-subtle">
            Quien tenga el enlace puede entrar: pon contraseña si lo compartes en público.
          </p>
        </div>
      </div>
    </Section>
  );
}

function SecurityCard({ state, onSave }: { state: AdminState | null; onSave: (pw: string) => void }) {
  const [pw, setPw] = useState('');
  return (
    <Section title="Seguridad">
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onSave(pw); }}>
        <Label htmlFor="pw" className="text-xs text-ink-subtle">Contraseña de la sala</Label>
        <div className="flex gap-2">
          <Input id="pw" maxLength={64} placeholder="sin contraseña" value={pw} onChange={(e) => setPw(e.target.value)} />
          <Button type="submit" variant="secondary">Guardar</Button>
        </div>
      </form>
      <p className="mt-3 text-[13px] text-ink-muted">
        {state?.password ? 'La sala tiene contraseña: la página la pide al entrar.' : 'Sin contraseña: cualquiera con el enlace entra.'}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
        Sacar a alguien lo bloquea 10 minutos (por su dirección real, también a través del túnel).
      </p>
    </Section>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs text-ink-subtle">{label}</Label>
      {children}
    </div>
  );
}

function SimpleSelect({ value, onChange, options, id }: { value: string; onChange: (v: string) => void; options: [string, string][]; id?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function MatchCard({ state, form, busy, onChange, onApply, onStop }: {
  state: AdminState; form: GameConfig; busy: boolean;
  onChange: (next: GameConfig) => void; onApply: () => void; onStop: () => void;
}) {
  const count = form.characters.length;
  const characters = state.options.characters.map((c) => [c, CHAR_NAMES[c] || c] as [string, string]);
  const setCount = (n: number) => {
    const list = [...form.characters];
    const defaults = ['sonic', 'tails', 'knuckles', 'amy'];
    while (list.length < n) list.push(defaults[list.length] || 'sonic');
    onChange({ ...form, characters: list.slice(0, n) });
  };
  const useWants = () => {
    const list = [...form.characters];
    // Everyone sitting plays: someone waiting on a seat past the current player count joins this time.
    const lastTaken = Math.max(0, ...state.seats.filter((s) => s.occupied).map((s) => s.index));
    const n = Math.max(list.length, Math.min(4, lastTaken));
    const defaults = ['sonic', 'tails', 'knuckles', 'amy'];
    while (list.length < n) list.push(defaults[list.length] || 'sonic');
    for (const s of state.seats) if (s.want && s.index <= n) list[s.index - 1] = s.want;
    onChange({ ...form, characters: list });
    toast('Personajes cargados: pulsa «Aplicar y reiniciar»');
  };
  const g = state.game;
  const c = g.config;
  return (
    <Section title="Partida" className="md:col-span-2">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <Field label="Nivel">
          <SimpleSelect id="level" value={form.level} onChange={(level) => onChange({ ...form, level })}
            options={state.options.levels.map((l) => [l, LEVEL_NAMES[l] || l])} />
        </Field>
        <Field label="Acto">
          <SimpleSelect id="act" value={String(form.act)} onChange={(act) => onChange({ ...form, act: Number(act) })}
            options={['0', '1', '2', '3'].map((a) => [a, a])} />
        </Field>
        <Field label="Modo">
          <SimpleSelect id="mode" value={form.mode} onChange={(mode) => onChange({ ...form, mode })}
            options={[['coop', 'Cooperativo'], ['battle', 'Batalla']]} />
        </Field>
        <Field label="Jugadores">
          <SimpleSelect id="count" value={String(count)} onChange={(n) => setCount(Number(n))}
            options={['1', '2', '3', '4'].map((n) => [n, n])} />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        {form.characters.map((ch, i) => (
          <Field key={i} label={i === 0 ? 'Jugador 1 · tú, en esta PC' : `Jugador ${i + 1}`}>
            <SimpleSelect id={`char${i + 1}`} value={ch} options={characters}
              onChange={(v) => { const list = [...form.characters]; list[i] = v; onChange({ ...form, characters: list }); }} />
          </Field>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={useWants}>Usar lo que eligieron los jugadores</Button>
        <span className="flex-1" />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={!g.running}><Power />Cerrar el juego</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Cerrar SADX?</AlertDialogTitle>
              <AlertDialogDescription>Las personas conectadas se quedan sin partida hasta que lo abras otra vez.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onStop}>Cerrar el juego</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button disabled={busy} onClick={onApply}><RotateCcw />Aplicar y reiniciar</Button>
      </div>
      {c && (
        <p className="mt-3 text-xs text-ink-subtle">
          {g.running ? 'Ahora' : 'Última partida'}: {LEVEL_NAMES[c.level] || c.level}, acto {c.act}, {c.mode === 'coop' ? 'cooperativo' : 'batalla'}, {c.characters.map((x) => CHAR_NAMES[x] || x).join(' / ')}
          {g.autoRestarts ? ` · se reabrió sola ${g.autoRestarts} ${g.autoRestarts === 1 ? 'vez' : 'veces'} tras cerrarse` : ''}
        </p>
      )}
    </Section>
  );
}

function PlayersCard({ state, onKick }: { state: AdminState; onKick: (seat: number) => void }) {
  const modChars = state.mod?.online ? state.mod.characters : null;
  return (
    <Section title="Jugadores" className="md:col-span-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Puesto</TableHead><TableHead>Nombre</TableHead><TableHead>Personaje</TableHead>
            <TableHead>Quiere</TableHead><TableHead>Dirección</TableHead><TableHead>Mando</TableHead><TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.seats.map((s) => {
            const current = modChars ? MOD_CHARS[modChars[s.index - 1]] : state.game.config?.characters[s.index - 1];
            return (
              <TableRow key={s.index}>
                <TableCell className="font-mono text-ink-subtle">{s.index}</TableCell>
                {/* Names come from visitors: React renders them as text, never as HTML. */}
                <TableCell className={s.occupied ? 'text-ink' : 'text-ink-tertiary'}>{s.host ? 'Anfitrión (esta PC)' : s.occupied ? s.name || 'jugador' : '— libre —'}</TableCell>
                <TableCell className="text-ink-muted">{current ? CHAR_NAMES[current] || current : '—'}</TableCell>
                <TableCell className="text-ink-muted">{s.want && s.want !== current ? CHAR_NAMES[s.want] || s.want : ''}</TableCell>
                <TableCell className="font-mono text-xs text-ink-subtle">{s.host ? 'local' : s.ip ?? ''}</TableCell>
                <TableCell>{s.occupied && !s.host && <span className={cn('inline-block size-2 rounded-full', s.padAge != null && s.padAge < 1500 ? 'bg-success' : 'bg-hairline-tertiary')} />}</TableCell>
                <TableCell className="text-right">
                  {s.occupied && !s.host && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="destructive"><UserX />Sacar</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>¿Sacar a {s.name || 'este jugador'}?</AlertDialogTitle>
                          <AlertDialogDescription>No podrá volver a entrar durante 10 minutos.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => onKick(s.index)}>Sacar</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs text-ink-subtle">
        {state.spectators.length
          ? `Mirando (${state.spectators.length}): ${state.spectators.map((x) => x.name || 'espectador').join(', ')}`
          : 'Nadie mirando sin puesto.'}
      </p>
    </Section>
  );
}

function VideoCard({ state }: { state: AdminState }) {
  const v = state.video;
  if (!v) return null;
  const VIEWER_VIEWS: Record<string, string> = { all: 'toda', mine: 'la suya' };
  return (
    <Section title="Vídeo" className="md:col-span-2">
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(v.views || {}).map(([name, st]) => {
          const live = v.running && st.encoding && st.lastFrameAt && Date.now() - st.lastFrameAt < 3000;
          return (
            <StatusPill key={name} tone={live ? 'bg-success' : st.encoding ? 'bg-destructive' : 'bg-hairline-tertiary'}>
              <span className="text-ink">{VIEW_NAMES[name] || name}</span>
              <span className="tabular-nums">{st.height}p · {st.measuredFps ?? '—'} fps · {st.measuredKbps ?? '—'} kbps</span>
            </StatusPill>
          );
        })}
        <span className="self-center text-xs text-ink-subtle">
          {v.encoder}{v.split ? ' · pantalla dividida' : ''}{state.audio ? ` · sonido: ${state.audio.listeners} oyendo` : ''}
          {v.lastError && !v.running ? ` · ${v.lastError}` : ''}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Espectador</TableHead><TableHead>Mira</TableHead><TableHead>Vía</TableHead><TableHead>Retraso</TableHead>
            <TableHead>Mínimo</TableHead><TableHead>En vuelo</TableHead><TableHead>Enviados</TableHead><TableHead>Saltados</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {v.viewers.map((x, i) => (
            <TableRow key={i} className="tabular-nums">
              <TableCell className="font-mono text-xs text-ink-subtle">{x.address}</TableCell>
              <TableCell className="text-ink-muted">
                {VIEWER_VIEWS[x.view] || (x.view || '').replace('p', 'jugador ')} → {VIEW_NAMES[x.track] || x.track || '—'} ({x.mode})
              </TableCell>
              <TableCell className="text-ink-muted">{x.codec === 'jpeg' ? 'JPEG' : x.transport === 'rtc' ? 'directa' : 'túnel'}</TableCell>
              <TableCell>{x.rttMs != null ? `${x.rttMs} ms` : '—'}</TableCell>
              <TableCell>{x.minRttMs != null ? `${x.minRttMs} ms` : '—'}</TableCell>
              <TableCell>{x.inflight}</TableCell>
              <TableCell>{x.sent}</TableCell>
              <TableCell>{x.skipped}</TableCell>
            </TableRow>
          ))}
          {!v.viewers.length && (
            <TableRow className="hover:bg-transparent"><TableCell colSpan={8} className="text-ink-subtle">Nadie mirando todavía.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </Section>
  );
}
