export declare function systemMarkers(prefix?: string): { plist: string; settings: string; logFile: string };
export declare function detectSystemInstall(opts?: { prefix?: string; exists?: (path: string) => boolean }): boolean;
export declare function thinCliRefusal(argv: string[], opts?: { prefix?: string }): { code: number; lines: string[] } | null;
