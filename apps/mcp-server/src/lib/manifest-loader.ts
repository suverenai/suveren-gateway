/**
 * Manifest Loader — reads integration manifests from disk.
 *
 * Reads content/integrations/index.json, loads each manifest JSON.
 * Pattern follows profile-loader.ts.
 *
 * Configurable via SUVEREN_MANIFESTS_DIR env var (defaults to
 * ../../../../content/integrations relative to this file — the repo's
 * checked-in manifest directory). Kept intentionally separate from
 * SUVEREN_INTEGRATIONS_DIR, which is the runtime install target for
 * downstream MCP npm packages — pointing that at the manifest dir used
 * to leak package.json + node_modules/ into the repo.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProfile } from '@hap/core';
import {
  MAX_PREVIEW_READS,
  MAX_RECORD_KEY_STEPS,
  MAX_CHECKS_PER_TOOL,
  CHECK_STATUSES,
  type CheckStatus,
  type NetworkDeclaration,
  type ProfileToolGating,
  type ToolPreviewConfig,
  type ManifestContext,
  type FieldPathParse,
  type ManifestDocuments,
  type AttachmentTransportConfig,
  type ManifestValues,
  type MessageVerb,
} from './tool-gating-types';
import { uncoveredReadSwitchReason, type BoundsSchemaLike } from './read-gate';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ManifestCredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder?: string;
  optional?: boolean;
}

export interface ManifestOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  credentialKeys: Record<string, string>;
  tokenStorage: string;
  extraParams?: Record<string, string>;
}

/**
 * Declares how to discover valid values for a context-scope field by
 * querying the connected service. Consumed by the wizard-only endpoint
 * GET /integrations/:id/discover/:field on the control plane — not
 * agent-reachable. See doc/hap-scope-discovery-proposal.md.
 */
export interface ManifestContextDiscovery {
  baseUrl: string;
  endpoint: string;
  /** Currently only "bearer" is supported — token from the integration's vault credential. */
  auth: 'bearer';
  /** Vault credential field holding the bearer (or refresh token to exchange). Defaults to oauth.tokenStorage. */
  credential?: string;
  /** Dotted path to the array in the response (e.g. "items"). */
  responsePath: string;
  /** Key on each array element for the option value. */
  valueField: string;
  /** Key for the human-readable label. */
  labelField: string;
  /** Optional extras surfaced to the wizard UI for each option (e.g. access role, timezone). */
  extraFields?: Record<string, string>;
}

export interface IntegrationManifest {
  id: string;
  name: string;
  /**
   * Starter text for the intent of a mandate for this integration — what a
   * person would typically want the agent to know here. The gateway UI seeds the
   * intent with it; the person edits it and signs their own words. Protocol 0.7:
   * profiles MUST NOT define the intent prompt; manifests MAY give this hint.
   */
  intentHint?: string;
  version: string;
  description: string;
  icon: string;
  profile: string;
  mcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    /** Names of gateway environment variables this connector reads (e.g. a
     *  seed file the operator sets). Everything else is withheld — see
     *  connector-env.ts. */
    passEnv?: string[];
  };
  credentials: {
    fields: ManifestCredentialField[];
    envMapping: Record<string, string>;
  };
  oauth: ManifestOAuthConfig | null;
  /**
   * The connector CAN answer from a simulated system: `field` is the credential
   * field holding the mode, `default` the mode when it is unset. Two consumers:
   *   1. Display — the UI badges a simulated connector (per its current
   *      credential value) so a forgotten switch after go-live is never silent.
   *   2. Enforcement — gateway-wide simulation mode (SUVEREN_SIMULATION=1, see
   *      simulation-mode.ts) refuses to START (or keep running) any connector
   *      whose CURRENT setting is not the simulated one — no entry here at
   *      all, OR one that has an entry but is currently SET to a real mode
   *      (e.g. ERP's mode=live) — exactly like any other real system.
   * Absent simulation mode, the gateway's checks and tickets are identical in
   * both modes — this field alone changes nothing.
   */
  simulation?: { field: string; default: string } | null;
  /**
   * Display labels for THIS connector's current mode, shown on the
   * Integrations card as "<name> · <label>" (e.g. "ERP · Built-in", "ERP ·
   * Test data") — never derived from the connector's name or id in code.
   * Keyed by the `simulation.field` value: a plain string applies to that
   * mode regardless of adapter (e.g. `{ "simulation": "Test mailbox" }`); an
   * object is keyed by the ADAPTER setting's value (see `adapterField`) for
   * a mode that has more than one real backend (e.g.
   * `{ "live": { "local": "Built-in" } }` — ERP/CRM's own invoicing/CRM data
   * via the "local" adapter). Only meaningful alongside `simulation` — the
   * mode value it's keyed by comes from that same field.
   */
  modeLabels?: Record<string, string | Record<string, string>> | null;
  /** A short note per mode, same shape as `modeLabels` — shown under the card title. */
  modeNotes?: IntegrationManifest['modeLabels'];
  /**
   * Credential field holding which adapter backs a non-simulated mode (e.g.
   * erp.json's `liveAdapter`, env `ERP_LIVE_ADAPTER`). Required whenever
   * `modeLabels` has an adapter-keyed (object) entry — see `modeLabels`.
   */
  adapterField?: string;
  /** npm package to install on-demand for this connector (e.g. "@humanagencyp/crm-mcp"). */
  npmPackage?: string;
  /**
   * The EXACT version of `npmPackage` this manifest is tested against and
   * vouches for — e.g. "0.3.3". Required whenever `npmPackage` is set.
   *
   * A gateway release ships a tested SET of connector versions, the same way
   * it ships a tested set of bundled profiles: nobody auto-pulls "latest" and
   * gets a connector nobody here has run. `ensureInstalled` in
   * integration-manager.ts brings the installed package to this exact
   * version (older OR newer) before the connector starts, and refuses to
   * start it if that install fails — never silently keeping a version the
   * manifest does not vouch for.
   *
   * Must be an EXACT semver: no ranges ("^1.2.3", "~1.2.0"), no dist-tags
   * ("latest", "next"), no git/URL/file specs. `isExactSemver` (below)
   * is the single definition of "valid"; `loadManifests` refuses the whole
   * manifest, named, if this is missing or fails it.
   */
  npmVersion?: string;
  personalDefault?: boolean;
  toolGating: ProfileToolGating;
  setupHint?: string;
  /** Optional per-context-field discovery config (wizard-only). */
  contextDiscovery?: Record<string, ManifestContextDiscovery>;
  /** AU10 — request/history card reads (doc/au10-request-context.md §2). */
  context?: ManifestContext;
  /**
   * Document kinds THIS connector can hand the gateway by reference — e.g.
   * the ERP's `invoice-pdf`/`credit-note-pdf` (suveren-invoicing-plan.md
   * §6/§7). See tool-gating-types.ts `DocumentSourceConfig`. Every declared
   * `tool` must be `internal: true` on this SAME manifest's `toolGating`
   * (checked at load time — `invalidManifestDocumentsReason`).
   */
  documents?: ManifestDocuments;
  /**
   * How THIS connector receives attachment bytes on an outgoing message —
   * see tool-gating-types.ts `AttachmentTransportConfig`. Declared once per
   * connector; a tool opts in by setting its own override's
   * `attachmentsArg` (checked at load time that the two agree).
   */
  attachments?: AttachmentTransportConfig;
  /**
   * Value kinds THIS connector can hand the gateway to insert into another
   * action's own text — e.g. Mollie's `payment-link` (suveren-invoicing-
   * plan.md §5/§7). See tool-gating-types.ts `InsertValueSourceConfig`.
   */
  values?: ManifestValues;
  /**
   * D3 (R5) — outside hosts this connector calls, per mode. See tool-gating-
   * types.ts `NetworkDeclaration`. Display only: shown on the connector's
   * settings; the gateway does not proxy or police the call.
   */
  network?: NetworkDeclaration[];
}

interface ManifestIndex {
  integrations: Record<string, string>;
}

