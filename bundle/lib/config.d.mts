/**
 * Types for the plain-ESM saved-config module.
 *
 * The module is .mjs because the CLI (plain JS, no build step) imports it
 * directly. TypeScript consumers — the tests — need declarations, and without
 * them a typecheck fails with TS7016 rather than checking anything (see
 * autostart-templates.d.mts for the established precedent).
 */

export declare const DEFAULT_AS_URL: string;

export interface SavedConfig {
  asUrl?: string;
  caFile?: string;
  pinTls?: boolean;
  pinTlsExpectedFingerprint?: string;
  simulation?: boolean;
  proxyUrl?: string;
}

export declare function readConfig(dataDir: string): SavedConfig;
export declare function writeConfig(dataDir: string, patch: SavedConfig): SavedConfig;

export interface AsUrlValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

export declare function validateAsUrl(candidate: string): AsUrlValidation;

export interface CaFileValidation {
  ok: boolean;
  path?: string;
  error?: string;
}

export declare function validateCaFile(candidate: string): CaFileValidation;

export interface ProxyUrlValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

export declare function validateProxyUrl(candidate: string): ProxyUrlValidation;

export declare function resolveAsUrl(dataDir: string): string;
export declare function resolveCaFile(dataDir: string): string | undefined;
export declare function resolveProxyUrl(dataDir: string): string | undefined;
export declare function resolveSimulation(dataDir: string): boolean;
