import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// En dev, Vite sert le client sur :5173 et relaie Socket.io vers le serveur (:3001).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    // deux pages : le jeu et le catalogue des décors
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), catalog: resolve(__dirname, 'catalog.html') } },
  },
});
