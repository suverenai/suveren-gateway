/**
 * Types for the Setup check's minimal TOML reader (plain ESM, imported by the
 * CLI without a build step; TypeScript consumers are the tests).
 */
export declare class TomlLiteError extends Error {
  line: number;
}
export declare function parseTomlLite(text: string): Record<string, unknown>;