// ─── npmVersion pin validation ──────────────────────────────────────────────

/**
 * An exact semver only — no ranges, no build-metadata-as-range tricks, no
 * dist-tags, no git/URL/file specs. Anything `npm install <pkg>@<this>` could
 * resolve to something OTHER than one specific published version is rejected:
 * the whole point of the pin is that every gateway release installs the exact
 * bytes it was tested against.
 */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SEMVER_RE.test(value);
}

/**
 * Returns a human-readable refusal reason if `manifest`'s npm pin is invalid,
 * or null if it's fine (including "no npmPackage at all" — nothing to pin).
 * Shared by the loader (refuses the manifest) and the lint test (fails CI) so
 * the two can never disagree about what counts as a valid pin.
 */
export function invalidNpmPinReason(
  manifest: Pick<IntegrationManifest, 'npmPackage' | 'npmVersion'>,
): string | null {
  if (!manifest.npmPackage) return null;
  if (manifest.npmVersion === undefined) {
    return `npmPackage "${manifest.npmPackage}" is set but npmVersion is missing — every connector manifest must pin an exact tested version`;
  }
  if (!isExactSemver(manifest.npmVersion)) {
    return `npmVersion ${JSON.stringify(manifest.npmVersion)} for "${manifest.npmPackage}" is not an exact semver (e.g. "1.2.3") — ranges, dist-tags like "latest", git specs, URLs, and file paths are not allowed`;
  }
  return null;
}

// ─── AU3 preview shape validation ──────────────────────────────────────────

/**
 * Checks ONE read config — the legacy object shape (`idx === null`, label
 * "preview") or one element of an AU8 list (`idx` is its index, label
 * "preview[idx]"). `forEach`/`attach` are AU8-only but shape-checked the
 * same way regardless — an object preview with a stray `forEach` is just as
 * malformed as a list entry missing `tool`.
 */
function invalidReadConfigReason(toolName: string, idx: number | null, entry: unknown): string | null {
  const label = idx === null ? `override "${toolName}".preview` : `override "${toolName}".preview[${idx}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${label} must be an object`;
  }
  const p = entry as Record<string, unknown>;
  if (typeof p.tool !== 'string' || p.tool.length === 0) {
    return `${label}.tool must be a non-empty string`;
  }
  if (p.args === undefined || p.args === null || typeof p.args !== 'object' || Array.isArray(p.args)) {
    return `${label}.args must be an object mapping preview-tool arg names to action arg names`;
  }
  for (const [argName, source] of Object.entries(p.args as Record<string, unknown>)) {
    if (typeof source !== 'string' || source.length === 0) {
      return `${label}.args.${argName} must name a non-empty source argument (string)`;
    }
  }
  if (p.forEach !== undefined && (typeof p.forEach !== 'string' || p.forEach.length === 0)) {
    return `${label}.forEach must be a non-empty string naming an action argument`;
  }
  if (p.attach !== undefined && (typeof p.attach !== 'string' || p.attach.length === 0)) {
    return `${label}.attach must be a non-empty string`;
  }
  if (p.version !== undefined) {
    if (p.version === null || typeof p.version !== 'object' || Array.isArray(p.version)) {
      return `${label}.version must be an object`;
    }
    const v = p.version as Record<string, unknown>;
    if (typeof v.arg !== 'string' || v.arg.length === 0) {
      return `${label}.version.arg must be a non-empty string`;
    }
    if (typeof v.field !== 'string' || v.field.length === 0) {
      return `${label}.version.field must be a non-empty string`;
    }
  }
  if (p.fields !== undefined) {
    if (!Array.isArray(p.fields)) {
      return `${label}.fields must be an array of field names`;
    }
    for (const [i, f] of p.fields.entries()) {
      if (typeof f !== 'string' || f.length === 0) {
        return `${label}.fields[${i}] must be a non-empty string`;
      }
    }
  }
  if (p.kind !== undefined && p.kind !== 'document') {
    return `${label}.kind must be "document" (the only recognized value)`;
  }
  // D2 — `when`: a plain dotted argument path (inside forEach: an element field).
  if (p.when !== undefined && (typeof p.when !== 'string' || !PLAIN_PATH_RE.test(p.when))) {
    return `${label}.when must be a dotted argument path (e.g. "uid" or "item_id")`;
  }
  if (p.displayOnly !== undefined && typeof p.displayOnly !== 'boolean') {
    return `${label}.displayOnly must be a boolean`;
  }
  if (p.as !== undefined) {
    if (typeof p.as !== 'string' || !/^[A-Za-z_][\w-]*$/.test(p.as)) return `${label}.as must be a plain name`;
    if (p.attach !== undefined || p.forEach !== undefined || p.kind !== undefined) {
      return `${label}.as cannot be combined with attach, forEach or kind`;
    }
  }
  if (p.label !== undefined && (typeof p.label !== 'string' || p.label.trim().length === 0 || p.label.length > 60)) {
    return `${label}.label must be a non-empty string of at most 60 characters`;
  }
  if (p.displayOnly === true && p.version !== undefined) {
    return `${label} cannot be both displayOnly and version-checked — a versioned read is the record the action changes`;
  }
  return null;
}

/** A plain dotted path: `a`, `a.b.c`. */
const PLAIN_PATH_RE = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/;
/** A check path: a plain path, or `a[].b(.c)*` (element of forEach `a`). */
// `<attach>.$version.<approved|current|stale>` reads a versioned read's
// staleness (preview.ts) — e.g. a blocking "request is for the current revision".
const CHECK_PATH_RE = /^(?:[A-Za-z_][\w-]*(?:\.(?:[A-Za-z_][\w-]*|\$version))*|[A-Za-z_][\w-]*\[\](?:\.[A-Za-z_][\w-]*)+)$/;

/**
 * Returns a human-readable refusal reason if `entry.preview` (an override's
 * optional AU3/AU8 declaration — see tool-gating-types.ts) is malformed, or
 * null if it's absent or well-formed. Shape-only: whether a declared
 * `preview[].tool` actually exists on the integration is a RUNTIME question
 * (the connector may not be started yet when manifests load), checked at
 * call time by the `/internal/preview` route instead — see preview.ts's
 * `readPreview`.
 */
export function invalidPreviewReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null; // read-tool shorthand, nothing to check
  const preview = (entry as { preview?: unknown }).preview;
  if (preview === undefined) return null;
  if (Array.isArray(preview)) {
    if (preview.length === 0) {
      return `override "${toolName}".preview must not be an empty list — omit it, or use the single-object form`;
    }
    if (preview.length > MAX_PREVIEW_READS) {
      return `override "${toolName}".preview declares ${preview.length} reads — max ${MAX_PREVIEW_READS}`;
    }
    for (const [i, read] of preview.entries()) {
      const reason = invalidReadConfigReason(toolName, i, read);
      if (reason) return reason;
    }
    return null;
  }
  return invalidReadConfigReason(toolName, null, preview);
}

/**
 * AU8 — checks an override's optional `display` (rendering hints, a sibling
 * of `preview`). Shape-only, same spirit as `invalidPreviewReason`: every
 * field is an optional string or string array.
 */
