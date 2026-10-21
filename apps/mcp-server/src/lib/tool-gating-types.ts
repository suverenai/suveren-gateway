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
  /** D2 — see {@link PreviewReadConfig.when}. */
  when?: string;
  /** See {@link PreviewReadConfig.displayOnly}. */
  displayOnly?: boolean;
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
  /**
   * Declares that this read's structured result IS a document to render,
   * not data to merge into field rows — the shape
   * `{ filename, contentType, contentBase64, sha256, pages? }` a
   * connector's own internal read answers with (e.g. the ERP connector's
   * `preview_invoice`/`get_document` — see suveren-invoicing-plan.md §7).
   * The UI (apps/ui/src/lib/preview-render.ts) renders a read declaring
   * this as the sealed "document as it will be issued" box (UI spec
   * §15.1) instead of a generic field table — shape-checked at render
   * time, so a read that doesn't actually answer with that shape degrades
   * to a plain note, never a crash. Meaningful only on a read with no
   * `attach`/`forEach` (an own-section read); the loader does not cross-
   * check that, same as `attach` and `forEach` are mutually exclusive by
   * construction rather than by a validated rule.
   */
  kind?: 'document';
  /**
   * D2 — run this read only when this path is present (not undefined, null,
   * "", [] or false). Outside `forEach` it names an ACTION argument (dotted
   * into it, e.g. `"uid"`); inside `forEach` it names a FIELD of each element
   * (e.g. `"item_id"`). Absent → the read is not called and attaches nothing
   * (outcome `none` / `no_target`) — never a read with missing args.
   */
  when?: string;
  /**
   * Display-only read: its result is shown on the card (and checks may read
   * it) but it is EXCLUDED from the AU4 "changed since approval" hash. For a
   * read whose answer is volatile by nature (a live register lookup that
   * carries its own time and consultation id) — the connector re-runs that
   * check itself at execution and stores its own result, so comparing two
   * answers would refuse every approval. Never set this on a read that shows
   * the record the action changes; that is what `version` / the hash protect.
   */
  displayOnly?: boolean;
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
  /**
   * Paths rendered as money (two decimals, with the resolved `currencyField`
   * value, e.g. "385.00 EUR"). Accepts an attached read's own field too
   * (`"customer_id.credit_limit"`, `"lines[].item.list_price"`) — see
   * `labels`' doc comment for the full path grammar.
   */
  money?: string[];
  /**
   * The currency for every `money` path in this block — either a plain
   * bound action-arg name (`"currency"`) or a dotted path into a NON-
   * forEach attach's own field (`"customer_id.currency"`).
   */
  currencyField?: string;
  /** Paths rendered as a percentage, e.g. "0 %". Same path grammar as `money`. */
  percent?: string[];
  /** Paths never shown. Same path grammar as `money`. */
  hidden?: string[];
  /**
   * AU8 follow-up (2026-10-13) — the manifest is the one place for display,
   * for Suveren's own AND third-party connectors: a field path -> its
   * readable label. A connector's own JSON Schema `title` (the read's
   * `outputSchema`, when declared) is only a fallback when the manifest
   * says nothing here; a humanized key is the last fallback.
   *
   * Path grammar (shared by `labels`/`money`/`percent`/`hidden`):
   *   - `"<key>"`                 a top-level bound field, e.g. `"customer_id"`
   *   - `"<key>.<subKey>"`        a field of a NON-forEach attach's own read,
   *                               e.g. `"customer_id.credit_limit"`
   *   - `"<key>[].<elementField>"` a `forEach` field's own bound element
   *                               field, e.g. `"lines[].qty"`
   *   - `"<key>[].<attach>"`      a `forEach`'s attach IDENTITY column
   *                               itself (labels only), e.g. `"lines[].item"`
   *   - `"<key>[].<attach>.<sub>"` a field of a `forEach` attach's own read,
   *                               e.g. `"lines[].item.list_price"`
   */
  labels?: Record<string, string>;
  /**
   * UI spec §15.2/§15.3 — names THIS tool's own argument whose value is
   * text the AI itself wrote (e.g. mail/gmail's `send_message` ->
   * `"body"`). The approval/ticket card shows it in its own amber
   * "Text — written by the AI" box, separate from the sealed recipients/
   * subject/attachment boxes (HIDDEN from the generic arg table the same
   * way `_attachmentsSealed` is — see apps/ui/src/lib/approval-view.ts).
   * The value is still sealed (content-binding hashes it like every other
   * bound field) — this only changes WHERE it is shown, never whether it
   * is bound. At most one field per tool; a tool with no AI-authored text
   * argument simply omits this.
   */
  aiText?: string;
}

