/** Types for the plain-ESM macOS system-install plan (S1). See system-install-mac.mjs. */
export declare const ACCOUNT_NAME: string;
export declare const DAEMON_LABEL: string;
export declare const AGENT_LABEL: string;
export declare const ID_RANGE: { min: number; max: number };
export declare const DAEMON_PATH: string;

export interface SystemLayout {
  nodeDir: string; nodeBinDir: string; agentPin: string; agentSocket: string; brokerBinary: string; codeRoot: string; codeDir: string; currentLink: string; nodeBinary: string; serverEntry: string;
  settingsDir: string; settingsFile: string; dataDir: string; logDir: string; logFile: string;
  runDir: string; daemonPlist: string; agentPlist: string;
}
export declare function buildLayout(opts: { version: string; prefix?: string }): SystemLayout;
export declare function parseDsclIds(text: string): number[];
export declare function pickFreeId(usedIds: number[], range?: { min: number; max: number }): number;

export type PlanStep =
  | { kind: 'run'; argv: string[] }
  | { kind: 'mkdir'; path: string; owner: string; mode: string }
  | { kind: 'copy'; from: string; to: string; owner: string; mode: string }
  | { kind: 'write'; path: string; content: string; owner: string; mode: string }
  | { kind: 'symlink'; path: string; target: string }
  | { kind: 'remove'; path: string };

export declare function buildAccountSteps(opts: { id: number; name?: string }): PlanStep[];
export declare function buildDaemonPlist(opts: { layout: SystemLayout; account?: string }): string;
export declare function buildSettingsJson(opts: { layout: SystemLayout; cpPort: number; mcpPort: number }): string;
export declare function buildFileManifest(dir: string): Record<string, string>;
export declare function diffManifests(
  expected: Record<string, string>,
  actual: Record<string, string>,
): { missing: string[]; extra: string[]; changed: string[]; ok: boolean };
export declare function checkPreconditions(opts: { platform: string; uid: number; isAdmin: boolean }): string[];
export declare function buildInstallPlan(opts: {
  version: string; packageDir: string; node: NodeDistribution; brokerBinary?: string; agent?: AgentPin; freeId: number;
  cpPort: number; mcpPort: number; prefix?: string; account?: string;
}): { layout: SystemLayout; steps: PlanStep[] };
export declare function renderPlan(plan: { steps: PlanStep[] }): string;
export declare function buildUpdatePlan(opts: { version: string; packageDir: string; node: NodeDistribution; brokerBinary?: string; agent?: AgentPin; prefix?: string }): { layout: SystemLayout; steps: PlanStep[] };
export declare function buildUninstallPlan(opts: { prefix?: string; removeData?: boolean; account?: string }): { layout: SystemLayout; steps: PlanStep[] };
export interface NodeDistribution { binary: string; npmDir: string }
export declare function resolveNodeDistribution(execPath: string, opts?: { realpath?: (p: string) => string; exists?: (p: string) => boolean }): NodeDistribution;
export declare function nodeLinkProblems(otoolOutput: string): string[];
export declare const AGENT_IDENTIFIER: string;
export interface AgentPin { identifier?: string; cdhash: string }
export declare function parseCdhash(codesignOutput: string): string;
export declare function buildPinJson(pin: AgentPin): string;
