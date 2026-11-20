import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite proxy keys are prefix-string matches (dev-only). Where a prefix
// would otherwise swallow a UI page path, we require a trailing slash:
//   - `/auth/`         so it doesn't catch `/authorizations` (legacy page address, forwards to /mandates)
//   - `/integrations/` so it doesn't catch the integrations page
//   - `/agent-brief/`  so it doesn't catch the agent-brief page
// Other keys stay bare because no UI route collides with them, and some
// endpoints are POSTed at the bare path (e.g. `/gate-content`).
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev UI port. The npm-installed CLI serves on 3400; dev runs on 3401
    // so both can run in parallel. CP proxy targets stay at 3402 (dev CP).
    port: 3401,
    proxy: {
      '/api': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/auth/': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/gate-content': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      // Bare path; NOTE: must NOT be `/mandates` or `/authorizations` (UI page routes).
      '/active-authorizations': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      // Bare path; NOT `/proposals` (a UI page route).
      '/proposal-status': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/denials': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/vault': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/ai': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/ai-prompts': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/github': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/health': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/as-pairing': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/skipped-commitments': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/autostart': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/resync-gates': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/mcp': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/integrations/': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/agent-brief/': {
        target: 'http://localhost:3402',
        changeOrigin: false,
      },
      '/events': {
        target: 'http://localhost:3402',
        changeOrigin: false,
        // SSE: disable proxy response buffering so event frames flush immediately.
        ws: false,
      },
    },
  },
});