export function invalidDisplayHintsReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const display = (entry as { display?: unknown }).display;
  if (display === undefined) return null;
  if (display === null || typeof display !== 'object' || Array.isArray(display)) {
    return `override "${toolName}".display must be an object`;
  }
  const d = display as Record<string, unknown>;
  for (const key of ['order', 'money', 'percent', 'hidden'] as const) {
    if (d[key] === undefined) continue;
    if (!Array.isArray(d[key])) {
      return `override "${toolName}".display.${key} must be an array of field paths`;
    }
    for (const [i, v] of (d[key] as unknown[]).entries()) {
      if (typeof v !== 'string' || v.length === 0) {
        return `override "${toolName}".display.${key}[${i}] must be a non-empty string`;
      }
    }
  }
  if (d.currencyField !== undefined && (typeof d.currencyField !== 'string' || d.currencyField.length === 0)) {
    return `override "${toolName}".display.currencyField must be a non-empty string`;
  }
  if (d.labels !== undefined) {
    if (d.labels === null || typeof d.labels !== 'object' || Array.isArray(d.labels)) {
      return `override "${toolName}".display.labels must be an object mapping field paths to labels`;
    }
    for (const [path, label] of Object.entries(d.labels as Record<string, unknown>)) {
      if (typeof label !== 'string' || label.length === 0) {
        return `override "${toolName}".display.labels.${path} must be a non-empty string`;
      }
    }
  }
  // Now / New table: arg -> dotted path of its current value in an attached read.
  if (d.compare !== undefined) {
    if (d.compare === null || typeof d.compare !== 'object' || Array.isArray(d.compare)) {
      return `override "${toolName}".display.compare must be an object mapping arguments to paths`;
    }
    for (const [arg, path] of Object.entries(d.compare as Record<string, unknown>)) {
      if (typeof path !== 'string' || !PLAIN_PATH_RE.test(path) || !path.includes('.')) {
        return `override "${toolName}".display.compare.${arg} must be "<attach>.<field>"`;
      }
    }
  }
  // attach key -> dotted path of the record's name in that read.
  if (d.names !== undefined) {
    if (d.names === null || typeof d.names !== 'object' || Array.isArray(d.names)
      || !Object.values(d.names as Record<string, unknown>).every((v) => typeof v === 'string' && PLAIN_PATH_RE.test(v))) {
      return `override "${toolName}".display.names must map attach keys to dotted paths`;
    }
  }
  // The card heading's verb: "What will be created/changed in <system>".
  if (d.verb !== undefined && d.verb !== 'created' && d.verb !== 'changed') {
    return `override "${toolName}".display.verb must be "created" or "changed"`;
  }
  // UI spec §15.2/§15.3 — the AI-authored-text argument marker.
  if (d.aiText !== undefined && (typeof d.aiText !== 'string' || d.aiText.length === 0)) {
    return `override "${toolName}".display.aiText must be a non-empty string naming an argument`;
  }
  return null;
}

/**
 * UI spec §6.1 / §12.2 — an override's optional `summary`: the template the
 * gateway fills from the proposal's sealed values to write the approval's
 * one-sentence summary (apps/ui/src/lib/approval-summary.ts renders it, same
 * grammar). Shape-only: {path}, {a,b}, {path|money|percent|list|short|date},
 * optional parts in [ ]. Never AI text — the template is the manifest's.
 */
// `ref`: an id the card can name from its attached read — "Name (id)".
const SUMMARY_FORMATS = ['money', 'percent', 'list', 'short', 'date', 'ref'];
export function invalidSummaryReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const summary = (entry as { summary?: unknown }).summary;
  if (summary === undefined) return null;
  const at = `override "${toolName}".summary`;
  if (typeof summary !== 'string' || summary.trim().length === 0) return `${at} must be a non-empty string`;
  if (summary.length > 200) return `${at} must be at most 200 characters`;
  const balanced = (open: string, close: string): boolean => {
    let d = 0;
    for (const ch of summary) {
      if (ch === open) { d += 1; if (d > 1) return false; }
      if (ch === close) { d -= 1; if (d < 0) return false; }
    }
    return d === 0;
  };
  if (!balanced('{', '}')) return `${at} has unbalanced or nested { }`;
  if (!balanced('[', ']')) return `${at} has unbalanced or nested [ ]`;
  for (const m of summary.matchAll(/\{([^{}]+)\}/g)) {
    const [paths, fmt, extra] = m[1].split('|').map((x) => x.trim());
    if (extra !== undefined) return `${at} {${m[1]}} has more than one format`;
    if (!paths.split(',').every((p) => /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(p.trim()))) {
      return `${at} {${m[1]}} has an invalid field path`;
    }
    if (fmt !== undefined && !SUMMARY_FORMATS.includes(fmt)) return `${at} {${m[1]}} has unknown format "${fmt}"`;
  }
  return null;
}

// ─── D1 — `checks` shape validation (tool-gating-types.ts `CheckDeclaration`) ─

const CHECK_KEYS = new Set(['key', 'label', 'path', 'when', 'forEach', 'pass', 'fail', 'notice', 'notChecked',
  'compare', 'onTrue', 'onFalse', 'missing', 'detail', 'details', 'blocking', 'present', 'absent', 'showOnly']);
const CHECK_LISTS = ['pass', 'fail', 'notice', 'notChecked'] as const;
const DETAIL_FORMATS = ['money', 'percent', 'list', 'short', 'date'];

/** A `[]` path must sit inside a check whose `forEach` names that same array. */
function checkPathReason(at: string, path: unknown, forEach: unknown): string | null {
  if (typeof path !== 'string' || !CHECK_PATH_RE.test(path)) return `${at} has an invalid path ${JSON.stringify(path)}`;
  const b = path.indexOf('[]');
  if (b >= 0 && path.slice(0, b) !== forEach) return `${at} path "${path}" reads an element but forEach is not "${path.slice(0, b)}"`;
  return null;
}

function checkDetailReason(at: string, detail: unknown, forEach: unknown): string | null {
  if (typeof detail !== 'string' || detail.trim().length === 0) return `${at}.detail must be a non-empty string`;
  if (detail.length > 200) return `${at}.detail must be at most 200 characters`;
  // Optional parts `[ … ]` count only outside `{ … }` (a path may contain `[]`).
  let brace = 0; let bracket = 0;
  for (const ch of detail) {
    if (ch === '{') { brace += 1; if (brace > 1) return `${at}.detail has nested { }`; continue; }
    if (ch === '}') { brace -= 1; if (brace < 0) return `${at}.detail has unbalanced { }`; continue; }
    if (brace > 0) continue;
    if (ch === '[') { bracket += 1; if (bracket > 1) return `${at}.detail has nested [ ]`; }
    if (ch === ']') { bracket -= 1; if (bracket < 0) return `${at}.detail has unbalanced [ ]`; }
  }
  if (brace !== 0 || bracket !== 0) return `${at}.detail has unbalanced brackets`;
  for (const m of detail.matchAll(/\{([^{}]+)\}/g)) {
    const [path, fmt, extra] = m[1].split('|').map((x) => x.trim());
    if (extra !== undefined) return `${at}.detail {${m[1]}} has more than one format`;
    if (path === '#') {
      if (typeof forEach !== 'string') return `${at}.detail uses {#} without forEach`;
    } else {
      const r = checkPathReason(`${at}.detail`, path, forEach);
      if (r) return r;
    }
    // `count:<one>/<many>` — "1 invoice" / "4 invoices".
    const isCount = fmt !== undefined && /^count:[^/{}|]+\/[^/{}|]+$/.test(fmt);
    if (fmt !== undefined && !DETAIL_FORMATS.includes(fmt) && !isCount) return `${at}.detail {${m[1]}} has unknown format "${fmt}"`;
  }
  return null;
}

function checkWhenReason(at: string, when: unknown, forEach: unknown): string | null {
  if (when === undefined) return null;
  if (typeof when === 'string') return checkPathReason(`${at}.when`, when, forEach);
  if (when === null || typeof when !== 'object' || Array.isArray(when)) return `${at}.when must be a path or {path, in}`;
  const w = when as Record<string, unknown>;
  const extra = Object.keys(w).find((k) => k !== 'path' && k !== 'in');
  if (extra) return `${at}.when has unknown key "${extra}"`;
  return checkPathReason(`${at}.when.path`, w.path, forEach) ?? checkValueListReason(`${at}.when.in`, w.in);
}

function checkValueListReason(at: string, list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return `${at} must be a non-empty list of values`;
  const ok = list.every((v) => v === null || ['string', 'boolean'].includes(typeof v) || (typeof v === 'number' && Number.isFinite(v)));
  return ok ? null : `${at} may hold only strings, numbers, booleans or null`;
}

