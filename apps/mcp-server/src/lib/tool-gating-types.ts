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
 * Preview declaration (AU3) — a manifest's description of how an action
 * tool's approval card can show "what will happen" before it runs, by
 * calling a READ tool of the same integration with the action's own bound
 * arguments. Gateway-internal only: shown to the approver, never to the AI
 * or any MCP client, never ticketed, never read-gated.
 *
 * See `temp/briefs/au3-au5-brief.md` decisions 1–4 (binding) and the
 * "Interface contract" there — this shape is load-bearing for a UI built in
 * parallel against it; don't change field names without the owner.
 */
export interface ToolPreviewConfig {
  /** A tool of the SAME integration — the read tool called for the preview. */
  tool: string;
  /**
   * Preview-tool argument name -> name of the ACTION's argument whose value
   * is passed. Same direction as `executionMapping`: key = target (the
   * preview tool's arg), value = source (the action's arg). Only plain
   * top-level argument names.
   */
  args: Record<string, string>;
  /**
   * Optional staleness check for connectors with no document-version
   * enforcement of their own. `arg` is the ACTION argument carrying the
   * document version (bound like every arg); `field` is the top-level field
   * in the preview tool's structured result that holds the CURRENT version.
   */
  version?: { arg: string; field: string };
  /**
   * Optional top-level field allow-list, shown first and in this order on
   * the approval card's preview box, regardless of value (see
   * lib/preview-render.ts in apps/ui). Added after a real erp get_quote
   * answer (15 fields) showed that "first 6 in schema order" buries the
   * fields that actually matter (e.g. the quote's lines, its net total)
   * under "All fields" while surfacing id/status/currency. Without this,
   * every field that HAS a value is shown instead — still no fixed count,
   * but a connector with a field order that doesn't match what the approver
   * needs to see first should declare one.
   */
  fields?: string[];
}

/**
 * AU8 — one declared read within a multi-read preview list. Same shape as
 * {@link ToolPreviewConfig} plus `forEach`/`attach`; reads in a list run
 * SEQUENTIALLY (temp/briefs/au8-brief.md).
 */
export interface PreviewReadConfig {
  /** A tool of the SAME integration — the read tool called for this read. */
  tool: string;
  /**
   * Preview-tool argument name -> source argument name. Outside `forEach`,
   * the source names a top-level ACTION argument (same direction/meaning as
   * {@link ToolPreviewConfig.args}). Inside `forEach`, the source instead
   * names a FIELD of each element of the `forEach` action argument (e.g.
   * `item_id` on each element of `lines`) — never a top-level action arg.
   */
  args: Record<string, string>;
  /**
   * Run this read once per element of this action argument (which must
   * resolve to an array at call time — otherwise there is nothing to read,
   * same as `previewHasNoTarget`). Capped at `MAX_FOREACH_ELEMENTS`
   * elements; the rest are simply not read (over-cap is reported, not
   * refused — see planPreviewReads in preview.ts).
   */
  forEach?: string;
  /**
   * Names what this read's result resolves, so the UI can merge it into the
   * approval card instead of showing it as its own section:
   *  - outside `forEach`: one of THIS read's `args` source names — the bound
   *    action-arg value that read explains (shown as name+id instead of a
   *    raw id);
   *  - inside `forEach`: the key merged into each element, holding that
   *    element's read result.
   * Always explicit — never inferred from the read tool's own argument
   * names. Absent in either case -> shown as the read's OWN section (e.g. a
   * CRM duplicate-contact check).
   */
  attach?: string;
  /** Same meaning as {@link ToolPreviewConfig.version} — staleness check for
   *  THIS read only ("version stays per read where declared"). */
  version?: { arg: string; field: string };
  /** Same meaning as {@link ToolPreviewConfig.fields} — for THIS read only. */
  fields?: string[];
}

/** Manifest cap (temp/briefs/au8-brief.md) — a preview may declare at most
 *  this many reads. Validated at manifest-load time (manifest-loader.ts). */
export const MAX_PREVIEW_READS = 10;
/** Manifest cap — a `forEach` read runs for at most this many elements of
 *  the source array; the rest are reported, not refused (preview.ts). */
export const MAX_FOREACH_ELEMENTS = 50;

/**
 * AU8 — a tool's preview is either ONE read (the original AU3 shape, an
 * object — unchanged meaning and wire shape) or a LIST of reads run
 * sequentially (`PreviewReadConfig[]`, max {@link MAX_PREVIEW_READS}).
 */
export type PreviewDeclaration = ToolPreviewConfig | PreviewReadConfig[];

/**
 * AU8 — optional per-tool rendering hints, a sibling of `preview` on the
 * same override entry. Purely cosmetic: every field is optional, and its
 * absence falls back to schema-driven defaults (see
 * apps/ui/src/lib/preview-render.ts) — a manifest with no `display` at all
 * keeps working exactly as before. Paths use `<forEachArg>[].<field>` to
 * reach into a `forEach`/array field's own elements (e.g.
 * "lines[].list_price") — the field is looked up on the bound element
 * first, then on its attached read's result, so a path works whether the
 * field is bound or only known after the attached read.
 */
export interface ToolDisplayHints {
  /** Top-level (bound) field order for the combined card, e.g.
   *  `["customer_id", "lines", "discount_pct", "value"]`. Fields not listed
   *  are appended afterward, in their own declared order. */
  order?: string[];
  /** Paths rendered as money (two decimals, with the `currencyField`'s
   *  value, e.g. "385.00 EUR"). */
  money?: string[];
  /** The bound action-arg name holding the currency code for `money` paths. */
  currencyField?: string;
  /** Paths rendered as a percentage, e.g. "0 %". */
  percent?: string[];
  /** Paths never shown. */
  hidden?: string[];
}

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
  /** AU3/AU8 — see {@link ToolPreviewConfig} / {@link PreviewReadConfig}. */
  preview?: PreviewDeclaration;
  /** AU8 — see {@link ToolDisplayHints}. */
  display?: ToolDisplayHints;
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
