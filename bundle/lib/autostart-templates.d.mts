/**
 * Types for the plain-ESM autostart templates.
 *
 * The module is .mjs because the CLI (plain JS, no build step) imports it
 * directly. TypeScript consumers — the tests — need declarations, and without
 * them a typecheck fails with TS7016 rather than checking anything.
 */
export declare function escapeXml(value: unknown): string;
export declare function shellQuote(value: unknown): string;

export declare function buildLaunchAgentPlist(opts: {
  launcherPath: string;
  label: string;
  logFile: string;
  dataDir?: string;
  path?: string;
}): string;

export declare function buildMacLauncher(opts: {
  nodePath: string;
  serverEntry: string;
}): string;

export declare function buildSystemdUnit(opts: {
  nodePath: string;
  serverEntry: string;
  logFile: string;
  dataDir?: string;
  path?: string;
}): string;

export declare function buildWindowsTaskXml(opts: {
  nodePath: string;
  serverEntry: string;
  author: string;
  dataDir?: string;
  /** `DOMAIN\\user`. Omitting it registers an any-user task, which needs admin. */
  userId?: string;
}): string;
