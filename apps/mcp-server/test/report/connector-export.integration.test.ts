/**
 * Integration test: runs a REAL published connector's `export` CLI against a
 * temp `HAP_DATA_DIR`, through the real `createConnectorExportRunner` — the
 * one piece of this module that cannot be exercised by a fixture script,
 * because the real question is "does the real `email-mcp` package, installed
 * the way the gateway installs it, actually behave the way `types.ts`
 * assumes". `email-mcp` is picked over erp/crm only because it is the
 * smallest published package; its export shape is read from the same
 * `src/cli.ts` as the other two (see report/types.ts doc comment).
 *
 * Installs via the real public npm registry into a throwaway temp dir —
 * network-dependent and slower than the rest of this suite, same tradeoff
 * `ensure-installed-pin.test.ts` deliberately avoids for its OWN (much more
 * numerous) cases by faking npm. Here there is exactly one such test, and it
 * is the only thing that can catch a real schema drift in the published
 * connector, so it is worth paying for.
 *
 * If the registry is unreachable (offline dev box, air-gapped CI) this test
 * SKIPS ITSELF AT RUNTIME with a clear `console.warn` naming why, rather than
 * failing the whole suite on a network condition unrelated to the code under
 * test — `vitest`'s `skipIf` is evaluated at collection time, before
 * `beforeAll` has had a chance to attempt the install, so a dynamic skip has
 * to happen inside the test body instead.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createConnectorExportRunner } from '../../src/lib/report/connector-export';
import { isEmailExport } from '../../src/lib/report/types';

const execFileAsync = promisify(execFile);
const PACKAGE = '@humanagencyp/email-mcp';

let installDir: string | undefined;
let installFailedReason: string | undefined;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suveren-report-verifier-real-connector-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'report-verifier-test-fixture', private: true }));
  try {
    await execFileAsync('npm', ['install', PACKAGE, '--no-audit', '--no-fund'], { cwd: dir, timeout: 60_000 });
    installDir = dir;
  } catch (err) {
    installFailedReason = err instanceof Error ? err.message : String(err);
  }
}, 90_000);

describe('createConnectorExportRunner — real @humanagencyp/email-mcp', () => {
  it('runs the real published export CLI against a temp data dir and returns the real shape', async () => {
    if (!installDir) {
      console.warn(
        `[connector-export.integration] SKIPPED — could not install ${PACKAGE} from the public ` +
        `npm registry (no network in this environment?): ${installFailedReason}`,
      );
      return;
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'suveren-report-verifier-real-connector-data-'));
    const run = createConnectorExportRunner({
      integrationsBinDir: join(installDir, 'node_modules', '.bin'),
      dataDir,
    });

    const result = await run('email');
    expect(isEmailExport(result)).toBe(true);
    // Fresh database, nothing loaded — proves this is the REAL connector
    // reading a REAL (empty) SQLite file, not a canned fixture response.
    expect((result as { inbox: unknown[] }).inbox).toEqual([]);
    expect((result as { mode: string }).mode).toBe('simulation');

    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);
});
