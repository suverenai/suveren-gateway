/**
 * Runs once per test file (vitest `setupFiles`) before that file's own code.
 *
 * Unit tests must be hermetic: a real Suveren IT policy already present on
 * the machine running the suite (a developer's laptop, or a CI runner with
 * leftover state) must not change what any test observes, and `pnpm -r test`
 * runs every workspace package in PARALLEL — a test in one package writing
 * to the real Windows registry key races every other package's tests
 * reading that same real key at the same time. This happened in practice:
 * control-plane's gateway-policy-windows-registry.test.ts writing a real
 * HKCU value made an unrelated mcp-server test in a different process see
 * it mid-run.
 *
 * Disabling the registry source by default for every test file closes that
 * race at the root: nothing here reads the real registry unless a test
 * explicitly opts back in. `gateway-policy-windows-registry.test.ts` (in
 * control-plane) is the one place that does, and it also points
 * `SUVEREN_POLICY_REGISTRY_KEY` at a unique per-run key so it can never
 * collide with this default-off setting (or itself) elsewhere.
 */
process.env.SUVEREN_POLICY_REGISTRY = 'off';