/**
 * AU10 — per-tool declaration of which action args identify "the customer"
 * (doc/au10-request-context.md §2). Key = either one of the connector's own
 * `context.recordKeys` entry names, or a direct identity key type (`email`);
 * value = the action's own argument name carrying that id/email. Resolved
 * generically by request-context.ts — never a hardcoded field name.
 */
export type ContextKeysDeclaration = Record<string, string>;

/**
 * AU10 — declares that this tool's call ALREADY carries a reference to the
 * request it answers (e.g. `send_message.in_reply_to`), so no `_source` is
 * needed from the AI. `kind` must be one the SAME connector's
 * `context.sources` declares; `arg` is the action's own argument holding the
 * id.
 */
export interface SourceFromArgDeclaration {
  kind: string;
  arg: string;
}

/**
 * Tool gating entry — how a tool's calls map to execution context fields.
 * Read-only tools use { category: "read" } — they require authorization
 * but skip execution context verification.
 */
export interface ProfileToolGatingEntry {
  executionMapping: Record<string, ExecutionMappingValue>;
  staticExecution?: Record<string, string | number>;
  /**
   * Area per tool — a connector may span several profiles (e.g. an ERP's
   * sales AND invoicing tools). When set, THIS tool is gated under this
   * profile instead of the manifest's own `profile`. Must resolve (full id
   * or short name) to a known profile — validated at manifest-load time
   * (manifest-loader.ts's `invalidManifestOverrideProfilesReason`) and
   * covered by the D6 read-gate check for ITS OWN profile, not the
   * manifest's (manifest-loader.ts's `invalidManifestReadGateReason`).
   * Every consumer that reads a tool's governing profile must read it off
   * the tool's OWN resolved `ToolGatingConfig.profile`
   * (integration-manager.ts's `resolveToolGating`), never off
   * `manifest.profile` directly — see tool-proxy.ts, mandate-brief.ts,
   * agent-visibility.ts, receipt-footer.ts, tools/authorizations.ts,
   * tools/integrations.ts.
   */
  profile?: string;
  /** Read-only tools: require authorization but no execution context checks */
  category?: 'read';
  /** AU3/AU8 — see {@link ToolPreviewConfig} / {@link PreviewReadConfig}. */
  preview?: PreviewDeclaration;
  /** AU8 — see {@link ToolDisplayHints}. */
  display?: ToolDisplayHints;
  /** AU10 — see {@link ContextKeysDeclaration}. */
  contextKeys?: ContextKeysDeclaration;
  /** AU10 — see {@link SourceFromArgDeclaration}. */
  sourceFromArg?: SourceFromArgDeclaration;
  /**
   * Marks this tool INTERNAL — never listed in `tools/list`, never
   * callable directly by the AI. Enforced the same way a built-in's own
   * internal preview tools are (builtin-integration.ts's
   * `BuiltinTool.internal`): the gateway never registers it with the MCP
   * server (index.ts) and `tool-proxy.ts` refuses a direct call as a
   * second, independent check. The gateway itself may still call it
   * directly through `IntegrationManager.callTool` — e.g. a document-
   * preview read another tool's `preview` declares (see
   * {@link PreviewReadConfig.kind}) — this flag only blocks the AI-facing
   * path, same as `category:'disabled'` blocks every path.
   *
   * Exempted from the D6 read-gate coverage check (read-gate.ts's
   * `uncoveredReadSwitchReason`): an AI can never reach this tool to begin
   * with, so the enum-switch concern that check exists for does not
   * apply, and requiring a `boundField` on it would be meaningless.
   */
  internal?: boolean;
  /**
   * Names THIS tool's own argument that carries attachment references
   * (`DocumentReference[]`, never bytes) — e.g. mail/gmail's `send_message`
   * declares `attachmentsArg: "attachments"`. Validated at manifest-load
   * time against the SAME manifest's top-level `attachments` transport
   * declaration (manifest-loader.ts) — a tool cannot declare this without
   * its connector saying how it receives files. The AI-facing schema for
   * this argument is narrowed to `{connector, kind, id}` objects only
   * (attachment-reference.ts); the gateway resolves each reference, seals
   * its fingerprint, and builds the transport-specific outgoing payload
   * (tool-proxy.ts) before the downstream call.
   */
  attachmentsArg?: string;
  /**
   * Names THIS tool's own text argument(s) eligible for `{{placeholder}}`
   * substitution via a sibling `insert` argument (insert-values.ts) — e.g.
   * `["body"]`. A placeholder in a listed field with no matching `insert`
   * entry, or an `insert` entry whose placeholder is absent from every
   * listed field, is refused (insert-values.ts's `applyInserts`). The
   * substituted text is what gets content-bound/sealed — insertion always
   * runs BEFORE the profile's `content_binding` is computed.
   */
  insertFields?: string[];
  /**
   * Declares THIS tool as a human-readable "message" — see
   * {@link MessageGatingDeclaration}. Generic across connectors: nothing
   * profile- or connector-specific reads for this in code, only the manifest.
   */
  message?: MessageGatingDeclaration;
  /**
   * READ tools only: further areas (profiles, short names) whose mandates may
   * also authorize this read — e.g. an ERP's customer lookup is needed for
   * invoicing as much as for sales. Any complete mandate of the tool's own
   * area OR of one of these, satisfying the read gate, covers the call.
   * Refused at manifest load on a non-read tool and on a read with a `read`
   * adapter (an age window resolved from mixed profiles could weaken it).
   */
  readAlsoUnder?: string[];
  /** D1 — see {@link CheckDeclaration}. Evaluated by checks.ts for the card. */
  checks?: CheckDeclaration[];
}

