/**
 * Types for the Setup check engine (plain ESM — the CLI imports it without a
 * build step; TypeScript consumers are the tests). See engine.mjs's header.
 */
export type CheckResult = 'closed' | 'open' | 'cannot tell';
export type GroupId = 'route' | 'secrets' | 'gateway';

export interface Finding {
  group: GroupId;
  result: CheckResult;
  subject: string;
  detail: string;
  source: string;
}

export type ReadResult = { ok: true; text: string } | { missing: true; ok?: undefined } | { error: string; ok?: undefined };
export type RunResult = { ok: true; stdout: string } | { error: string; ok?: undefined; status?: number | null; reason?: string };
export type ProcessList = { ok: true; commands: string[]; source?: string } | { error: string; ok?: undefined; reason?: string };
export type DataResult = { ok: true; data: unknown } | { missing: true; ok?: undefined } | { error: string; ok?: undefined };

export interface CheckIo {
  readText(path: string): ReadResult;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  list(dir: string): string[] | null;
  /** true = can write, false = cannot, null = cannot tell. */
  writable(path: string): boolean | null;
  nearestCreatable(path: string): { ancestor: string | null; writable: boolean | null };
  ownerUid(path: string): number | null;
  ps(): ProcessList;
  groups(): RunResult;
  plist(path: string): DataResult;
  registry(key: string): DataResult;
}

export interface GatewayFacts {
  version?: string;
  simulation?: boolean | null;
  dataDir?: string;
  programDir?: string;
  policy?: {
    locked?: string[];
    /** Which source each locked key came from (policy.mjs readPolicy().sources). */
    sources?: Record<string, 'HKLM' | 'HKCU' | 'file'>;
    file?: string;
    fileExists?: boolean;
    registry?: string | null;
    machineRegistryKey?: string | null;
    userRegistryKey?: string | null;
    error?: boolean;
  };
  serviceDefinitionText?: string | null;
  serviceDefinitionPath?: string | null;
  inContainer?: boolean;
  settingsErrors?: number;
  installSettingsLocation?: string;
}

export interface CheckContext {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  root?: string;
  now?: Date;
  uid?: number | null;
  mcpPort: number;
  io: CheckIo;
  apps?: AppDescription[];
  credentialFiles?: unknown[];
  gateway: GatewayFacts;
  notes?: string[];
}

export type AppDescription = Record<string, unknown> & { id: string; name: string };

export interface CheckReport {
  date: Date;
  gateway: { version: string; simulation: boolean | null; mcpPort: number };
  aiAppsFound: { id: string; name: string }[];
  locations: { app: string; role: 'user' | 'lock'; location: string; present: boolean; verified: boolean; verifiedNote: string | null }[];
  findings: Finding[];
  confirmByHand: string[];
  notes: string[];
  summary: { open: number; closed: number; cannotTell: number };
  exitCode: 0 | 1;
}

export declare const RESULTS: { CLOSED: 'closed'; OPEN: 'open'; CANNOT_TELL: 'cannot tell' };
export declare const GROUPS: readonly { id: GroupId; title: string }[];
export declare const GATEWAY_HOSTS: string[];
export declare const CONFIRM_BY_HAND: string[];
export declare function unverifiedNote(unverified: number, total: number): string | null;
export declare function formatDate(d: Date): string;
export declare function programLabel(command: string, secretValues: string[]): string;
export declare function resolveAppLocations(ctx: CheckContext, app: AppDescription): { detect: string[]; sources: Record<string, string> };
export declare function runSetupCheck(ctx: CheckContext): CheckReport;
