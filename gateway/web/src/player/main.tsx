import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { App } from './App';
import { connect, ui } from './room';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (ui.get().code) connect();
else ui.set({ msg: { text: 'Falta el código: ábrelo desde el enlace que te pasaron.', tone: 'warn' } });
