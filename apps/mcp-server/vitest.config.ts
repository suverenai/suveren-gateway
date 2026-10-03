import { defineConfig } from 'vitest/config';

// Everything else stays at vitest's defaults (test file globs, environment,
// …) — this config exists solely to load vitest.setup.ts before every test
// file. See that file's doc comment for why.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
});
