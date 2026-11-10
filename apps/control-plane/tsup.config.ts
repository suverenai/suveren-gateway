import { defineConfig } from 'tsup';

// The shipped bundle maps `@hap/core` to the published `@humanagencyp/hap-core`,
// which has no such subpaths: compile the pure helpers in.
export default defineConfig({ noExternal: [/^@hap\/core\/(refusal|mandate-change)$/] });