// ─── D1 — manifest-declared checks (ERP local-production contract §7.2) ────

/** A check's outcome. `fail` is the only one the card shows in red. */
export type CheckStatus = 'pass' | 'fail' | 'notice' | 'not_checked';
export const CHECK_STATUSES: readonly CheckStatus[] = ['pass', 'fail', 'notice', 'not_checked'];
/** Manifest cap — at most this many checks per tool (validated at load). */
export const MAX_CHECKS_PER_TOOL = 12;

export type CheckValue = string | number | boolean | null;

/** A check's conditional form: applies only when the value at `path` is one of `in`. */
export interface CheckWhen {
  path: string;
  in: CheckValue[];
}

/**
 * One check a tool's approval card shows on its checks line, after the
 * limit checks. Evaluated by the GATEWAY over the call's bound arguments plus
 * the preview reads it ran itself — never supplied by the AI. A path that
 * goes through a read's `attach` name (`uid.vies.status`,
 * `lines[].item.list_price`) is read ONLY from that read's answer, never from
 * an argument of the same name. Generic: no connector or profile name in code.
 *
 * Path grammar: `a`, `a.b.c` (an argument, or `<attach>.<field>` of a
 * non-forEach read), `a[].b.c` (inside `forEach: "a"`: the element's own
 * field, or `<attach>.<field>` of a forEach read over `a`).
 */
export interface CheckDeclaration {
  /** Unique per tool. */
  key: string;
  /** ≤ 80 chars — what is checked, in the UI spec's wording. */
  label: string;
  /** The value under test. */
  path: string;
  /**
   * Applies only if this path is present (not undefined/null/""/[]/false) —
   * or, in the object form, only if the value at `path` is one of `in`
   * (e.g. a VIES check that matters only for a reverse-charge customer).
   */
  when?: string | CheckWhen;
  /** One result per element of this array argument (`{#}` = its 1-based position). */
  forEach?: string;
  /** Value-matching form — a value in no list → `not_checked` ("unexpected value"). */
  pass?: CheckValue[];
  fail?: CheckValue[];
  notice?: CheckValue[];
  notChecked?: CheckValue[];
  /** Comparison form — `to` is a path, or a number literal. */
  compare?: { op: 'eq' | 'ne' | 'gt' | 'lt'; to: string | number };
  /** For `compare` — defaults `pass` / `fail`. */
  onTrue?: CheckStatus;
  onFalse?: CheckStatus;
  /** Path absent or its read unavailable: no line (`skip`, default) or a `not_checked` line. */
  missing?: 'skip' | 'not_checked';
  /** Summary grammar (`{path|money}`, `[optional]`, `{#}`), rendered after the label. */
  detail?: string;
  /**
   * A `fail` of this check refuses the call before any card or proposal is
   * made (tool-proxy.ts, the same refusal path as a bounds refusal), with
   * the label + detail as the reason. `not_checked`, `notice` and `pass`
   * never block. For checks whose failure no approver could rightly
   * override (e.g. a register says an identifier is invalid).
   */
  blocking?: boolean;
}

