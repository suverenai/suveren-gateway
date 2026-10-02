/**
 * Types for the plain-ESM Node version check (see config.d.mts for why the
 * .mjs modules ship declarations).
 */

export declare const MIN_NODE_MAJOR: number;
export declare function unsupportedNodeReason(version: string): string | null;