function invalidCheckReason(at: string, raw: unknown, seen: Set<string>): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `${at} must be an object`;
  const c = raw as Record<string, unknown>;
  const unknownKey = Object.keys(c).find((k) => !CHECK_KEYS.has(k));
  if (unknownKey) return `${at} has unknown key "${unknownKey}"`;
  if (typeof c.key !== 'string' || c.key.length === 0) return `${at}.key must be a non-empty string`;
  if (seen.has(c.key)) return `${at}.key "${c.key}" is declared twice`;
  seen.add(c.key);
  if (typeof c.label !== 'string' || c.label.trim().length === 0 || c.label.length > 80) {
    return `${at}.label must be a non-empty string of at most 80 characters`;
  }
  if (c.forEach !== undefined && (typeof c.forEach !== 'string' || !/^[A-Za-z_][\w-]*$/.test(c.forEach))) {
    return `${at}.forEach must name an array argument`;
  }
  const pathReason = checkPathReason(`${at}.path`, c.path, c.forEach)
    ?? checkWhenReason(at, c.when, c.forEach);
  if (pathReason) return pathReason;
  const hasList = CHECK_LISTS.some((k) => c[k] !== undefined);
  const hasCompare = c.compare !== undefined;
  const hasPresence = c.present !== undefined || c.absent !== undefined;
  if ([hasList, hasCompare, hasPresence].filter(Boolean).length !== 1) {
    return `${at} must declare exactly one form: value lists (pass/fail/notice/notChecked), compare, or present/absent`;
  }
  if (hasPresence) {
    for (const k of ['present', 'absent'] as const) {
      if (!CHECK_STATUSES.includes(c[k] as CheckStatus)) return `${at}.${k} must be one of ${CHECK_STATUSES.join(', ')} (both required)`;
    }
  }
  for (const k of CHECK_LISTS) {
    if (c[k] === undefined) continue;
    const r = checkValueListReason(`${at}.${k}`, c[k]);
    if (r) return r;
  }
  if (hasCompare) {
    const cmp = c.compare as Record<string, unknown> | null;
    if (cmp === null || typeof cmp !== 'object' || Array.isArray(cmp)) return `${at}.compare must be an object`;
    if (!['eq', 'ne', 'gt', 'lt'].includes(cmp.op as string)) return `${at}.compare.op must be one of eq, ne, gt, lt`;
    if (typeof cmp.to === 'number') {
      if (!Number.isFinite(cmp.to)) return `${at}.compare.to must be a finite number or a path`;
    } else {
      const r = checkPathReason(`${at}.compare.to`, cmp.to, c.forEach);
      if (r) return r;
    }
    const extra = Object.keys(cmp).find((k) => k !== 'op' && k !== 'to');
    if (extra) return `${at}.compare has unknown key "${extra}"`;
  }
  for (const k of ['onTrue', 'onFalse'] as const) {
    if (c[k] === undefined) continue;
    if (!hasCompare) return `${at}.${k} applies to compare only`;
    if (!CHECK_STATUSES.includes(c[k] as CheckStatus)) return `${at}.${k} must be one of ${CHECK_STATUSES.join(', ')}`;
  }
  if (c.blocking !== undefined && typeof c.blocking !== 'boolean') return `${at}.blocking must be a boolean`;
  if (c.showOnly !== undefined && c.showOnly !== 'fail' && c.showOnly !== 'notice') return `${at}.showOnly must be "fail" or "notice"`;
  if (c.missing !== undefined && c.missing !== 'skip' && c.missing !== 'not_checked') {
    return `${at}.missing must be "skip" or "not_checked"`;
  }
  if (c.details !== undefined) {
    if (c.details === null || typeof c.details !== 'object' || Array.isArray(c.details)) return `${at}.details must map a status to a detail`;
    for (const [status, d] of Object.entries(c.details as Record<string, unknown>)) {
      if (!CHECK_STATUSES.includes(status as CheckStatus)) return `${at}.details.${status} is not a status (${CHECK_STATUSES.join(', ')})`;
      const r = checkDetailReason(`${at}.details.${status}`, d, c.forEach);
      if (r) return r;
    }
  }
  if (c.detail !== undefined) return checkDetailReason(at, c.detail, c.forEach);
  return null;
}

/**
 * Shape check for an override's optional `checks` — refuses the manifest on
 * an unknown key, a bad path, neither/both forms, a duplicate key, or more
 * than {@link MAX_CHECKS_PER_TOOL} checks.
 */
export function invalidChecksReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const checks = (entry as { checks?: unknown }).checks;
  if (checks === undefined) return null;
  const base = `override "${toolName}".checks`;
  if (!Array.isArray(checks) || checks.length === 0) return `${base} must be a non-empty list`;
  if (checks.length > MAX_CHECKS_PER_TOOL) return `${base} declares ${checks.length} checks — max ${MAX_CHECKS_PER_TOOL}`;
  const seen = new Set<string>();
  for (const [i, raw] of checks.entries()) {
    const reason = invalidCheckReason(`${base}[${i}]`, raw, seen);
    if (reason) return reason;
  }
  return null;
}

/**
 * Shape check for an override's optional `internal` flag (tool-gating-
 * types.ts `ProfileToolGatingEntry.internal`) — boolean only. WHICH tools
 * should declare it (a connector's own document-preview/archive reads
 * meant only for the gateway itself, never the AI) is a per-connector
 * design choice, not something shape validation can check.
 */
export function invalidInternalReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const internal = (entry as { internal?: unknown }).internal;
  if (internal === undefined) return null;
  if (typeof internal !== 'boolean') return `override "${toolName}".internal must be a boolean`;
  return null;
}

/**
 * Checks every override's `internal` (if any) in one manifest. Same
 * one-predicate-shared-by-loader-and-lint-test shape as
 * `invalidManifestPreviewReason`.
 */
export function invalidManifestInternalReason(manifest: Pick<IntegrationManifest, 'toolGating'>): string | null {
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    const reason = invalidInternalReason(toolName, entry);
    if (reason) return reason;
  }
  return null;
}

// ─── `message` shape validation — the generic replacement for the old   ───
// per-profile footer allowlist + content-field guesswork (tool-gating-
// types.ts's `MessageGatingDeclaration`).

const VALID_MESSAGE_VERBS: readonly MessageVerb[] = ['Sent', 'Published'];

/**
 * Shape check for one override's optional `message` (tool-gating-types.ts
 * `ProfileToolGatingEntry.message`): `text` and `verb` required (non-empty
 * string; `verb` one of {@link VALID_MESSAGE_VERBS}), `to`/`cc`/`subject`
 * optional non-empty strings when present. Refuses the whole manifest on a
 * bad shape — same posture as every other load-time check here — because a
 * malformed declaration would otherwise silently drop the footer/mime-raw
 * build for that tool with no signal.
 */
export function invalidMessageReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const message = (entry as { message?: unknown }).message;
  if (message === undefined) return null;
  if (message === null || typeof message !== 'object') {
    return `override "${toolName}".message must be an object`;
  }
  const m = message as Record<string, unknown>;
  const at = `override "${toolName}".message`;
  if (typeof m.text !== 'string' || m.text.length === 0) {
    return `${at}.text must be a non-empty string`;
  }
  if (typeof m.verb !== 'string' || !VALID_MESSAGE_VERBS.includes(m.verb as MessageVerb)) {
    return `${at}.verb must be one of ${VALID_MESSAGE_VERBS.join(', ')}`;
  }
  for (const key of ['to', 'cc', 'subject'] as const) {
    if (m[key] !== undefined && (typeof m[key] !== 'string' || (m[key] as string).length === 0)) {
      return `${at}.${key} must be a non-empty string`;
    }
  }
  return null;
}

/**
 * `readAlsoUnder` (tool-gating-types.ts): further areas whose mandates may also
 * authorize a READ. Only on an override that is itself `category: "read"`, and
 * never with a `read` adapter (its age window is resolved from one profile's
 * schema — mixing areas could weaken it). Refuses the whole manifest otherwise.
 */