/** A check's evaluated line (checks.ts → the approval card). */
export interface CheckResult {
  key: string;
  label: string;
  status: CheckStatus;
  /** 1-based element position, for a `forEach` check. */
  index?: number;
  /** The rendered `detail`, when declared and complete. */
  detail?: string;
  /** Why it is `not_checked` when the gateway itself decided so (missing / unexpected value). */
  reason?: string;
  /** Declared `blocking` — a `fail` refuses the call (never reaches a card). */
  blocking?: true;
  /** The value tested, when it is a plain value (string/number/boolean/null). */
  value?: CheckValue;
}

// ─── D3 — outside calls a connector makes (R5) ────────────────────────────

/**
 * Manifest top-level `network` entry: an outside host a connector calls in
 * the given modes (`modes` keyed like `modeLabels`: mode → adapter values, or
 * `true` for every adapter; absent = every mode). Shown on the connector's
 * settings as "Asks <host> — <purpose>. Sends: <sends>." The gateway does not
 * proxy or police the call; it makes the promise visible.
 */
export interface NetworkDeclaration {
  modes?: Record<string, string[] | true>;
  host: string;
  purpose: string;
  sends: string;
}

/**
 * Presentation verb for a message's footer leading word — a post is
 * "Published", everything else (email, a calendar invite) is "Sent".
 */
export type MessageVerb = 'Sent' | 'Published';

/**
 * A tool's own declaration of which arguments carry a human-readable
 * message — the generic replacement for what used to be hardcoded per
 * profile/connector in receipt-footer.ts and attachment-resolution.ts:
 *
 *  - `text` is the argument the verification footer appends its line to
 *    (receipt-footer.ts), and is ALSO the field content-binding's
 *    `kind:"text"` hashes when the profile declares no `contentField`
 *    override (content-binding.ts's `detectContentField`) — one resolver,
 *    so the footer and the receipt can never disagree about which text was
 *    authorized.
 *  - `to`/`cc`/`subject`, when this connector's `attachments` transport is
 *    `"mime-raw"`, are the arguments `finalizeAttachmentsForExecution`
 *    (attachment-resolution.ts) reads to build the outgoing MIME message —
 *    a mime-raw tool with attachments and no `to`+`text` declared here is
 *    refused rather than guessing field names.
 *  - `verb` is the footer's presentation verb for this tool ("Sent"/
 *    "Published").
 *
 * A tool with no human-readable text at all (a delete, a read) simply omits
 * `message` — no footer, no content-binding auto-detection, same as before
 * this existed.
 */
export interface MessageGatingDeclaration {
  /** This tool's own argument holding the human-readable text, e.g. "body", "text", "description". */
  text: string;
  /** This tool's own argument holding the recipient list, if any. */
  to?: string;
  /** This tool's own argument holding the cc list, if any. */
  cc?: string;
  /** This tool's own argument holding the subject line, if any. */
  subject?: string;
  /** Presentation verb for the footer's leading word. */
  verb: MessageVerb;
}

// ─── Documents, attachments-by-reference, inserted values ─────────────────
// (suveren-invoicing-plan.md §6/§7 — "Email with an attachment"). Generic
// across connectors: a manifest declares WHAT it can provide (a document
// kind, a value kind) or HOW it receives files (its attachments transport);
// the gateway resolves AI-supplied references against these declarations.
// Never a tool/connector name in the resolution code — only in the manifest.

