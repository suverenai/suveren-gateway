/**
 * Runs a simulator connector's own `export` CLI and returns its parsed JSON.
 *
 * Deliberately NOT a database read: the gateway has no SQLite client and must
 * not grow one just to read a report (work-plan "evidence-backed reports",
 * progress note 2026-10-05: "the gateway opens no SQLite itself — no native
 * modules"). `erp-mcp`/`crm-mcp`/`email-mcp` each ship a local operator
 * command — `<bin> export` — that is NOT an MCP tool (so the agent under
 * test can never reach it) and prints the connector's own authoritative
 * export as JSON on stdout (hap-erp-mcp/hap-crm-mcp/hap-email-mcp
 * `src/cli.ts`, read 2026-10-05). This module shells out to exactly that,
 * the same way `integration-manager.ts` spawns these same connectors as MCP
 * servers: same `SUVEREN_INTEGRATIONS_DIR/node_modules/.bin` on PATH, same
 * `HAP_DATA_DIR` the connector's `db.ts` reads its SQLite path from.
 *
 * `erp-mcp`/`crm-mcp`/`email-mcp` only run their CLI branch when invoked with
 * extra argv (`index.ts`: "argv.length > 2" -> runCli, else start the MCP
 * server) — passing exactly `['export']` here is what selects that branch.
 */
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import type { ExportSystem, RunConnectorExport } from './types';

const DEFAULT_BIN_NAMES: Record<ExportSystem, string> = {
  email: 'email-mcp',
  crm: 'crm-mcp',
  erp: 'erp-mcp',
};

export interface ConnectorExportConfig {
  /** `SUVEREN_INTEGRATIONS_DIR/node_modules/.bin` — where the connector's
   *  installed bin shim lives (see integration-manager.ts `INTEGRATIONS_BIN`). */
  integrationsBinDir: string;
  /** `HAP_DATA_DIR` — the gateway's `SUVEREN_DATA_DIR`, the same value
   *  integration-manager.ts injects when it spawns these connectors as MCP
   *  servers, so `<bin> export` reads the SAME SQLite file the live
   *  connector writes to. */
  dataDir: string;
  /** Override a system's bin name — tests only; production uses each
   *  connector's real published bin name. */
  binNames?: Partial<Record<ExportSystem, string>>;
  timeoutMs?: number;
}

export class ConnectorExportError extends Error {
  constructor(message: string, public readonly system: ExportSystem, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConnectorExportError';
  }
}

function execFileAsync(
  command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; shell: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Builds the real `RunConnectorExport` the report verifier is given in
 * production. Kept separate from `verifyReport` itself (which only takes the
 * already-built function via `ReportSources.runExport`) so every other path
 * — all unit tests, and the gateway's actual report tool once it exists — can
 * supply whatever implementation fits without this module caring which.
 */
export function createConnectorExportRunner(config: ConnectorExportConfig): RunConnectorExport {
  return async (system: ExportSystem): Promise<unknown> => {
    const bin = config.binNames?.[system] ?? DEFAULT_BIN_NAMES[system];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [config.integrationsBinDir, process.env.PATH ?? ''].join(delimiter),
      HAP_DATA_DIR: config.dataDir,
    };

    let stdout: string;
    try {
      // `shell: true` only on Windows, where the installed shim is a `.cmd`
      // file node's `execFile` cannot exec directly. Safe here specifically
      // because `bin` comes from the closed, fixed `DEFAULT_BIN_NAMES` set
      // (or an equally fixed test override) and the only argument is the
      // literal string "export" — neither is ever user- or AI-controlled, so
      // there is nothing for shell interpolation to exploit (contrast
      // integration-manager.ts's CVE-2024-27980 note, which is about NOT
      // using a shell when arguments ARE externally influenced).
      const result = await execFileAsync(bin, ['export'], {
        env,
        timeout: config.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === 'win32',
      });
      stdout = result.stdout;
    } catch (err) {
      throw new ConnectorExportError(
        `${bin} export failed: ${err instanceof Error ? err.message : String(err)}`,
        system,
        err,
      );
    }

    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new ConnectorExportError(
        `${bin} export did not print valid JSON on stdout`,
        system,
        err,
      );
    }
  };
}