export function invalidManifestReadAlsoUnderReason(manifest: Pick<IntegrationManifest, 'toolGating'>): string | null {
  const overrides = (manifest.toolGating?.overrides ?? {}) as unknown as Record<string, Record<string, unknown> | null>;
  for (const [toolName, entry] of Object.entries(overrides)) {
    const extra = entry?.readAlsoUnder;
    if (extra === undefined) continue;
    const at = `override "${toolName}".readAlsoUnder`;
    if (!Array.isArray(extra) || extra.length === 0 || !extra.every(p => typeof p === 'string' && p.length > 0)) {
      return `${at} must be a non-empty list of area names`;
    }
    if (entry?.category !== 'read') return `${at} is allowed on read tools only (category "read")`;
    if (entry?.read !== undefined) return `${at} cannot be combined with a read adapter (age window)`;
  }
  return null;
}

/**
 * Checks every override's `message` (if any) in one manifest. Same
 * one-predicate-shared-by-loader-and-lint-test shape as
 * `invalidManifestInternalReason`.
 */
export function invalidManifestMessageReason(manifest: Pick<IntegrationManifest, 'toolGating'>): string | null {
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    const reason = invalidMessageReason(toolName, entry);
    if (reason) return reason;
  }
  return null;
}

/** Shared control type, exported so callers can narrow a validated entry. */
export type ValidatedPreviewConfig = ToolPreviewConfig;

/**
 * Checks every override's `preview` (if any) in one manifest. Returns the
 * first refusal reason found, or null if the whole manifest's overrides are
 * clean. Shares the single predicate above with any future lint test, same
 * reasoning as `invalidNpmPinReason`/`isExactSemver`.
 */
export function invalidManifestPreviewReason(manifest: Pick<IntegrationManifest, 'toolGating'>): string | null {
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    const reason = invalidPreviewReason(toolName, entry) ?? invalidDisplayHintsReason(toolName, entry)
      ?? invalidSummaryReason(toolName, entry) ?? invalidChecksReason(toolName, entry);
    if (reason) return reason;
  }
  return null;
}

// ─── AU10 — `context` shape validation (doc/au10-request-context.md §2) ────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * AU10 §8.1 — checks one field mapping: a non-empty string (unchanged), or a
 * `{ path, where?, pick?, parse? }` object. Shape-only, same spirit as
 * `invalidContextReadReason` — whether `path`/`pick` actually resolve on a
 * real record is a runtime question.
 */
const VALID_FIELD_PATH_PARSE: readonly FieldPathParse[] = ['address.name', 'address.email', 'epoch-ms'];

function invalidFieldPathReason(label: string, value: unknown): string | null {
  if (isNonEmptyString(value)) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${label} must be a non-empty string or a field-path object`;
  }
  const f = value as Record<string, unknown>;
  if (!isNonEmptyString(f.path)) return `${label}.path must be a non-empty string`;
  if (f.where !== undefined) {
    if (f.where === null || typeof f.where !== 'object' || Array.isArray(f.where)) {
      return `${label}.where must be an object`;
    }
    for (const [k, v] of Object.entries(f.where as Record<string, unknown>)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return `${label}.where.${k} must be a string, number, or boolean`;
      }
    }
  }
  if (f.pick !== undefined && !isNonEmptyString(f.pick)) {
    return `${label}.pick must be a non-empty string`;
  }
  if (f.parse !== undefined && !VALID_FIELD_PATH_PARSE.includes(f.parse as FieldPathParse)) {
    return `${label}.parse must be one of ${VALID_FIELD_PATH_PARSE.join(', ')}`;
  }
  return null;
}

/** Checks a `{ tool, args }` read descriptor shared by sources/history/recordKeys. */
function invalidContextReadReason(label: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${label} must be an object`;
  }
  const r = entry as Record<string, unknown>;
  if (!isNonEmptyString(r.tool)) return `${label}.tool must be a non-empty string`;
  if (r.args === undefined || r.args === null || typeof r.args !== 'object' || Array.isArray(r.args)) {
    return `${label}.args must be an object`;
  }
  for (const [k, v] of Object.entries(r.args as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.length === 0) {
      return `${label}.args.${k} must be a non-empty string`;
    }
  }
  return null;
}

function invalidContextSourceReason(toolName: string, entry: unknown): string | null {
  const label = `context.sources.${toolName}`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${label} must be an object`;
  }
  const s = entry as Record<string, unknown>;
  const readReason = invalidContextReadReason(`${label}.read`, s.read);
  if (readReason) return readReason;
  for (const field of ['title', 'author', 'at', 'body'] as const) {
    if (s[field] !== undefined) {
      const reason = invalidFieldPathReason(`${label}.${field}`, s[field]);
      if (reason) return reason;
    }
  }
  if (s.keys !== undefined) {
    if (s.keys === null || typeof s.keys !== 'object' || Array.isArray(s.keys)) {
      return `${label}.keys must be an object`;
    }
    for (const [k, v] of Object.entries(s.keys as Record<string, unknown>)) {
      if (k !== 'email') return `${label}.keys.${k}: only "email" is a recognized identity key type`;
      const reason = invalidFieldPathReason(`${label}.keys.${k}`, v);
      if (reason) return reason;
    }
  }
  if (s.chain !== undefined) {
    if (s.chain === null || typeof s.chain !== 'object' || Array.isArray(s.chain)) {
      return `${label}.chain must be an object`;
    }
    const c = s.chain as Record<string, unknown>;
    if (!isNonEmptyString(c.field)) return `${label}.chain.field must be a non-empty string`;
    if (typeof c.max !== 'number' || c.max <= 0) return `${label}.chain.max must be a positive number`;
  }
  return null;
}

function invalidContextHistoryReason(history: unknown): string | null {
  const label = 'context.history';
  if (history === null || typeof history !== 'object' || Array.isArray(history)) {
    return `${label} must be an object`;
  }
  const h = history as Record<string, unknown>;
  const isKeyType = (v: unknown): boolean => v === 'email' || v === 'email_domain';
  if (Array.isArray(h.byKey)) {
    if (h.byKey.length === 0) return `${label}.byKey must not be an empty array`;
    for (const [i, v] of h.byKey.entries()) {
      if (!isKeyType(v)) return `${label}.byKey[${i}] must be "email" or "email_domain"`;
    }
  } else if (!isKeyType(h.byKey)) {
    return `${label}.byKey must be "email" or "email_domain" (or an array of those, in preference order)`;
  }
  const readReason = invalidContextReadReason(`${label}.read`, h.read);
  if (readReason) return readReason;
  if (typeof h.limit !== 'number' || h.limit <= 0) return `${label}.limit must be a positive number`;
  if (typeof h.maxAgeDays !== 'number' || h.maxAgeDays <= 0) return `${label}.maxAgeDays must be a positive number`;
  if (h.item === null || typeof h.item !== 'object' || Array.isArray(h.item)) {
    return `${label}.item must be an object`;
  }
  for (const [k, v] of Object.entries(h.item as Record<string, unknown>)) {
    // `kind` is a literal label, copied as-is — never a path (doc §8.1).
    if (k === 'kind') {
      if (!isNonEmptyString(v)) return `${label}.item.kind must be a non-empty string`;
      continue;
    }
    const reason = invalidFieldPathReason(`${label}.item.${k}`, v);
    if (reason) return reason;
  }
  return null;
}

/**
 * AU10 §8.2 — shape of one recordKeys entry: `keys` (identity fields of
 * THIS record) and/or `next` (a second record to follow). At least one must
 * be present — an entry with neither reads a record and learns nothing from
 * it, which is never useful.
 */
function invalidContextRecordKeyReason(name: string, entry: unknown): string | null {
  const label = `context.recordKeys.${name}`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${label} must be an object`;
  }
  const rk = entry as Record<string, unknown>;
  const readReason = invalidContextReadReason(`${label}.read`, rk.read);
  if (readReason) return readReason;
  if (rk.keys !== undefined) {
    if (rk.keys === null || typeof rk.keys !== 'object' || Array.isArray(rk.keys)) {
      return `${label}.keys must be an object`;
    }
    for (const [k, v] of Object.entries(rk.keys as Record<string, unknown>)) {
      if (k !== 'email') return `${label}.keys.${k}: only "email" is a recognized identity key type`;
      const reason = invalidFieldPathReason(`${label}.keys.${k}`, v);
      if (reason) return reason;
    }
  }
  if (rk.next !== undefined) {
    if (rk.next === null || typeof rk.next !== 'object' || Array.isArray(rk.next)) {
      return `${label}.next must be an object`;
    }
    const next = rk.next as Record<string, unknown>;
    if (!isNonEmptyString(next.recordKey)) return `${label}.next.recordKey must be a non-empty string`;
    if (!isNonEmptyString(next.field)) return `${label}.next.field must be a non-empty string`;
  }
  if (rk.keys === undefined && rk.next === undefined) {
    return `${label} must declare "keys", "next", or both — an entry with neither learns nothing from the record it reads`;
  }
  return null;
}

