// The game, framed like a product screenshot: one large panel with the picture, a few pills over it,
// and the controls that act on the picture (sound, touch controls, fullscreen).
import { useEffect, useRef, useState } from 'react';
import { Gamepad2, MapPin, Maximize, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { STAGES } from '@/lib/game';
import { attach, claimSeat, setSound, soundSupported, toggleFullscreen, ui } from './room';
import { TouchControls } from './TouchControls';
import { BrandMark } from './TopBar';

const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function Stage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [touchOn, setTouchOn] = useState(Boolean(coarse));

  useEffect(() => {
    if (canvasRef.current && videoRef.current && stageRef.current) attach(canvasRef.current, videoRef.current, stageRef.current);
  }, []);

  const hasFrame = useStore(ui, (s) => s.hasFrame);
  const showingDirect = useStore(ui, (s) => s.direct.showing);
  const placeholder = useStore(ui, (s) => s.placeholder);
  const crop = useStore(ui, (s) => s.video.crop);
  const stageName = useStore(ui, (s) => (s.game.online && s.game.stage !== undefined ? STAGES[s.game.stage] : null));
  const tierTag = useStore(ui, (s) => {
    if (s.video.codec !== 'h264' || !s.video.tier) return null;
    const parts = [s.video.tier === 'alta' ? 'HD' : 'SD'];
    if (s.video.player) parts.push(`J${s.video.player.slice(1)}`);
    if (s.quality === 'auto') parts.push('auto');
    if (s.direct.showing) parts.push('directa');
    return parts.join(' · ');
  });
  const spectating = useStore(ui, (s) => s.role === 'spectator' && s.seats.some((x) => !x.occupied));
  const sound = useStore(ui, (s) => s.sound);
  const emotes = useStore(ui, (s) => s.emotes);

  // The direct stream crops with CSS (Chromium; elsewhere it shows the whole picture).
  const viewBox = crop
    ? `inset(${crop[1] * 100}% ${(1 - crop[0] - crop[2]) * 100}% ${(1 - crop[1] - crop[3]) * 100}% ${crop[0] * 100}%)`
    : undefined;

  return (
    <section
      ref={stageRef}
      id="stage"
      className="group/stage relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-[#000] shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] fullscreen:rounded-none fullscreen:border-0"
    >
      <div className="relative grid min-h-[56vw] flex-1 place-items-center sm:min-h-[420px] lg:min-h-0">
        <canvas
          ref={canvasRef}
          id="stream"
          data-frames="0"
          aria-label="Vídeo del juego"
          onDoubleClick={toggleFullscreen}
          className={cn('absolute inset-0 size-full object-contain', (!hasFrame || showingDirect) && 'hidden')}
        />
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          aria-label="Vídeo del juego (conexión directa)"
          onDoubleClick={toggleFullscreen}
          style={{ objectViewBox: viewBox } as React.CSSProperties}
          className={cn('absolute inset-0 size-full object-contain', !showingDirect && 'hidden')}
        />
        {!hasFrame && (
          <div id="placeholder" className="flex max-w-sm flex-col items-center gap-4 p-6 text-center text-ink-subtle">
            <BrandMark className="size-10 animate-spin border-[5px] border-primary/25 border-t-primary" />
            <p id="placeholderText" className="text-sm">{placeholder}</p>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap gap-2">
          {stageName && <OverlayPill><MapPin className="size-3 text-ink-subtle" />{stageName}</OverlayPill>}
          {tierTag && <OverlayPill>{tierTag}</OverlayPill>}
        </div>

        {spectating && (
          <div id="spectatorBar" className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface-3/90 py-1.5 pr-1.5 pl-4 text-sm text-ink-muted backdrop-blur">
            Estás mirando la partida
            <Button id="spectatorClaim" size="sm" onClick={() => claimSeat()}>Jugar</Button>
          </div>
        )}

        {emotes.map((m) => (
          <div key={m.id} className="pointer-events-none absolute bottom-20 z-10 text-center text-[44px] leading-none font-bold drop-shadow-[0_2px_10px_rgb(0_0_0/0.7)]"
            style={{ left: `${m.left}%`, animation: 'rise 2.4s ease-out forwards' }}>
            {m.e}
            <small className="mt-1 block text-xs font-semibold text-ink">{m.name}</small>
          </div>
        ))}

        <div className="absolute right-3 bottom-3 z-10 flex gap-2 max-lg:portrait:top-3 max-lg:portrait:bottom-auto">
          {sound.available && soundSupported() && (
            <ToolButton label={sound.on ? 'Silenciar el juego (M)' : 'Oír el juego (M)'} id="audioBtn" onClick={() => setSound(!sound.on)}>
              {sound.on ? <Volume2 /> : <VolumeX />}
            </ToolButton>
          )}
          <ToolButton label="Mandos táctiles" id="touchToggle" pressed={touchOn} onClick={() => setTouchOn((v) => !v)}>
            <Gamepad2 />
          </ToolButton>
          <ToolButton label="Pantalla completa (F)" id="fullBtn" onClick={toggleFullscreen}>
            <Maximize />
          </ToolButton>
        </div>

        {touchOn && <TouchControls className="max-lg:portrait:hidden" />}
      </div>
      {touchOn && <TouchControls docked className="hidden max-lg:portrait:block" />}
    </section>
  );
}

function OverlayPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 bg-canvas/70 px-2.5 text-xs text-ink-muted backdrop-blur">
      {children}
    </span>
  );
}

function ToolButton({ label, id, pressed, onClick, children }: { label: string; id: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button id={id} variant="secondary" size="icon" aria-label={label} aria-pressed={pressed} onClick={onClick}
          className={cn('border-white/10 bg-canvas/70 backdrop-blur hover:bg-surface-3', pressed && 'text-primary-hover')}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
