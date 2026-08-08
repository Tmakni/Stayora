import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Michel front-end (Vite + React). API stays on the Express server (port 3000);
// in dev, requests to /api are proxied there so cookies/auth work identically to prod.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