/**
 * AU10 §8.2 — walks a recordKeys entry's `next` chain, counting steps
 * (this entry counts as step 1). Returns the chain length, `'cycle'` when a
 * name reappears, or `'missing'` when `next.recordKey` names an entry this
 * SAME manifest does not declare (a cross-manifest reference is never
 * meaningful — recordKeys are always read on the connector that declares
 * them).
 */
function recordKeyChainLength(
  name: string,
  recordKeys: Record<string, unknown>,
  seen: ReadonlySet<string>,
): number | 'cycle' | 'missing' {
  if (seen.has(name)) return 'cycle';
  const entry = recordKeys[name];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'missing';
  const next = (entry as Record<string, unknown>).next as Record<string, unknown> | undefined;
  if (!next || typeof next !== 'object') return 1;
  const nextName = next.recordKey;
  if (typeof nextName !== 'string' || !(nextName in recordKeys)) return 'missing';
  const rest = recordKeyChainLength(nextName, recordKeys, new Set([...seen, name]));
  if (rest === 'cycle' || rest === 'missing') return rest;
  return 1 + rest;
}

/**
 * Returns a human-readable refusal reason if `manifest.context` (AU10,
 * doc/au10-request-context.md §2) is malformed, or null if absent/well-formed.
 * Shape-only, same spirit as `invalidManifestPreviewReason` — whether a
 * declared tool actually exists on the connector is a runtime question
 * (checked by request-context.ts's own reads, same pattern as preview.ts).
 */
export function invalidManifestContextReason(
  manifest: Pick<IntegrationManifest, 'context' | 'toolGating'>,
): string | null {
  const ctx = manifest.context;
  const recordKeyNames = new Set(Object.keys(ctx?.recordKeys ?? {}));
  if (ctx) {
    if (ctx.sources !== undefined) {
      if (ctx.sources === null || typeof ctx.sources !== 'object' || Array.isArray(ctx.sources)) {
        return 'context.sources must be an object';
      }
      for (const [kind, entry] of Object.entries(ctx.sources)) {
        const reason = invalidContextSourceReason(kind, entry);
        if (reason) return reason;
      }
    }
    if (ctx.history !== undefined) {
      const reason = invalidContextHistoryReason(ctx.history);
      if (reason) return reason;
    }
    if (ctx.recordKeys !== undefined) {
      if (ctx.recordKeys === null || typeof ctx.recordKeys !== 'object' || Array.isArray(ctx.recordKeys)) {
        return 'context.recordKeys must be an object';
      }
      for (const [name, entry] of Object.entries(ctx.recordKeys)) {
        const reason = invalidContextRecordKeyReason(name, entry);
        if (reason) return reason;
      }
      // AU10 §8.2 — max MAX_RECORD_KEY_STEPS steps, no cycles, no dangling
      // `next.recordKey` reference. Checked once every entry's own shape is
      // known to be well-formed.
      for (const name of Object.keys(ctx.recordKeys)) {
        const length = recordKeyChainLength(name, ctx.recordKeys, new Set());
        if (length === 'cycle') {
          return `context.recordKeys.${name}.next forms a cycle`;
        }
        if (length === 'missing') {
          return `context.recordKeys.${name}.next.recordKey names an entry this manifest does not declare`;
        }
        if (length > MAX_RECORD_KEY_STEPS) {
          return `context.recordKeys.${name}.next chain is ${length} steps long — max ${MAX_RECORD_KEY_STEPS}`;
        }
      }
    }
  }

  // Per-tool contextKeys/sourceFromArg overrides — cross-checked against this
  // SAME manifest's declared sources/recordKeys (never a runtime guess).
  const sourceKinds = new Set(Object.keys(ctx?.sources ?? {}));
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { contextKeys?: unknown; sourceFromArg?: unknown };
    if (e.contextKeys !== undefined) {
      if (e.contextKeys === null || typeof e.contextKeys !== 'object' || Array.isArray(e.contextKeys)) {
        return `override "${toolName}".contextKeys must be an object`;
      }
      for (const [name, argName] of Object.entries(e.contextKeys as Record<string, unknown>)) {
        if (!isNonEmptyString(argName)) {
          return `override "${toolName}".contextKeys.${name} must be a non-empty string naming an action argument`;
        }
        if (name !== 'email' && !recordKeyNames.has(name)) {
          return `override "${toolName}".contextKeys.${name}: "${name}" is neither "email" nor a ` +
            `context.recordKeys entry on this manifest`;
        }
      }
    }
    if (e.sourceFromArg !== undefined) {
      if (e.sourceFromArg === null || typeof e.sourceFromArg !== 'object' || Array.isArray(e.sourceFromArg)) {
        return `override "${toolName}".sourceFromArg must be an object`;
      }
      const sfa = e.sourceFromArg as Record<string, unknown>;
      if (!isNonEmptyString(sfa.kind)) return `override "${toolName}".sourceFromArg.kind must be a non-empty string`;
      if (!isNonEmptyString(sfa.arg)) return `override "${toolName}".sourceFromArg.arg must be a non-empty string`;
      if (!sourceKinds.has(sfa.kind as string)) {
        return `override "${toolName}".sourceFromArg.kind "${String(sfa.kind)}" is not declared in this ` +
          `manifest's context.sources`;
      }
    }
  }
  return null;
}

// ─── Documents / attachments / inserted values (suveren-invoicing-plan.md §6/§7) ──

/**
 * Checks one `documents.<kind>` entry: the shared `{tool, args}` read shape,
 * plus the one extra rule specific to a document source — the named `tool`
 * must be `internal: true` on this SAME manifest's `toolGating.overrides`.
 * A document read answers with file bytes; it must never be something the
 * AI could call directly (the same posture `invalidInternalReason` already
 * enforces for a connector's own preview/archive reads).
 */
function invalidDocumentSourceReason(
  kind: string,
  entry: unknown,
  overrides: Record<string, unknown>,
): string | null {
  const label = `documents.${kind}`;
  const readReason = invalidContextReadReason(label, entry);
  if (readReason) return readReason;
  const tool = (entry as { tool: string }).tool;
  const toolEntry = overrides[tool] as { internal?: unknown } | null | undefined;
  if (toolEntry?.internal !== true) {
    return `${label}.tool "${tool}" must be marked "internal: true" on this manifest's ` +
      `toolGating.overrides — a document read must never be directly callable by the AI`;
  }
  // UI spec §15.2 — the optional display label template (a plain string;
  // `{id}` is the only recognized placeholder, substituted by the UI, not
  // this grammar's `$`-prefixed args substitution).
  const docLabel = (entry as { label?: unknown }).label;
  if (docLabel !== undefined && (typeof docLabel !== 'string' || docLabel.length === 0)) {
    return `${label}.label must be a non-empty string`;
  }
  return null;
}

/** Checks the manifest's top-level `attachments` transport declaration's own shape. */
function invalidAttachmentTransportReason(entry: unknown): string | null {
  const label = 'attachments';
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return `${label} must be an object`;
  const a = entry as Record<string, unknown>;
  if (a.transport !== 'field' && a.transport !== 'mime-raw') {
    return `${label}.transport must be "field" or "mime-raw"`;
  }
  if (!isNonEmptyString(a.arg)) return `${label}.arg must be a non-empty string`;
  return null;
}

