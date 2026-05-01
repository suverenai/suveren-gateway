import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite proxy keys are prefix-string matches (dev-only). Where a prefix
// would otherwise swallow a UI page path, we require a trailing slash:
//   - `/auth/`         so it doesn't catch `/authorizations`
//   - `/integrations/` so it doesn't catch the integrations page
//   - `/agent-brief/`  so it doesn't catch the agent-brief page
// Other keys stay bare because no UI route collides with them, and some
// endpoints are POSTed at the bare path (e.g. `/gate-content`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3400,
    proxy: {
      '/api': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/auth/': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/gate-content': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/vault': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/ai': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/ai-prompts': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/github': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3402',
        changeOrigin: true,
      },
      '/mcp': {
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
