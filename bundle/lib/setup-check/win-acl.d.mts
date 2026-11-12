/** Types for the Windows access-list reader (plain ESM; see win-acl.mjs). */
export interface AclEntry { principal: string; flags: Set<string>; rights: Set<string> }
export interface WindowsIdentity {
  ok: true;
  user: { name: string; sid: string };
  groups: { name: string; sid: string; state: 'enabled' | 'denyOnly' | 'unknown' }[];
}
export declare function parseIcacls(stdout: string, path: string): { ok: true; entries: AclEntry[] } | { ok: false };
export declare function parseWhoami(userCsv: string, groupsCsv: string): WindowsIdentity | { ok: false };
export declare function evaluateWrite(entries: AclEntry[], identity: WindowsIdentity): boolean | null;
export declare function hasOwnerRightsEntry(entries: AclEntry[]): boolean;
export declare function isOwnedBy(ownerSid: string, identity: WindowsIdentity): boolean;
