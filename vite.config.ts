import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localUrl, officeHost } from './bin/officeNetwork.js';

const serverPort = Number(process.env.SWARM_PORT ?? 4317);
// strictPort: a second office must fail loudly, not quietly take the next port while proxying to this SWARM_PORT.
const clientPort = Number(process.env.SWARM_CLIENT_PORT || 5317);
const host = officeHost();
// Both entries can forward HTTP, including paths normalized after proxy matching.
const proxyOptions = { xfwd: true, headers: { 'x-cubefarm-dev-proxy': '1' } };

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: {
      '/api': { target: localUrl(host, serverPort), ...proxyOptions },
      '/ws': { target: localUrl(host, serverPort, 'ws'), ws: true, ...proxyOptions },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
