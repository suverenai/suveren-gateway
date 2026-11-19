import { defineConfig } from 'tsup';

// The shipped bundle maps `@hap/core` to the published `@humanagencyp/hap-core`,
// which has no such subpaths: compile the pure helpers in.
// `@suveren/unlock-helper` (the helper's Node client) is a workspace package that is not published:
// it is compiled in, like the pure helpers.
export default defineConfig({ noExternal: [/^@hap\/core\/(refusal|mandate-change|scope-rules|mandate-grant|execution-mapping|decision-input)$/, /^@suveren\/unlock-helper$/] });