/**
 * One document kind a connector can hand the gateway — e.g. the ERP's
 * `invoice-pdf`/`credit-note-pdf`, read through its OWN internal tool (never
 * AI-callable — the declared `tool` MUST carry `internal: true` on this same
 * manifest's `toolGating.overrides`, checked at load time). `args` follows
 * the SAME `$`-prefixed substitution grammar `context.recordKeys`/`sources`
 * reads already use (request-context.ts's `substitute`): a literal string is
 * passed as-is, a token starting with `$` is replaced with the reference's
 * own field of that name — today only `$id` (the reference's `id`). The read
 * must answer `{ filename, contentType, contentBase64, sha256 }` (document-
 * source.ts shape-checks this and recomputes `sha256` itself — a connector's
 * own claim is never trusted blind).
 */
export interface DocumentSourceConfig {
  tool: string;
  args: Record<string, string>;
  /**
   * UI spec §15.2 — what the approval/ticket card calls this document in
   * the "from <connector> — <label>" line (e.g. `"issued invoice {id}"`,
   * `"issued credit note {id}"`). The ONLY placeholder is `{id}` (the
   * reference's own `id`, braces not `$`-prefixed — a display template,
   * never fed through the `args` read-substitution grammar). Optional: a
   * document kind with no `label` just gets no "same file as issued..."
   * checks-line entry and no source line beyond "from <connector>" (see
   * apps/ui/src/lib/attachment-sealed.ts `documentLabel`).
   */
  label?: string;
}

/** Manifest top-level `documents` — kind name -> how to read it. */
export type ManifestDocuments = Record<string, DocumentSourceConfig>;

/**
 * How THIS connector (an email sender) receives attachment bytes on an
 * outgoing message — declared once per connector, used by every tool of
 * that connector that accepts attachments (today exactly one, the send
 * tool). `arg` is the connector's OWN tool argument name:
 *   - `"field"` — the connector takes a structured `attachments` array
 *     argument directly (simulated mail: `[{filename, contentType,
 *     contentBase64}]`).
 *   - `"mime-raw"` — the connector has no attachments argument at all; the
 *     gateway builds a complete MIME message itself (mime-message.ts) and
 *     passes it base64url-encoded in `arg` (Gmail: `raw`).
 */
export interface AttachmentTransportConfig {
  transport: 'field' | 'mime-raw';
  arg: string;
}

/**
 * One value kind a connector can hand the gateway to insert into an action's
 * own text (e.g. Mollie's `payment-link`) — read through `tool`/`args` (same
 * substitution grammar as {@link DocumentSourceConfig}), then picked out of
 * the read's structured result at the dotted `path`. `allowedHosts` is the
 * ONLY thing the gateway trusts without re-deriving: the value must be an
 * `https://` URL whose host is exactly one of these, or a subdomain of one —
 * the whole point of insertable values is that the AI can never type the
 * value itself, so a connector claiming a URL on a host it doesn't own would
 * be the one way around that.
 */
export interface InsertValueSourceConfig {
  tool: string;
  args: Record<string, string>;
  path: string;
  allowedHosts: string[];
}

/** Manifest top-level `values` — kind name -> how to read + validate it. */
export type ManifestValues = Record<string, InsertValueSourceConfig>;

/**
 * An attachment or insert reference the AI supplies — a POINTER only, never
 * bytes or a typed value. Exactly these three string fields; anything else
 * (e.g. `contentBase64`, `raw`) on the SAME object is refused by
 * attachment-reference.ts's shape check, not silently dropped.
 */
export interface DocumentReference {
  connector: string;
  kind: string;
  id: string;
}

/** An insert reference additionally names which placeholder it fills. */
export interface InsertReference extends DocumentReference {
  placeholder: string;
}

// ─── AU10 §8.1 — field helpers (doc/au10-request-context.md §8.1) ─────────

/**
 * How a `FieldPath`'s `parse` reshapes the picked value.
 *  - `address.name` / `address.email`: RFC 5322 `"Name" <a@b>` or a bare
 *    address — `address.name` is undefined for a bare address.
 *  - `epoch-ms`: milliseconds since 1970, as a number or a numeric string,
 *    turned into an ISO timestamp string (the shape every other `at` field
 *    already uses).
 */
export type FieldPathParse = 'address.name' | 'address.email' | 'epoch-ms';

