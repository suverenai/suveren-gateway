/**
 * Tool preview (AU3/AU4) — the gatekeeper-internal, pre-approval read a
 * manifest declares for an action tool via
 * `toolGating.overrides[<tool>].preview` (see tool-gating-types.ts).
 *
 * Decisions (Andreas, 2026-10-10 — temp/briefs/au3-au5-brief.md):
 *   1. The preview read is always allowed for the approver, shown ONLY on the
 *      gateway UI — never returned to the AI/any MCP client, not subject to
 *      the mandate's read access, recorded locally with no content.
 *   2. No preview / connector unreachable → the card still works with the
 *      bound values; Approve/Reject stay enabled.
 *   3. Any approving gateway reads with its OWN connector — nothing about
 *      the record goes to the Authority Server.
 *
 * Consumed by:
 *   - bin/http.ts's POST /internal/preview — the approver's live read.
 *   - tool-proxy.ts, at proposal submission, to snapshot a `previewHash` for
 *     a tool that declares a preview but no `version` (AU4 fallback).
 *   - commitments.ts's executeCommitted, which re-reads and compares that
 *     hash right before the tool runs.
 */
import { computeContentHash } from '@hap/core';
import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import { evaluateChecks, blockingFailures } from './checks';
import {
  MAX_FOREACH_ELEMENTS,
  type CheckDeclaration,
  type CheckResult,
  type PreviewDeclaration,
  type PreviewReadConfig,
  type ToolDisplayHints,
  type ToolPreviewConfig,
} from './tool-gating-types';

export type { ToolPreviewConfig, PreviewReadConfig, PreviewDeclaration, ToolDisplayHints };

/** A read's body, generic across connectors. */
export interface PreviewBody {
  structured?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  text?: string;
}

export type PreviewReadResult =
  | { status: 'ok'; body: PreviewBody }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  /** The connector answered the read with a refusal ("Refused: …") — its own words, shown as such. */
  | { status: 'refused'; message?: string };

/** Per-read timeout (contract: "Timeout per read: 5s"). */
export const PREVIEW_READ_TIMEOUT_MS = 5_000;
/** Connector-answer text cap — "from the system" messages shown to the approver. */
export const PREVIEW_MESSAGE_CAP = 500;

export function capText(text: string | undefined, max = PREVIEW_MESSAGE_CAP): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The declared preview for a tool, or undefined — never inferred. A connector
 * tool's comes from its loaded manifest; a built-in has no manifest, so its
 * declaration (DL1 — `create_mandate` / `set_agent_brief`'s own internal
 * preview tools) is read from the registered `BuiltinIntegration` instead
 * (`IntegrationManager.getBuiltinToolPreview`) — same shape either way.
 */
export function getToolPreviewConfig(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
): PreviewDeclaration | undefined {
  if (integrationManager.isBuiltin(integrationId)) {
    return integrationManager.getBuiltinToolPreview(integrationId, toolName);
  }
  const manifest = getManifest(integrationId);
  const overrides = manifest?.toolGating?.overrides ?? {};
  const entry = overrides[toolName] as { preview?: PreviewDeclaration } | null | undefined;
  return entry?.preview;
}

/**
 * AU8 — a tool's manifest-declared `display` hints (tool-gating-types.ts
 * `ToolDisplayHints`), a sibling of `preview` on the same override entry.
 * Builtins have no manifest and no display concept of their own — always
 * undefined for them, same as a connector tool with no `display` declared.
 */
export function getToolDisplayHints(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
): ToolDisplayHints | undefined {
  if (integrationManager.isBuiltin(integrationId)) return undefined;
  const manifest = getManifest(integrationId);
  const overrides = manifest?.toolGating?.overrides ?? {};
  const entry = overrides[toolName] as { display?: ToolDisplayHints } | null | undefined;
  return entry?.display;
}

