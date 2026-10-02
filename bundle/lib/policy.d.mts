/**
 * Types for the plain-ESM managed-settings policy module.
 *
 * The module is .mjs because the CLI (plain JS, no build step) imports it
 * directly. TypeScript consumers — the tests — need declarations, and
 * without them a typecheck fails with TS7016 rather than checking anything
 * (see config.d.mts for the established precedent).
 */

export type PolicyKey = 'asUrl' | 'caFile' | 'pinTls' | 'simulation' | 'installMethod';

export interface GatewayPolicy {
  asUrl?: string;
  caFile?: string;
  pinTls?: boolean;
  simulation?: boolean;
  installMethod?: 'managed';
}

export interface ResolvedPolicy {
  policy: GatewayPolicy;
  /** Keys present in policy — these are LOCKED: the employee cannot
   *  override them locally. */
  locked: Set<PolicyKey>;
}

export declare function parseRegQueryOutput(stdout: string): Record<string, string | number>;
export declare function registryKeyPath(hive: 'HKLM' | 'HKCU'): string;
export declare function policyFilePath(): string;
export declare function readPolicy(): ResolvedPolicy;
export declare function isPolicyLocked(key: PolicyKey): boolean;
export declare function _resetPolicyCacheForTests(): void;
