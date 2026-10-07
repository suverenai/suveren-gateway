/**
 * Runs once per test file (vitest `setupFiles`) before that file's own code.
 *
 * Unit tests must be hermetic: a real Suveren IT policy already present on
 * the machine running the suite (a developer's laptop, or a CI runner with
 * leftover state) must not change what any test observes, and `pnpm -r test`
 * runs every workspace package in PARALLEL — a test in one package writing
 * to the real Windows registry key races every other package's tests
 * reading that same real key at the same time. This happened in practice:
 * this very package's gateway-policy-windows-registry.test.ts writing a
 * real HKCU value made an unrelated mcp-server test in a different process
 * see it mid-run.
 *
 * Disabling the registry source by default for every test file closes that
 * race at the root: nothing here reads the real registry unless a test
 * explicitly opts back in — see gateway-policy-windows-registry.test.ts,
 * which also points `SUVEREN_POLICY_REGISTRY_KEY` at a unique per-run key
 * so it can never collide with this default-off setting (or itself)
 * elsewhere.
 */
process.env.SUVEREN_POLICY_REGISTRY = 'off';

/**
 * Same reason for the saved ports + data folder (bundle/lib/install-
 * settings.mjs): without this, a test spawning the real CLI or server.js
 * would read the developer's own saved settings (or the real registry on
 * Windows) and start on their port and data folder. A per-process path
 * that does not exist means "nothing saved"; a test that needs saved values
 * points this at its own temp file.
 */
import { tmpdir as __tmpdir } from 'node:os';
import { join as __join } from 'node:path';
process.env.SUVEREN_INSTALL_SETTINGS_FILE ??= __join(__tmpdir(), `suveren-test-install-settings-${process.pid}.json`);
