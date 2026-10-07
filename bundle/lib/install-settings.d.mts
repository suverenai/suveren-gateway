/**
 * Types for the plain-ESM install-settings module (ports + data folder).
 * See config.d.mts for why the .mjs modules carry declarations.
 */

export declare const DEFAULT_CP_PORT: number;
export declare const DEFAULT_MCP_PORT: number;
export declare function defaultDataDir(): string;

export declare function validatePort(candidate: unknown): { ok: true; port: number } | { ok: false; error: string };
export declare function validateDataDir(candidate: unknown): { ok: true; path: string } | { ok: false; error: string };

export interface SavedInstallSettings {
  cpPort?: string;
  mcpPort?: string;
  dataDir?: string;
}

export declare function installSettingsFilePath(): string | null;
export declare function installSettingsLocation(): string;
export declare function installSettingsRegistryKey(): string;
export declare function parseInstallSettingsRegQuery(stdout: string): SavedInstallSettings;
export declare function readInstallSettings(): SavedInstallSettings;
export declare function writeInstallSettings(patch: {
  cpPort?: number | null;
  mcpPort?: number | null;
  dataDir?: string | null;
}): void;

export type InstallSettingSource = 'policy' | 'env' | 'saved' | 'default';

export interface ResolvedInstallSettings {
  cpPort: number;
  mcpPort: number;
  dataDir: string;
  source: { cpPort: InstallSettingSource; mcpPort: InstallSettingSource; dataDir: InstallSettingSource };
  errors: string[];
}

export declare function resolveInstallSettings(opts?: { tolerant?: boolean }): ResolvedInstallSettings;
export declare function describeSource(source: InstallSettingSource, field: 'cpPort' | 'mcpPort' | 'dataDir'): string;
