import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone approval app: static files only (DEC-1). Dev port 3403 is not in any lane of the machine map; pick another if it is taken.
//
// The served build is held to the plan's Content Security Policy (section 8): no inline script, no third-party origin.
// Vite emits one module script and one stylesheet, both 'self'. Nothing here reads a secret: the only environment values
// are the public address of the Authority Server and the build commit (see src/config.ts).
export default defineConfig({
  plugins: [react()],
  server: { port: 3403, host: true },
  build: {
    // Asset file names carry their hash (plan 8). Subresource integrity and the per-file SHA-256 list are step 10.
    target: 'es2022',
    sourcemap: false,
  },
});
