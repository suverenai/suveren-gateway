/**
 * Tool-gating types — how an MCP tool call's arguments map to execution
 * context fields.
 *
 * These lived in @humanagencyp/hap-core through 0.11.x but were dropped in
 * 0.12 (the v0.7 wire release): hap-core is kept framework-agnostic (no
 * MCP/connector concepts), and this mapping is purely a Suveren gateway
 * mechanism — the manifest-to-executionContext contract tool-proxy.ts and
 * integration-manager.ts consume. It is now owned here instead.
 *
 * (The CONCEPT is still protocol-recognized — protocol.md -> *Tool-Gating
 * Manifests* describes the same `executionMapping`/`staticExecution`
 * contract — only the TypeScript shape moved out of the shared library.)
 */

/** How to transform an array-valued tool argument into one execution field. */
export type ExecutionMappingTransform = 'join' | 'join_domains' | 'length';

/**
 * Execution mapping value — how a tool argument maps to execution context field(s).
 * - string: direct copy (argName -> fieldName)
 * - { field, divisor }: numeric division (e.g., cents / 100 -> EUR)
 * - { field, transform }: array transform (e.g., join_domains)
 * - Array form: one argument maps to multiple execution fields
 */
export type ExecutionMappingValue =
  | string
  | { field: string; divisor: number }
  | { field: string; transform: ExecutionMappingTransform }
  | Array<{ field: string; divisor?: number; transform?: ExecutionMappingTransform }>;

/**
 * Tool gating entry — how a tool's calls map to execution context fields.
 * Read-only tools use { category: "read" } — they require authorization
 * but skip execution context verification.
 */
export interface ProfileToolGatingEntry {
  executionMapping: Record<string, ExecutionMappingValue>;
  staticExecution?: Record<string, string | number>;
  /** Read-only tools: require authorization but no execution context checks */
  category?: 'read';
}

/**
 * Profile-level tool gating configuration.
 * - default: applied to all tools not listed in overrides
 * - overrides: per-tool configs keyed by original MCP tool name
 *   Use { category: "read" } for read-only tools (null is deprecated)
 */
export interface ProfileToolGating {
  default: ProfileToolGatingEntry;
  overrides?: Record<string, ProfileToolGatingEntry | null>;
}
