import { defineConfig } from 'vite';

// En dev, Vite sert le client sur :5173 et relaie Socket.io vers le serveur (:3001).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
