/**
 * createConnectorExportRunner — a REAL child process is spawned here (a
 * fixture bin script standing in for an installed connector's shim), not a
 * mocked function: the module under test is the exec/PATH/env wiring, so
 * only the connector binary itself is replaced, the same spirit as
 * `ensure-installed-pin.test.ts`'s fake-npm.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createConnectorExportRunner, ConnectorExportError } from '../../src/lib/report/connector-export';

const FIXTURE_BIN_DIR = join(import.meta.dirname, 'fixtures', 'fake-connector-bin');

describe('createConnectorExportRunner', () => {
  it('spawns the real bin, passes HAP_DATA_DIR, and parses its JSON stdout', async () => {
    const run = createConnectorExportRunner({
      integrationsBinDir: FIXTURE_BIN_DIR,
      dataDir: '/tmp/suveren-test-data-dir',
      binNames: { email: 'fake-mcp', crm: 'fake-mcp', erp: 'fake-mcp' },
    });
    const result = await run('erp');
    expect(result).toEqual({ sawDataDir: '/tmp/suveren-test-data-dir', ok: true });
  });

  it('REFUSAL: a non-zero exit becomes a ConnectorExportError, not a silent empty result', async () => {
    const run = createConnectorExportRunner({
      integrationsBinDir: FIXTURE_BIN_DIR,
      dataDir: '/tmp/x',
      binNames: { email: 'failing-mcp', crm: 'failing-mcp', erp: 'failing-mcp' },
    });
    await expect(run('crm')).rejects.toThrow(ConnectorExportError);
  });

  it('REFUSAL: non-JSON stdout becomes a ConnectorExportError', async () => {
    const run = createConnectorExportRunner({
      integrationsBinDir: FIXTURE_BIN_DIR,
      dataDir: '/tmp/x',
      binNames: { email: 'bad-json-mcp', crm: 'bad-json-mcp', erp: 'bad-json-mcp' },
    });
    await expect(run('email')).rejects.toThrow(/did not print valid JSON/);
  });

  it('REFUSAL: a bin that is not on PATH at all fails loudly', async () => {
    const run = createConnectorExportRunner({
      integrationsBinDir: FIXTURE_BIN_DIR,
      dataDir: '/tmp/x',
      binNames: { email: 'does-not-exist-anywhere-mcp', crm: 'fake-mcp', erp: 'fake-mcp' },
    });
    await expect(run('email')).rejects.toThrow(ConnectorExportError);
  });
});