/** Checks one `values.<kind>` entry: the shared read shape, plus `path`/`allowedHosts`. */
function invalidInsertValueSourceReason(kind: string, entry: unknown): string | null {
  const label = `values.${kind}`;
  const readReason = invalidContextReadReason(label, entry);
  if (readReason) return readReason;
  const v = entry as Record<string, unknown>;
  if (!isNonEmptyString(v.path)) return `${label}.path must be a non-empty string`;
  if (!Array.isArray(v.allowedHosts) || v.allowedHosts.length === 0) {
    return `${label}.allowedHosts must be a non-empty array of hostnames`;
  }
  for (const [i, h] of v.allowedHosts.entries()) {
    if (typeof h !== 'string' || h.length === 0) return `${label}.allowedHosts[${i}] must be a non-empty string`;
  }
  return null;
}

/**
 * Returns a refusal reason if `manifest.documents` (if any) is malformed, or
 * null if absent/well-formed.
 */
export function invalidManifestDocumentsReason(
  manifest: Pick<IntegrationManifest, 'documents' | 'toolGating'>,
): string | null {
  if (!manifest.documents) return null;
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [kind, entry] of Object.entries(manifest.documents)) {
    const reason = invalidDocumentSourceReason(kind, entry, overrides);
    if (reason) return reason;
  }
  return null;
}

/**
 * Returns a refusal reason if `manifest.attachments` (if any) is malformed,
 * OR any override's `attachmentsArg`/`insertFields` is malformed, OR an
 * override declares `attachmentsArg` while this manifest declares no
 * top-level `attachments` transport (a tool cannot opt in to attachments
 * without its connector saying how it receives them).
 */
export function invalidManifestAttachmentsReason(
  manifest: Pick<IntegrationManifest, 'attachments' | 'toolGating'>,
): string | null {
  if (manifest.attachments !== undefined) {
    const reason = invalidAttachmentTransportReason(manifest.attachments);
    if (reason) return reason;
  }
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { attachmentsArg?: unknown; insertFields?: unknown };
    if (e.attachmentsArg !== undefined) {
      if (typeof e.attachmentsArg !== 'string' || e.attachmentsArg.length === 0) {
        return `override "${toolName}".attachmentsArg must be a non-empty string`;
      }
      if (!manifest.attachments) {
        return `override "${toolName}" declares "attachmentsArg" but this manifest declares no ` +
          `top-level "attachments" transport`;
      }
    }
    if (e.insertFields !== undefined) {
      if (!Array.isArray(e.insertFields) || e.insertFields.length === 0) {
        return `override "${toolName}".insertFields must be a non-empty array of argument names`;
      }
      for (const [i, f] of e.insertFields.entries()) {
        if (typeof f !== 'string' || f.length === 0) {
          return `override "${toolName}".insertFields[${i}] must be a non-empty string`;
        }
      }
    }
  }
  return null;
}

/**
 * Returns a refusal reason if `manifest.values` (if any) is malformed, or
 * null if absent/well-formed.
 */
export function invalidManifestValuesReason(
  manifest: Pick<IntegrationManifest, 'values'>,
): string | null {
  if (!manifest.values) return null;
  for (const [kind, entry] of Object.entries(manifest.values)) {
    const reason = invalidInsertValueSourceReason(kind, entry);
    if (reason) return reason;
  }
  return null;
}

// ─── Area per tool — an override may name its OWN profile ─────────────────

/**
 * An override's own `profile` (area per tool — see tool-gating-types.ts's
 * `ProfileToolGatingEntry.profile`), read from a value whose static type may
 * not yet declare the field (same widened-read pattern integration-
 * manager.ts's `resolveToolGating` uses).
 */
function overrideProfile(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const p = (entry as { profile?: unknown }).profile;
  return typeof p === 'string' ? p : undefined;
}

/**
 * Every distinct profile this manifest's tools are actually gated under:
 * the manifest's own `profile`, plus any override's own `profile` (area per
 * tool). Order: manifest's profile first, then overrides in declaration
 * order — stable, so a refusal reason naming "the first bad profile" is
 * deterministic.
 */
