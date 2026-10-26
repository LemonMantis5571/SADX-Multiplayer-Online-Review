// The player page: a top bar with the room's status and what you watch, the game in a large panel, and
// a column of cards (seats, next match, chat, name, controller, keys, room).
import { useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useStore } from '@/lib/store';
import { ui, submitPassword } from './room';
import { TopBar } from './TopBar';
import { Stage } from './Stage';
import { Sidebar } from './Sidebar';

export function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-dvh flex-col bg-background lg:h-screen">
        <TopBar />
        <main className="mx-auto grid w-full max-w-[1680px] flex-1 gap-4 p-3 sm:p-4 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Stage />
          <Sidebar />
        </main>
      </div>
      <PasswordGate />
      <Toaster position="top-right" />
    </TooltipProvider>
  );
}

function PasswordGate() {
  const gate = useStore(ui, (s) => s.gate);
  const [pw, setPw] = useState('');
  return (
    <Dialog open={gate.open}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sala con contraseña</DialogTitle>
          <DialogDescription>{gate.message}</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); submitPassword(pw); setPw(''); }}
        >
          <Input autoFocus type="password" maxLength={64} placeholder="contraseña" autoComplete="current-password"
            value={pw} onChange={(e) => setPw(e.target.value)} />
          <Button type="submit">Entrar</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
