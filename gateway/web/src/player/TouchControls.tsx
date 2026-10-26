// Touch controls for phones: a stick on the left, ABXY on the right, shoulders on top and START in the
// middle. Over the picture by default; `docked` puts them in their own strip under it (phone upright).
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { touchButton, touchStick } from './room';

const FACE = [
  { btn: 'y', className: 'right-14 bottom-28', tone: 'text-[#e5c25a]' },
  { btn: 'x', className: 'right-28 bottom-14', tone: 'text-[#7d9bf0]' },
  { btn: 'b', className: 'right-0 bottom-14', tone: 'text-[#ec7d7d]' },
  { btn: 'a', className: 'right-14 bottom-0', tone: 'text-[#5fc77d]' },
];

export function TouchControls({ docked = false, className }: { docked?: boolean; className?: string }) {
  return (
    <div
      id="touch"
      className={cn(
        'pointer-events-none select-none',
        docked ? 'relative h-64 w-full border-t border-border bg-canvas' : 'absolute inset-0',
        className,
      )}
    >
      <div className={cn('absolute flex gap-2', docked ? 'top-3 left-4' : 'top-16 left-4')}>
        <Pad btn="lt" wide>LT</Pad>
        <Pad btn="lb" wide>LB</Pad>
      </div>
      <div className={cn('absolute flex gap-2', docked ? 'top-3 right-4' : 'top-16 right-4')}>
        <Pad btn="rb" wide>RB</Pad>
        <Pad btn="rt" wide>RT</Pad>
      </div>
      <Stick />
      <div className="pointer-events-auto absolute right-4 bottom-4 size-[170px] touch-none">
        {FACE.map((f) => (
          <Pad key={f.btn} btn={f.btn} className={cn('absolute size-14 rounded-full text-lg', f.className, f.tone)}>
            {f.btn.toUpperCase()}
          </Pad>
        ))}
      </div>
      <div className={cn('absolute left-1/2 -translate-x-1/2', docked ? 'top-3' : 'bottom-4')}>
        <Pad btn="start" wide className="w-24 rounded-full tracking-[0.08em]">START</Pad>
      </div>
    </div>
  );
}

function Pad({ btn, wide, className, children }: { btn: string; wide?: boolean; className?: string; children: React.ReactNode }) {
  const [held, setHeld] = useState(false);
  const end = () => { setHeld(false); touchButton(btn, false); };
  return (
    <div
      data-btn={btn}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setHeld(true);
        touchButton(btn, true);
        navigator.vibrate?.(8);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className={cn(
        'pointer-events-auto grid touch-none place-items-center border border-white/15 bg-surface-3/70 font-semibold text-ink backdrop-blur transition-transform',
        wide && 'h-9 min-w-14 rounded-lg px-3 text-xs',
        held && 'scale-95 bg-ink/30',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Stick() {
  const ref = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const max = rect.width / 2 - 14;
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist > max) { dx = (dx / dist) * max; dy = (dy / dist) * max; }
    setOffset({ x: dx, y: dy });
    touchStick(Math.round((dx / max) * 1000) / 1000, Math.round((dy / max) * 1000) / 1000);
  };
  const end = () => { pointer.current = null; setOffset({ x: 0, y: 0 }); touchStick(0, 0); };
  return (
    <div
      ref={ref}
      id="stick"
      className="pointer-events-auto absolute bottom-5 left-5 size-34 touch-none rounded-full border border-white/15 bg-surface-3/50 backdrop-blur"
      onPointerDown={(e) => { pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
      onPointerMove={(e) => { if (pointer.current === e.pointerId) move(e); }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        id="knob"
        className="absolute top-1/2 left-1/2 -mt-7 -ml-7 size-14 rounded-full border border-white/20 bg-ink-muted/80 shadow-[0_4px_14px_rgb(0_0_0/0.4)]"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      />
    </div>
  );
}