/** D1 — a tool's manifest-declared `checks` (builtins have none). */
export function getToolChecks(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
): CheckDeclaration[] | undefined {
  // Optional call: test doubles of the manager predate builtins.
  if (integrationManager.isBuiltin?.(integrationId)) return undefined;
  const entry = getManifest(integrationId)?.toolGating?.overrides?.[toolName] as { checks?: CheckDeclaration[] } | null | undefined;
  return entry?.checks;
}

/**
 * Map the action's bound arguments onto the preview (read) tool's own
 * argument names, per the manifest's `args` dict (key = preview arg name,
 * value = action arg name — same direction as `executionMapping`). An action
 * arg that is absent — or null (D2: never sent as `null`) — is simply
 * omitted, never invented.
 */
export function mapPreviewArgs(
  preview: Pick<ToolPreviewConfig, 'args'>,
  actionArgs: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [targetArg, sourceArg] of Object.entries(preview.args)) {
    const value = actionArgs[sourceArg];
    if (value !== undefined && value !== null) mapped[targetArg] = value;
  }
  return mapped;
}

/**
 * D2 — "present" for a read's (or a check's) `when` path: not undefined,
 * null, an empty/blank string, an empty array, or `false`.
 */
export function isPresentForWhen(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** The value at a dotted path (`a.b.c`) inside `source`, or undefined. */
export function valueAtPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * True when the preview declares args but the action carries none of them —
 * an optional link left out (crm create_task without a contact_id). There is
 * no record to show, so this is `none` with reason `no_target`, never a read
 * with empty args that the connector would answer with "not found".
 */
export function previewHasNoTarget(
  preview: Pick<ToolPreviewConfig, 'args'>,
  mapped: Record<string, unknown>,
): boolean {
  return Object.keys(preview.args).length > 0 && Object.keys(mapped).length === 0;
}

/** D2 — a declared `when` whose path is not present in `source`. */
function whenAbsent(config: { when?: string }, source: Record<string, unknown>): boolean {
  return config.when !== undefined && !isPresentForWhen(valueAtPath(source, config.when));
}

export class PreviewTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreviewTimeoutError('preview read timed out')), ms);
  });
  return (Promise.race([p, timeout]) as Promise<T>).finally(() => clearTimeout(timer));
}

/**
 * Call a declared preview (read) tool directly through the integration
 * manager — NOT tool-proxy: no ticket, no read gate (decision 1). The caller
 * is responsible for only ever naming a tool resolved from the manifest's own
 * `preview.tool` — never an arbitrary caller-supplied name (see http.ts).
 *
 * `previewTool` must be present in the integration's CURRENT discovered tool
 * list — not just named by the manifest — so a connector that isn't running,
 * or whose tool disappeared, answers `unavailable` rather than throwing.
 */
