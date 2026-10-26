// The room serves the built pages from ../public: the player page (index.html) and the host panel
// (host.html), with their scripts and fonts under /assets. Built files are committed, so a PC that only
// hosts doesn't need to build anything.
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: path.resolve(__dirname, '../public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        host: path.resolve(__dirname, 'host.html'),
      },
    },
  },
  // `npm run dev` against a room running on 8123 (the page's WebSocket and API go to the room).
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8123', ws: true },
      '/api': 'http://127.0.0.1:8123',
    },
  },
});
