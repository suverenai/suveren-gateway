/** Types for the plain-ESM profile pin (see profiles-lock.mjs). */

export interface ProfilesLock {
  repository: string;
  commit: string;
  files: Record<string, string>;
}

export declare function sha256OfFile(path: string): string;
export declare function readLock(lockPath: string): ProfilesLock;
export declare function verifyProfilesAgainstLock(dir: string, lock: ProfilesLock): string[];
export declare function lockedFiles(lock: ProfilesLock): string[];
export declare function buildLock(args: { repository: string; commit: string; dir: string; files: string[] }): ProfilesLock;