function distinctProfilesOf(manifest: Pick<IntegrationManifest, 'profile' | 'toolGating'>): string[] {
  const out = [manifest.profile];
  for (const entry of Object.values(manifest.toolGating?.overrides ?? {})) {
    const p = overrideProfile(entry);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Returns a human-readable refusal reason if any override's own `profile`
 * (area per tool) fails to resolve to a known profile — full id or short
 * name, the SAME resolution `getProfile` gives `manifest.profile` itself —
 * or null if every declared override profile resolves (or none is declared
 * at all). Mirrors `invalidNpmPinReason`'s shape: one predicate, shared by
 * the loader and any lint test, so the two can never disagree.
 *
 * Like `invalidManifestReadGateReason`, this SKIPS (returns null) when
 * profiles haven't been loaded yet — not a pass on a real defect, see that
 * function's doc comment for why that gap is acceptable.
 */
export function invalidManifestOverrideProfilesReason(
  manifest: Pick<IntegrationManifest, 'profile' | 'toolGating'>,
): string | null {
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    const profile = overrideProfile(entry);
    if (!profile) continue;
    // Nothing registered to check against yet (isolated test) — not our call.
    if (!getProfile(manifest.profile) && !getProfile(profile)) continue;
    if (!getProfile(profile)) {
      return `override "${toolName}".profile "${profile}" does not resolve to a known profile ` +
        `(full id or short name) — area-per-tool overrides must name a real profile, same as the ` +
        `manifest's own "profile"`;
    }
  }
  return null;
}

// ─── D6 — read-gate coverage for the profile's enum switches ───────────────

/**
 * Returns a human-readable refusal reason if `manifest`'s `category:"read"`
 * overrides fail to cover THEIR OWN profile's read-side enum switch(es) (D6
 * — `read-gate.ts`'s `uncoveredReadSwitchReason`, the shared predicate), or
 * null if clean. Resolves each profile the SAME way the running gateway does
 * — `getProfile(...)`, after `loadProfiles()` has registered every
 * hap-profiles version under both its full id and its short name,
 * last-registered-wins (profile-loader.ts), which hap-profiles/index.json
 * orders oldest→newest per family, so the short name always resolves to the
 * latest version.
 *
 * Area per tool: a manifest may gate different tools under different
 * profiles (an override's own `profile`, see `distinctProfilesOf`). The
 * check runs ONCE PER DISTINCT PROFILE the manifest actually uses, each time
 * against only the overrides that resolve to THAT profile — an override
 * belonging to profile B must never be checked against profile A's switches
 * (and vice versa), or a connector spanning two areas could never pass.
 *
 * Skips (returns null) a profile that isn't registered — e.g. a unit test
 * that loads manifests without first loading profiles. That is a GAP in
 * what gets checked, not a pass on a real defect: `loadManifests()` always
 * runs after `loadProfiles()` at real startup (bin/http.ts), so production
 * manifests are never silently exempted; only isolated tests are, the same
 * way they already are for the runtime "Unknown profile" refusal this check
 * does not replace.
 */
export function invalidManifestReadGateReason(
  manifest: Pick<IntegrationManifest, 'profile' | 'toolGating'>,
): string | null {
  const allOverrides = manifest.toolGating?.overrides ?? {};
  for (const profileId of distinctProfilesOf(manifest)) {
    const profileDef = getProfile(profileId);
    if (!profileDef) continue;
    const ownOverrides: Record<string, unknown> = {};
    for (const [toolName, entry] of Object.entries(allOverrides)) {
      const resolved = overrideProfile(entry) ?? manifest.profile;
      if (resolved === profileId) ownOverrides[toolName] = entry;
    }
    const reason = uncoveredReadSwitchReason(ownOverrides, profileDef.boundsSchema as BoundsSchemaLike | undefined);
    if (reason) return reason;
  }
  return null;
}

// ─── Mode display labels ───────────────────────────────────────────────────

/**
 * Returns a human-readable refusal reason if `manifest.modeLabels` (if any)
 * is malformed, or null if absent/well-formed. Shares the single-predicate
 * shape every other manifest-shape check here uses (see `invalidNpmPinReason`).
 *
 * `modeLabels` only makes sense alongside `simulation` (the mode value it's
 * keyed by comes from that same field), and an adapter-keyed (object) entry
 * needs `adapterField` to name a REAL declared credential field — otherwise
 * the gateway would have no way to resolve which label applies.
 */
/**
 * D3 — top-level `network` (tool-gating-types.ts `NetworkDeclaration`): a
 * list of `{host, purpose, sends, modes?}`. `host` is a bare host name (no
 * scheme, path or port); `modes` keys are modes, each `true` or a non-empty
 * list of adapter values. Refuses the manifest otherwise.
 */
export function invalidNetworkReason(manifest: Pick<IntegrationManifest, 'network'>): string | null {
  const network = (manifest as { network?: unknown }).network;
  if (network === undefined) return null;
  if (!Array.isArray(network) || network.length === 0) return 'network must be a non-empty list of outside calls';
  for (const [i, raw] of network.entries()) {
    const at = `network[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `${at} must be an object`;
    const n = raw as Record<string, unknown>;
    const extra = Object.keys(n).find((k) => !['modes', 'host', 'purpose', 'sends'].includes(k));
    if (extra) return `${at} has unknown key "${extra}"`;
    if (typeof n.host !== 'string' || !/^(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(n.host)) {
      return `${at}.host must be a bare host name, e.g. "api.example.com"`;
    }
    for (const k of ['purpose', 'sends'] as const) {
      if (typeof n[k] !== 'string' || (n[k] as string).trim().length === 0 || (n[k] as string).length > 200) {
        return `${at}.${k} must be a non-empty string of at most 200 characters`;
      }
    }
    if (n.modes !== undefined) {
      if (n.modes === null || typeof n.modes !== 'object' || Array.isArray(n.modes) || Object.keys(n.modes).length === 0) {
        return `${at}.modes must be an object mapping a mode to true or a list of adapters`;
      }
      for (const [mode, v] of Object.entries(n.modes as Record<string, unknown>)) {
        const ok = v === true || (Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' && a.length > 0));
        if (!ok) return `${at}.modes.${mode} must be true or a non-empty list of adapter names`;
      }
    }
  }
  return null;
}

export function invalidModeLabelsReason(
  manifest: Pick<IntegrationManifest, 'modeLabels' | 'adapterField' | 'simulation' | 'credentials'>,
): string | null {
  if (!manifest.modeLabels) return null;
  if (manifest.modeLabels === null || typeof manifest.modeLabels !== 'object' || Array.isArray(manifest.modeLabels)) {
    return 'modeLabels must be an object mapping mode values to labels';
  }
  if (!manifest.simulation) {
    return 'modeLabels is set but this manifest declares no "simulation" marker — mode labels need a mode field to key off';
  }
  const fieldKeys = new Set(manifest.credentials?.fields?.map(f => f.key) ?? []);
  let needsAdapterField = false;
  for (const [mode, label] of Object.entries(manifest.modeLabels)) {
    if (typeof label === 'string') {
      if (label.length === 0) return `modeLabels.${mode} must be a non-empty string`;
      continue;
    }
    if (label === null || typeof label !== 'object' || Array.isArray(label)) {
      return `modeLabels.${mode} must be a non-empty string or an object keyed by adapter value`;
    }
    needsAdapterField = true;
    for (const [adapter, adapterLabel] of Object.entries(label)) {
      if (typeof adapterLabel !== 'string' || adapterLabel.length === 0) {
        return `modeLabels.${mode}.${adapter} must be a non-empty string`;
      }
    }
  }
  if (needsAdapterField && !manifest.adapterField) {
    return 'modeLabels has an adapter-keyed entry but "adapterField" is missing — name the credential field holding the adapter';
  }
  if (manifest.adapterField && !fieldKeys.has(manifest.adapterField)) {
    return `adapterField "${manifest.adapterField}" does not name a declared credential field`;
  }
  return null;
}

// ─── Module state ───────────────────────────────────────────────────────────

const manifests = new Map<string, IntegrationManifest>();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load all integration manifests from disk.
 * Returns the number of manifests loaded.
 */
export function loadManifests(integrationsDir?: string): number {
  // Default: ../../../../content/integrations relative to this file (src/lib/ → apps/mcp-server → suveren-gateway/content/integrations)
  const dir = resolve(
    integrationsDir ??
    process.env.SUVEREN_MANIFESTS_DIR ??
    join(import.meta.dirname ?? __dirname, '..', '..', '..', '..', 'content', 'integrations'),
  );
  const indexPath = join(dir, 'index.json');

  if (!existsSync(indexPath)) {
    console.error(`[ManifestLoader] No index.json found at ${indexPath}, skipping manifest loading`);
    return 0;
  }

  let index: ManifestIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch (err) {
    console.error(`[ManifestLoader] Failed to parse ${indexPath}:`, err);
    return 0;
  }

  let loaded = 0;
  for (const [id, relativePath] of Object.entries(index.integrations)) {
    const manifestPath = join(dir, relativePath);
    try {
      const manifest: IntegrationManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const pinReason = invalidNpmPinReason(manifest);
      if (pinReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${pinReason}`);
        continue;
      }
      const previewReason = invalidManifestPreviewReason(manifest);
      if (previewReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${previewReason}`);
        continue;
      }
      const internalReason = invalidManifestInternalReason(manifest);
      if (internalReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${internalReason}`);
        continue;
      }
      const readAlsoReason = invalidManifestReadAlsoUnderReason(manifest);
      if (readAlsoReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${readAlsoReason}`);
        continue;
      }
      const messageReason = invalidManifestMessageReason(manifest);
      if (messageReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${messageReason}`);
        continue;
      }
      const contextReason = invalidManifestContextReason(manifest);
      if (contextReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${contextReason}`);
        continue;
      }
      const overrideProfilesReason = invalidManifestOverrideProfilesReason(manifest);
      if (overrideProfilesReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${overrideProfilesReason}`);
        continue;
      }
      const readGateReason = invalidManifestReadGateReason(manifest);
      if (readGateReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${readGateReason}`);
        continue;
      }
      const documentsReason = invalidManifestDocumentsReason(manifest);
      if (documentsReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${documentsReason}`);
        continue;
      }
      const attachmentsReason = invalidManifestAttachmentsReason(manifest);
      if (attachmentsReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${attachmentsReason}`);
        continue;
      }
      const valuesReason = invalidManifestValuesReason(manifest);
      if (valuesReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${valuesReason}`);
        continue;
      }
      const networkReason = invalidNetworkReason(manifest);
      if (networkReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${networkReason}`);
        continue;
      }
      const modeLabelsReason = invalidModeLabelsReason(manifest)
        // modeNotes (a short line under the card title per mode, e.g. "On this
        // computer — no shared access") has exactly modeLabels' shape.
        ?? (manifest.modeNotes ? invalidModeLabelsReason({ ...manifest, modeLabels: manifest.modeNotes })?.replace(/modeLabels/g, 'modeNotes') ?? null : null);
      if (modeLabelsReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${modeLabelsReason}`);
        continue;
      }
      manifests.set(id, manifest);
      loaded++;
    } catch (err) {
      console.error(`[ManifestLoader] Failed to load manifest ${id} from ${manifestPath}:`, err);
    }
  }

  console.error(`[ManifestLoader] Loaded ${loaded} integration manifest(s) from ${dir}`);
  return loaded;
}

/**
 * Get a specific integration manifest by ID.
 */
export function getManifest(id: string): IntegrationManifest | undefined {
  return manifests.get(id);
}

/**
 * Get all loaded integration manifests.
 */
export function getAllManifests(): IntegrationManifest[] {
  return Array.from(manifests.values());
}
