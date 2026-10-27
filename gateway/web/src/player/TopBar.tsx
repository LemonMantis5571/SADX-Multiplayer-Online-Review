// The top bar: brand, the room's status as small pills, and what you watch (view, quality, seat).
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { VIEWS, claimSeat, copyLink, keepGameKeys, release, setQuality, setView, ui } from './room';

export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-5 rounded-full border-[3.5px] border-primary', className)} />;
}

const TONE_DOT: Record<string, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  '': 'bg-ink-tertiary',
};

/** Linear's status pill: surface-2, muted ink, caption size, fully round. */
export function Pill({ label, children, className, title }: { label?: string; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 text-xs text-ink-muted whitespace-nowrap', className)}>
      {label && <span className="text-ink-subtle">{label}</span>}
      {children}
    </span>
  );
}

export function TopBar() {
  const conn = useStore(ui, (s) => s.conn);
  const code = useStore(ui, (s) => s.code);
  const wsRtt = useStore(ui, (s) => s.wsRtt);
  const videoChip = useStore(ui, (s) => {
    const parts: string[] = [];
    if (s.hasFrame) parts.push(`${s.video.fps} fps`);
    if (s.video.rtt != null) parts.push(`${s.video.rtt} ms`);
    return { text: parts.join(' · ') || '—', rtt: s.video.rtt };
  });
  const seat = useStore(ui, (s) => s.seat);
  const role = useStore(ui, (s) => s.role);
  const spectators = useStore(ui, (s) => s.spectators);
  const freeSeats = useStore(ui, (s) => s.seats.filter((x) => !x.occupied).length);
  const view = useStore(ui, (s) => s.view);
  const quality = useStore(ui, (s) => s.quality);
  const delayTone = videoChip.rtt == null ? '' : videoChip.rtt < 120 ? 'text-success' : videoChip.rtt < 250 ? 'text-warning' : 'text-destructive';

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-14 w-full max-w-[1680px] flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
        <div className="mr-2 flex items-center gap-2.5">
          <BrandMark />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-[-0.3px] text-ink">SADX Online</div>
            <div className="text-xs text-ink-subtle">Puesto de mando</div>
          </div>
        </div>

        <Pill>
          <span className={cn('size-1.5 rounded-full', TONE_DOT[conn.tone])} />
          <span id="connText" className="text-ink">{conn.text}</span>
        </Pill>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={copyLink} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 text-xs text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink-muted">
              sala <b id="codeChip" className="font-mono font-medium tracking-[0.12em] text-ink">{code || '----'}</b>
              <Copy className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Copiar el enlace de la sala</TooltipContent>
        </Tooltip>
        <Pill label="red" className="hidden sm:inline-flex" title="Ida y vuelta de los mandos">
          <b id="rttChip" className="font-medium text-ink tabular-nums">{wsRtt == null ? '—' : `${wsRtt} ms`}</b>
        </Pill>
        <Pill label="vídeo" title="Cuadros por segundo que ves y retraso del vídeo">
          <b id="fpsChip" className={cn('font-medium tabular-nums', delayTone || 'text-ink')}>{videoChip.text}</b>
        </Pill>
        <Pill label="puesto" className="hidden md:inline-flex">
          <b id="seatChip" className="font-medium text-ink">{role === null ? '—' : seat ? String(seat) : 'espectador'}</b>
        </Pill>
        <Pill label="mirando" className="hidden md:inline-flex">
          <b id="audienceChip" className="font-medium text-ink tabular-nums">{spectators}</b>
        </Pill>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={view} onValueChange={setView}>
            <SelectTrigger id="view" size="sm" className="min-w-40" aria-label="Qué ves (V)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent onCloseAutoFocus={keepGameKeys}>
              {VIEWS.map(([value, label]) => <SelectItem key={value} value={value}>Ver: {label.toLowerCase()}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={quality} onValueChange={setQuality}>
            <SelectTrigger id="quality" size="sm" aria-label="Calidad del vídeo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent onCloseAutoFocus={keepGameKeys}>
              <SelectItem value="auto">Calidad: auto</SelectItem>
              <SelectItem value="alta">Calidad: alta</SelectItem>
              <SelectItem value="baja">Calidad: baja</SelectItem>
            </SelectContent>
          </Select>
          <Button id="claimBtn" hidden={role !== 'spectator' || freeSeats === 0} disabled={freeSeats === 0} onClick={() => claimSeat()}>
            Tomar puesto
          </Button>
          <Button id="releaseBtn" variant="ghost" disabled={!seat} onClick={release}>
            Soltar puesto
          </Button>
        </div>
      </div>
    </header>
  );
}
