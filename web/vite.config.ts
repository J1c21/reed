import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// The production bundle is served by the app from reed://app/, so every URL is relative.
export default defineConfig({
  plugins: [solid()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    // In development local images referenced by notebooks are served through /@fs/.
    fs: { strict: false },
  },
  build: {
    target: 'safari16.4',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
