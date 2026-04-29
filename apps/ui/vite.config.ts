import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy keys are prefix matches. Use trailing slashes for prefixes that
// would otherwise collide with UI page paths — e.g. bare `/auth` would
// catch `/authorizations`, `/integrations` would catch the integrations
// page itself, etc. Each control-plane endpoint we proxy actually lives
// at a subpath, so requiring `/auth/` is sound.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3400,
    proxy: {
      '/api/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/auth/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/gate-content/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/vault/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/ai/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/github/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/mcp/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/integrations/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/agent-brief/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/events': {
        target: 'http://localhost:3402',
        changeOrigin: true,
        // SSE: disable proxy response buffering so event frames flush immediately.
        ws: false,
      },
    },
  },
});