/**
 * AU10 §8.1 — wherever a field mapping is a dotted path (`title`, `author`,
 * `at`, `body`, `keys.*`, history `item.*`), it may instead be this object:
 * read `path` (as a plain string path would), optionally narrow a LIST
 * result to the first element matching every `where` field (case-
 * insensitive for strings — e.g. Gmail's `payload.headers`, a list of
 * `{name, value}`), optionally `pick` one field of that element, optionally
 * `parse` the result. Generic — no connector name in code.
 */
export interface FieldPathObject {
  path: string;
  where?: Record<string, string | number | boolean>;
  pick?: string;
  parse?: FieldPathParse;
}

/** A field mapping: a plain dotted path (as before), or a {@link FieldPathObject}. */
export type FieldPath = string | FieldPathObject;

// ─── AU10 — manifest `context` block (doc/au10-request-context.md §2) ──────

/** One declared way to read a single record the AI may link to via `_source`. */
export interface ContextSourceConfig {
  read: { tool: string; args: Record<string, string> };
  /** Identity key type (always `email` today — `email_domain` is always
   *  derived from it, never declared directly) -> field path into the
   *  read's structured result. */
  keys?: Record<string, FieldPath>;
  /** Field paths into the read's structured result. */
  title?: FieldPath;
  author?: FieldPath;
  at?: FieldPath;
  body?: FieldPath;
  /** Optional thread/reply chain to follow, same connector + kind. */
  chain?: { field: string; max: number };
}

/** The identity key types the history engine matches on (doc §2). */
export type HistoryKeyType = 'email' | 'email_domain';

export interface ContextHistoryItemMapping {
  /** Literal label, copied as-is — never a path (unlike every other field here). */
  kind?: string;
  title?: FieldPath;
  body?: FieldPath;
  at?: FieldPath;
  author?: FieldPath;
  type?: FieldPath;
  /** Field holding the ticket id a gateway's own journal can look up (AU10 §3). */
  ticket?: FieldPath;
}

export interface ContextHistoryConfig {
  /**
   * AU10 F7 — one key type, or an ORDERED preference list, e.g.
   * `["email_domain", "email"]`: the gateway uses the FIRST type it has a
   * gathered value for (a company domain when there is one; the exact
   * address when the sender is free-mail or no domain key exists at all —
   * doc §2's free-mail exclusion means a company domain and an exact
   * address are never BOTH available for the same key, so this is a
   * fallback chain, not a widening of the match).
   */
  byKey: HistoryKeyType | HistoryKeyType[];
  /**
   * `args` keys are normally literal argument names; the ONE special key
   * `"$keyType"` is replaced with whichever key type `byKey` actually
   * resolved to for this read (e.g. `email_domain` or `email`) — lets one
   * declared read serve every key type in `byKey` when the connector's own
   * read tool names its argument after the key type, as `get_timeline`
   * does (`email` / `email_domain`, both literal parameter names).
   */
  read: { tool: string; args: Record<string, string> };
  limit: number;
  maxAgeDays: number;
  item: ContextHistoryItemMapping;
}

/**
 * AU10 §8.2 — turns an id carried on the action into identity keys (doc §2),
 * optionally by following a SECOND record first (`next`) — e.g. ERP's quote
 * doesn't carry the customer's email itself, only a `customer_id` that names
 * another recordKey. `keys` and `next` may both be set (gather this record's
 * own keys AND follow the chain); at least one of them must be. Chains are
 * capped at {@link MAX_RECORD_KEY_STEPS} steps and must not cycle — checked
 * at manifest-load time (manifest-loader.ts).
 */
export interface ContextRecordKeyConfig {
  read: { tool: string; args: Record<string, string> };
  keys?: Record<string, FieldPath>;
  /** `field` is a dotted path into THIS read's result (not a {@link FieldPath}
   *  object — doc §8.2 declares it as a plain field name, unlike `keys.*`). */
  next?: { recordKey: string; field: string };
}

/** AU10 §8.2 — a recordKeys chain (this entry, plus every `next` it follows)
 *  may resolve at most this many records. */
export const MAX_RECORD_KEY_STEPS = 2;

/** AU10 manifest top-level `context` block. */
export interface ManifestContext {
  sources?: Record<string, ContextSourceConfig>;
  history?: ContextHistoryConfig;
  recordKeys?: Record<string, ContextRecordKeyConfig>;
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