export async function readPreview(
  integrationManager: IntegrationManager,
  integrationId: string,
  previewTool: string,
  args: Record<string, unknown>,
): Promise<PreviewReadResult> {
  const discovered = integrationManager
    .getAllTools()
    .find(t => t.integrationId === integrationId && t.originalName === previewTool);
  if (!discovered) {
    return { status: 'unavailable', reason: 'no_connector' };
  }
  try {
    const result = await withTimeout(
      integrationManager.callTool(integrationId, previewTool, args),
      PREVIEW_READ_TIMEOUT_MS,
    );
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text;
    if (result.isError) {
      // Connectors answer every failed call as an error. One that starts
      // "Refused" is the connector refusing (contract wording shared by
      // Suveren's connectors), not a missing record — shown as a refusal.
      return /^\s*Refused\b/i.test(text ?? '')
        ? { status: 'refused', message: capText(text) }
        : { status: 'not_found', message: capText(text) };
    }
    return {
      status: 'ok',
      body: {
        ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
        ...(discovered.outputSchema ? { outputSchema: discovered.outputSchema } : {}),
        ...(text !== undefined ? { text } : {}),
      },
    };
  } catch (err) {
    if (err instanceof PreviewTimeoutError) {
      return { status: 'unavailable', reason: 'timeout' };
    }
    return {
      status: 'unavailable',
      reason: 'connector_error',
      message: capText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * The message for a manifest-declared read that did not answer. `no_connector`
 * covers two different cases: the connector is not running at all, or it
 * runs but does not offer the declared tool (an older connector version than
 * the manifest expects). Telling them apart matters — "could not be reached"
 * for a running connector sends the person looking in the wrong place.
 * `declaredAt` names where the manifest declares the tool (e.g. "documents.invoice").
 */
export function unavailableReadMessage(
  integrationManager: IntegrationManager,
  read: Extract<PreviewReadResult, { status: 'unavailable' }>,
  connector: string,
  tool: string,
  declaredAt: string,
): string {
  if (read.reason === 'no_connector') {
    const running = integrationManager.getAllTools().some(t => t.integrationId === connector);
    if (running) {
      return `Connector "${connector}" is running but has no tool "${tool}" (declared in ${declaredAt}) — the installed connector version does not offer it.`;
    }
  }
  return read.message ?? `Connector "${connector}" could not be reached.`;
}

/**
 * jcs/sha256 of the structured result, else text — the AU4 fallback snapshot
 * for a preview WITHOUT a declared `version`. This never leaves the machine;
 * it exists only to detect "did the record change since we read it", not as
 * a security/binding hash.
 */
export function hashPreviewBody(body: Pick<PreviewBody, 'structured' | 'text'>): string {
  if (body.structured !== undefined) {
    return computeContentHash({ kind: 'jcs', version: '1' }, body.structured);
  }
  return computeContentHash({ kind: 'text', version: '1' }, body.text ?? '');
}

// ─── AU8 — several reads per preview ───────────────────────────────────────
// "run sequentially with the existing timeout per read; a failing read
// degrades that part only, never blocks the decision" (temp/briefs/au8-brief.md).

/** One planned (not-yet-executed) read, resolved from a {@link PreviewReadConfig}
 *  against the action's bound args. Exported for testing (planning is pure;
 *  only `runPreviewReadPlan` below does I/O). */
export interface ReadPlanItem {
  tool: string;
  attach?: string;
  fields?: string[];
  version?: { arg: string; field: string };
  /** Non-`forEach` only — the mapped args for the one read. */
  args?: Record<string, unknown>;
  /** Non-`forEach` only — the UNMAPPED source object `version.arg` is read
   *  from (the action's own bound args) — needed to redo the mapping minus
   *  the version arg for the second (version-less) read. */
  rawSource?: Record<string, unknown>;
  /** Non-`forEach` only — true when `args` named a source the action didn't
   *  carry (see `previewHasNoTarget`): nothing to read, never attempted. */
  noTarget?: boolean;
  /** See {@link PreviewReadConfig.kind} — passed through untouched. */
  kind?: 'document';
  /** `forEach` only — the source action-arg name. */
  forEach?: string;
  /** `forEach` only — one planned read per (capped) source element, in order.
   *  `skip`: the element's `when` field is absent — not read, outcome `none`. */
  elements?: Array<{ args: Record<string, unknown>; skip?: boolean }>;
  /** See {@link PreviewReadConfig.displayOnly} — excluded from the AU4 hash. */
  displayOnly?: boolean;
  /** See {@link PreviewReadConfig.as} / {@link PreviewReadConfig.label}. */
  as?: string;
  label?: string;
  /** `forEach` only — present when the source array exceeded the cap. */
  overflow?: { shown: number; total: number };
  /**
   * The read's own `args` MAPPING (preview-tool arg name -> source name),
   * kept so the version-less re-read can be re-mapped with the version arg
   * omitted (same as the single-object path). Internal planning detail —
   * never sent over the wire (only {@link PreviewReadSection} is).
   */
  argsMapping: Record<string, string>;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolves a {@link PreviewDeclaration} (object or list) against the
 * action's bound args into an ordered list of planned reads — pure, no I/O.
 * A `forEach` read's source array is capped at {@link MAX_FOREACH_ELEMENTS}
 * elements ("over the cap -> show the first N and 'N more not shown'"); a
 * source that is absent or not an array plans ZERO elements (nothing to
 * iterate, not an error — same spirit as `previewHasNoTarget`). Any element
 * that isn't itself a plain object is skipped (there is nothing to map
 * `args` against).
 */
export function planPreviewReads(
  declaration: PreviewDeclaration,
  actionArgs: Record<string, unknown>,
): ReadPlanItem[] {
  const reads: PreviewReadConfig[] = Array.isArray(declaration) ? declaration : [declaration];
  return reads.map((config): ReadPlanItem => {
    const base = {
      tool: config.tool,
      attach: config.attach,
      fields: config.fields,
      version: config.version,
      kind: config.kind,
      argsMapping: config.args,
      ...(config.displayOnly ? { displayOnly: true } : {}),
      ...(config.as ? { as: config.as } : {}),
      ...(config.label ? { label: config.label } : {}),
    };
    if (config.forEach) {
      const source = actionArgs[config.forEach];
      const list = Array.isArray(source) ? source : [];
      const capped = list.slice(0, MAX_FOREACH_ELEMENTS);
      // D2: an element whose `when` field is absent is not read — it keeps
      // its place (outcome `none`) so outcomes stay aligned with elements.
      const elements = capped
        .filter(isPlainRecord)
        .map((el) => (config.when !== undefined && !isPresentForWhen(valueAtPath(el, config.when))
          ? { args: {}, skip: true }
          : { args: mapPreviewArgs(config, el) }));
      return {
        ...base,
        forEach: config.forEach,
        elements,
        ...(list.length > MAX_FOREACH_ELEMENTS ? { overflow: { shown: MAX_FOREACH_ELEMENTS, total: list.length } } : {}),
      };
    }
    // D2: `when` absent → nothing to read, same outcome as no target.
    if (config.when !== undefined && !isPresentForWhen(valueAtPath(actionArgs, config.when))) {
      return { ...base, args: {}, rawSource: actionArgs, noTarget: true };
    }
    const mapped = mapPreviewArgs(config, actionArgs);
    return { ...base, args: mapped, rawSource: actionArgs, noTarget: previewHasNoTarget(config, mapped) };
  });
}

/**
 * Executes a plan from {@link planPreviewReads} sequentially (each read its
 * own `readPreview` call, so the existing per-read timeout applies
 * unchanged), building one {@link PreviewReadSection} per planned read. A
 * non-`forEach` read that declares `version` gets the same two-read
 * staleness check `buildInternalPreview` does for a single-object preview —
 * generalized here to run per read rather than once for the whole preview.
 * (A `forEach` read never declares `version` in practice — none of the
 * shipped manifests need per-element staleness — so elements are read
 * plainly, same as a read with no version at all.)
 */
async function runPreviewReadPlan(
  integrationManager: IntegrationManager,
  integrationId: string,
  plan: ReadPlanItem[],
): Promise<PreviewReadSection[]> {
  const sections: PreviewReadSection[] = [];
  for (const item of plan) {
    const sourceArgNames = Object.values(item.argsMapping);
    const base = {
      tool: item.tool,
      ...(item.attach ? { attach: item.attach } : {}),
      ...(sourceArgNames.length === 1 ? { sourceArg: sourceArgNames[0] } : {}),
      ...(item.fields ? { fields: item.fields } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.displayOnly ? { displayOnly: true } : {}),
      ...(item.as ? { as: item.as } : {}),
      ...(item.label ? { label: item.label } : {}),
    };
    if (item.elements !== undefined) {
      const elements: PreviewReadOutcome[] = [];
      for (const el of item.elements) {
        elements.push(el.skip
          ? { status: 'none', reason: 'no_target' }
          : await readPreview(integrationManager, integrationId, item.tool, el.args));
      }
      sections.push({
        ...base,
        forEach: item.forEach,
        elements,
        ...(item.overflow ? { overflow: item.overflow } : {}),
      });
      continue;
    }

    if (item.noTarget) {
      sections.push({ ...base, result: { status: 'none', reason: 'no_target' } });
      continue;
    }

    const read1 = await readPreview(integrationManager, integrationId, item.tool, item.args!);
    if (read1.status !== 'ok' || !item.version) {
      sections.push({ ...base, result: read1 });
      continue;
    }

    // Same staleness check buildInternalPreview applies for a single-object
    // preview, scoped to THIS one read's own `args`/`version`.
    const approved = item.rawSource?.[item.version.arg];
    if (typeof approved !== 'string' && typeof approved !== 'number') {
      sections.push({ ...base, result: read1 });
      continue;
    }
    const { [item.version.arg]: _omit, ...withoutVersion } = item.rawSource!;
    const mappedCurrentArgs = mapPreviewArgs({ args: item.argsMapping }, withoutVersion);
    const read2 = await readPreview(integrationManager, integrationId, item.tool, mappedCurrentArgs);
    // A connector may answer as JSON text only (no structuredContent) —
    // read the version from that object the same way the card does.
    const current2 = read2.status === 'ok' ? structuredOrJsonText(read2.body) : undefined;
    if (current2 === undefined) {
      sections.push({ ...base, result: read1 });
      continue;
    }
    const current = current2[item.version.field];
    if (typeof current !== 'string' && typeof current !== 'number') {
      sections.push({ ...base, result: read1 });
      continue;
    }
    const stale = String(current) !== String(approved);
    sections.push({
      ...base,
      result: read1,
      version: {
        field: item.version.field,
        approved,
        current,
        stale,
        ...(stale && read2.status === 'ok' ? { currentBody: read2.body } : {}),
      },
    });
  }
  return sections;
}

/**
 * AU4 fallback snapshot at proposal submission, for a preview WITHOUT a
 * declared `version` (a connector with no document-version enforcement of
 * its own — e.g. nothing like ERP 0.6.0's own revision refusal). Reads the
 * preview ONCE with the action's bound args and hashes the result.
 *
 * Returns undefined when: the tool declares no preview; it declares one
 * WITH a version (the connector refuses a stale version itself — no
 * fallback needed, see executeCommitted); the read didn't succeed —
 * nothing to compare against later is better than snapshotting an error and
 * refusing every future execution because of it; OR the tool is a built-in
 * (DL1 — Interface contract, "previewHash is skipped for builtin previews"):
 * `create_mandate` / `set_agent_brief` are CREATE actions, there is no
 * document to go stale, and the proposal's own args already are "what will
 * happen" — AU4's re-read fallback would just re-run the preview tool for
 * nothing, so it never runs and no hash is ever stored for these.
 */
export async function computeSubmissionPreviewHash(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<string | undefined> {
  if (integrationManager.isBuiltin(integrationId)) return undefined;
  const preview = getToolPreviewConfig(integrationManager, integrationId, toolName);
  if (!preview) return undefined;
  // AU8 — several reads: cover ALL of them in one combined hash (see
  // combinedPreviewReadsHash's doc comment); the single-object path below is
  // untouched, so every pre-AU8 caller/test keeps its exact behaviour.
  if (Array.isArray(preview)) return combinedPreviewReadsHash(integrationManager, integrationId, preview, actionArgs);
  if (preview.version || preview.displayOnly) return undefined;
  const mapped = mapPreviewArgs(preview, actionArgs);
  if (previewHasNoTarget(preview, mapped) || whenAbsent(preview, actionArgs)) return undefined;
  const read = await readPreview(integrationManager, integrationId, preview.tool, mapped);
  if (read.status !== 'ok') return undefined;
  return hashPreviewBody(read.body);
}

/**
 * AU4 — re-read and compare against a `previewHash` stored at submission,
 * right before executing a committed proposal. True means "do not run":
 * the record provably changed, OR the re-read could not positively confirm
 * it did NOT — fail-closed, the same way an unreadable execution journal
 * refuses rather than guessing (see execution-journal.ts).
 */
export async function previewChangedSinceSubmission(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
  previousHash: string,
): Promise<boolean> {
  const preview = getToolPreviewConfig(integrationManager, integrationId, toolName);
  if (!preview) return true; // nothing to re-verify against — fail closed
  if (Array.isArray(preview)) {
    const hash = await combinedPreviewReadsHash(integrationManager, integrationId, preview, actionArgs);
    if (hash === undefined) return true; // can't confirm unchanged — fail closed
    return hash !== previousHash;
  }
  const mapped = mapPreviewArgs(preview, actionArgs);
  const read = await readPreview(integrationManager, integrationId, preview.tool, mapped);
  if (read.status !== 'ok') return true; // can't confirm unchanged — fail closed
  return hashPreviewBody(read.body) !== previousHash;
}

/**
 * AU8 — the combined AU4 hash across every read of a multi-read preview that
 * has NO declared `version` (a read WITH one is enforced by the connector's
 * own revision mechanism instead — "version stays per read where declared",
 * temp/briefs/au8-brief.md). Each read without a version contributes its own
 * `hashPreviewBody`, in declared order; a `forEach` read contributes one hash
 * per (capped) element, in source order. Combined via the same jcs hashing
 * `hashPreviewBody` uses, over the ordered list of those hashes.
 *
 * Returns undefined — "nothing to compare against later is better than
 * snapshotting an error" (same reasoning as the single-read fallback) —
 * when: every read is version-protected or has no target to read (nothing
 * to hash at all); or any read that DOES have a target fails.
 */
async function combinedPreviewReadsHash(
  integrationManager: IntegrationManager,
  integrationId: string,
  reads: PreviewReadConfig[],
  actionArgs: Record<string, unknown>,
): Promise<string | undefined> {
  // A display-only read (volatile by nature — the connector re-checks at
  // execution) is excluded like a versioned one.
  const plan = planPreviewReads(reads, actionArgs).filter((item) => !item.version && !item.displayOnly);
  const hashes: string[] = [];
  for (const item of plan) {
    if (item.elements !== undefined) {
      for (const el of item.elements) {
        if (el.skip) continue; // D2 `when` absent — nothing read, nothing hashed
        const read = await readPreview(integrationManager, integrationId, item.tool, el.args);
        if (read.status !== 'ok') return undefined;
        hashes.push(hashPreviewBody(read.body));
      }
      continue;
    }
    if (item.noTarget) continue; // nothing to read for this one — contributes nothing
    const read = await readPreview(integrationManager, integrationId, item.tool, item.args!);
    if (read.status !== 'ok') return undefined;
    hashes.push(hashPreviewBody(read.body));
  }
  if (hashes.length === 0) return undefined;
  return computeContentHash({ kind: 'jcs', version: '1' }, { reads: hashes });
}

// ─── buildInternalPreview's result shape ───────────────────────────────────

export interface PreviewVersionInfo {
  field: string;
  approved: string | number;
  current: string | number;
  stale: boolean;
  currentBody?: PreviewBody;
}

/** A read's outcome where "nothing to read" (no_target) is itself a valid,
 *  non-error outcome — AU8's per-section degrade uses this union (a PLAIN
 *  {@link PreviewReadResult} has no `none` branch, since the single-read path
 *  above already handles `no_target` as a whole-preview early return). */
export type PreviewReadOutcome = PreviewReadResult | { status: 'none'; reason: 'no_target' };

/**
 * AU8 — one declared read's outcome within a multi-read preview, generic
 * across connectors: the UI (apps/ui/src/lib/preview-render.ts) decides HOW
 * to show `attach`/`forEach` from this shape alone, never a tool name.
 */
export interface PreviewReadSection {
  tool: string;
  /** See {@link PreviewReadConfig.attach} — non-`forEach` reads only. */
  attach?: string;
  /** See {@link PreviewReadConfig.forEach} — present only for a forEach read. */
  forEach?: string;
  /**
   * Rendering aid, derived (never declared): when this read's `args` names
   * exactly one source — the bound action-arg name (non-`forEach`) or the
   * bound element field (`forEach`) it reads by — so the UI can tell which
   * of the bound element's own fields the attach column replaces (e.g.
   * `item_id`), instead of showing it twice. Absent when `args` has zero or
   * more than one entry (nothing single to point at).
   */
  sourceArg?: string;
  /** The manifest's declared `fields` for THIS read, passed through untouched. */
  fields?: string[];
  /** See {@link PreviewReadConfig.kind} — passed through untouched. */
  kind?: 'document';
  /** See {@link PreviewReadConfig.displayOnly} — the card labels it with its time. */
  displayOnly?: boolean;
  /** See {@link PreviewReadConfig.as} — input for checks only, no card section. */
  as?: string;
  /** See {@link PreviewReadConfig.label} — "From <label>". */
  label?: string;
  /** Non-`forEach` reads only. */
  result?: PreviewReadOutcome;
  /** `forEach` reads only — one outcome per (capped) source element, same order. */
  elements?: PreviewReadOutcome[];
  /** Present only when the `forEach` source array exceeded {@link MAX_FOREACH_ELEMENTS}. */
  overflow?: { shown: number; total: number };
  /** Non-`forEach` reads only — see {@link PreviewReadConfig.version}. */
  version?: PreviewVersionInfo;
}

export type InternalPreviewResult = (
  /** `no_target`: a preview is declared, but the action names no record to read. */
  | { status: 'none'; reason?: 'no_target' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | { status: 'refused'; message?: string }
  | {
      status: 'ok';
      integration: string;
      tool: string;
      body: PreviewBody;
      version?: PreviewVersionInfo;
      /** The manifest's declared `preview.fields`, passed through untouched
       *  so the UI's field order/priority comes from the same one place —
       *  never re-declared or guessed on the wire. */
      fields?: string[];
    }
  /** AU8 — several reads (manifest `preview` is a list): one section per
   *  declared read, degraded independently (a failing read never blocks the
   *  others, or the decision — temp/briefs/au8-brief.md). Distinguished from
   *  the single-read "ok" above by `reads` (never both on the same object). */
  | { status: 'ok'; integration: string; reads: PreviewReadSection[]; display?: ToolDisplayHints }
) & {
  /** D1 — the manifest's declared checks for this tool, evaluated (checks.ts). */
  checks?: CheckResult[];
};

/**
 * Full orchestration for one `/internal/preview` call: resolves the
 * manifest's declared preview (if any), reads it, and — when the manifest
 * declares `version` — performs the SECOND read (mapped args minus the
 * version arg) to detect staleness. Everything the manifest knows about this
 * connector (which field, which arg) stays here; callers (http.ts, and the
 * control plane relaying its answer) never see a connector-specific name.
 * AU8 — several reads: delegates to `planPreviewReads`/`runPreviewReadPlan`
 * instead, returning the `reads` shape of {@link InternalPreviewResult}.
 */
export async function buildInternalPreview(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<InternalPreviewResult> {
  const result = await buildPreviewReads(integrationManager, integrationId, toolName, actionArgs);
  // D1 — the manifest's declared checks, evaluated over the bound args and
  // the reads that just ran. Never supplied by the AI or the caller.
  const checks = getToolChecks(integrationManager, integrationId, toolName);
  if (!checks || checks.length === 0) return result;
  const display = getToolDisplayHints(integrationManager, integrationId, toolName);
  return {
    ...result,
    checks: evaluateChecks(checks, {
      args: actionArgs,
      declaration: getToolPreviewConfig(integrationManager, integrationId, toolName),
      sections: 'reads' in result ? result.reads : undefined,
      currencyField: display?.currencyField,
    }),
  };
}

/**
 * Decision 2026-10-21 (Andreas) — the failed `blocking` checks for a call,
 * evaluated exactly as the card would (same reads, same checks), BEFORE any
 * proposal is made. Empty when the tool declares no blocking check (no read
 * is run then) or none fails. A read that cannot answer gives `not_checked`
 * or no line — never a `fail` — so an outage never blocks.
 */
export async function failedBlockingChecks(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<CheckResult[]> {
  const declared = getToolChecks(integrationManager, integrationId, toolName);
  if (!declared?.some((c) => c.blocking === true)) return [];
  try {
    const result = await buildInternalPreview(integrationManager, integrationId, toolName, actionArgs);
    return blockingFailures(result.checks ?? []);
  } catch (err) {
    // Same rule as an unanswered read: no verdict, so no block — the card
    // shows what could not be checked, and the connector still refuses at
    // execution.
    console.error(`[Suveren MCP] blocking checks for ${integrationId}__${toolName} could not run:`, err);
    return [];
  }
}

async function buildPreviewReads(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<InternalPreviewResult> {
  const preview = getToolPreviewConfig(integrationManager, integrationId, toolName);
  if (!preview) return { status: 'none' };

  if (Array.isArray(preview)) {
    const reads = await runPreviewReadPlan(integrationManager, integrationId, planPreviewReads(preview, actionArgs));
    const display = getToolDisplayHints(integrationManager, integrationId, toolName);
    return { status: 'ok', integration: integrationId, reads, ...(display ? { display } : {}) };
  }

  const mappedArgs = mapPreviewArgs(preview, actionArgs);
  if (previewHasNoTarget(preview, mappedArgs) || whenAbsent(preview, actionArgs)) return { status: 'none', reason: 'no_target' };
  const read1 = await readPreview(integrationManager, integrationId, preview.tool, mappedArgs);
  if (read1.status !== 'ok') return read1;

  // One place builds every "ok" return from here on, so `fields` (the
  // manifest's declared field priority — see tool-gating-types.ts) can
  // never be forgotten on one of the several early-return branches below.
  const ok = (extra: Partial<Extract<InternalPreviewResult, { status: 'ok' }>> = {}): InternalPreviewResult => ({
    status: 'ok',
    integration: integrationId,
    tool: preview.tool,
    body: read1.body,
    ...(preview.fields ? { fields: preview.fields } : {}),
    ...extra,
  });

  if (!preview.version) {
    return ok();
  }

  const approved = actionArgs[preview.version.arg];
  if (typeof approved !== 'string' && typeof approved !== 'number') {
    // The action arg the manifest says carries the version is absent or the
    // wrong type at call time — a manifest/call mismatch, not a connector
    // fault. Degrade to "no version info" rather than fail the whole read.
    return ok();
  }

  const { [preview.version.arg]: _omit, ...withoutVersion } = actionArgs;
  const mappedCurrentArgs = mapPreviewArgs(preview, withoutVersion);
  const read2 = await readPreview(integrationManager, integrationId, preview.tool, mappedCurrentArgs);
  const current2 = read2.status === 'ok' ? structuredOrJsonText(read2.body) : undefined;
  if (current2 === undefined) {
    // Can't determine staleness — show the approved read without a version
    // comparison rather than failing the whole preview.
    return ok();
  }

  const current = current2[preview.version.field];
  if (typeof current !== 'string' && typeof current !== 'number') {
    return ok();
  }

  const stale = String(current) !== String(approved);
  return ok({
    version: {
      field: preview.version.field,
      approved,
      current,
      stale,
      ...(stale && read2.status === 'ok' ? { currentBody: read2.body } : {}),
    },
  });
}

/**
 * A read's result as an object: its `structuredContent` when the connector
 * declares one, else its text when that text is exactly one JSON object.
 * Connectors differ (erp-mcp 0.8.0 returned the document only as JSON text);
 * the shape checks that follow are the same either way.
 */
export function structuredOrJsonText(body: { structured?: Record<string, unknown>; text?: string }): Record<string, unknown> | undefined {
  if (body.structured && typeof body.structured === 'object') return body.structured;
  const t = body.text?.trim();
  if (!t || !t.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(t) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
