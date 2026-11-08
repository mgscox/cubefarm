import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localUrl, officeHost } from './bin/officeNetwork.js';

const serverPort = Number(process.env.SWARM_PORT ?? 4317);
// strictPort: a second office must fail loudly, not quietly take the next port while proxying to this SWARM_PORT.
const clientPort = Number(process.env.SWARM_CLIENT_PORT || 5317);
const host = officeHost();

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: {
      // Preserve authorization inputs for every API path, including Express's case-insensitive aliases.
      '/api': { target: localUrl(host, serverPort), xfwd: true },
      '/ws': { target: localUrl(host, serverPort, 'ws'), ws: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
