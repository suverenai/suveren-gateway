/**
 * AU10 — Request and history on the approval card (doc/au10-request-context.md).
 *
 * Builds on AU8's read engine (preview.ts's `readPreview`, same timeout and
 * unavailable/not_found/ok shape) but is a SEPARATE, gateway-internal read
 * path: these reads are never returned to the AI, never sent to the
 * Authority Server, never counted against the AI's own read limits (§0
 * invariants). Consumed by bin/http.ts's `POST /internal/request-context`.
 *
 * Three independent pieces, each degrading on its own (a failure in one
 * never blocks the other, or the approval decision):
 *  1. `_source` / `sourceFromArg` — resolves the ONE record the AI claims to
 *     be answering (§1), optionally following a declared thread `chain`.
 *  2. Identity keys — gathered from the action's own `contextKeys` and from
 *     the resolved source's declared `keys`, generically (never a hardcoded
 *     field name) via each connector's manifest `context` block (§2).
 *  3. History — every loaded manifest that declares `context.history` is
 *     asked for its latest entries matching a gathered key of its own
 *     declared `byKey` type (§2–§3).
 */
import { getByDottedPath } from './read-gate';
import { resolveFieldPath } from './field-path';
import { readPreview, type PreviewBody } from './preview';
import { getManifest, getAllManifests, type IntegrationManifest } from './manifest-loader';
import {
  MAX_RECORD_KEY_STEPS,
  type ContextSourceConfig,
  type ContextHistoryConfig,
  type ContextRecordKeyConfig,
  type ContextKeysDeclaration,
  type SourceFromArgDeclaration,
  type HistoryKeyType,
} from './tool-gating-types';
import type { IntegrationManager } from './integration-manager';
import type { ExecutionJournal } from './execution-journal';

// ─── `_source` — offered on every non-read connector tool (doc §1) ────────

/** The one object key the gateway injects/strips. */
export const SOURCE_LINK_ARG = '_source';

/**
 * Adds the optional `_source` property to a (non-read) connector tool's
 * discovered input schema — "injected by the gateway into the tool's input
 * schema with a description telling the AI to link the request it is
 * answering" (doc §1). Idempotent: a schema that already declares `_source`
 * (should never happen for a real connector) is left untouched rather than
 * clobbered. Never applied to a tool the manifest marks `category: "read"`.
 */
export function withSourceLink(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  if ('_source' in props) return schema;
  return {
    ...schema,
    properties: {
      ...props,
      _source: {
        type: 'object',
        description:
          'Optional. Link the request you are answering — the ONE record (e.g. an inbound email) this ' +
          'action responds to, so the human approver can see why it was proposed. Only a reference: ' +
          '{"connector": "<integration id>", "kind": "<declared kind>", "id": "<record id>"}. ' +
          'Example: {"connector":"mail","kind":"message","id":"m-17"}. The gateway reads the record itself ' +
          '— never write a summary or quote here.',
        properties: {
          connector: { type: 'string' },
          kind: { type: 'string' },
          id: { type: 'string' },
        },
      },
    },
  };
}

/** Strips `_source` before a connector ever sees the call — never executed
 *  downstream (doc §1, "stripped before execution, like `_imagePreview`"). */
export function stripSourceLink<T extends Record<string, unknown>>(args: T): T {
  if (!(SOURCE_LINK_ARG in args)) return args;
  const { [SOURCE_LINK_ARG]: _omit, ...rest } = args;
  return rest as T;
}

// ─── Free-mail domains (doc §2) — never used as an email_domain key ────────

/**
 * Shared consumer mail providers. Never used as an `email_domain` identity
 * key — only the exact address can identify a customer on one of these
 * (doc/au10-request-context.md §2, "Free-mail domains ... are never used as
 * `email_domain` keys — only exact `email`"). Not exhaustive by design (new
 * providers appear); this is a safety floor, not a directory.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'yahoo.fr', 'ymail.com', 'rocketmail.com',
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'gmx.com',
  'web.de', 't-online.de', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com', 'yandex.com',
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

// ─── Identity keys ──────────────────────────────────────────────────────────

export interface IdentityKey {
  type: HistoryKeyType;
  value: string;
}

/** `email` ⇒ also `email_domain`, unless the domain is free-mail (doc §2). */
export function deriveIdentityKeysFromEmail(email: string): IdentityKey[] {
  const lower = email.toLowerCase().trim();
  const at = lower.lastIndexOf('@');
  if (at <= 0 || at === lower.length - 1) return [];
  const domain = lower.slice(at + 1);
  const keys: IdentityKey[] = [{ type: 'email', value: lower }];
  if (!isFreeMailDomain(domain)) keys.push({ type: 'email_domain', value: domain });
  return keys;
}

/** A context-key source value may be a single email string or a list of
 *  them (e.g. `send_message`'s `to`) — every one contributes keys. */
export function deriveIdentityKeysFromValue(value: unknown): IdentityKey[] {
  if (typeof value === 'string') return deriveIdentityKeysFromEmail(value);
  if (Array.isArray(value)) {
    return value.flatMap((v) => (typeof v === 'string' ? deriveIdentityKeysFromEmail(v) : []));
  }
  return [];
}

function dedupeKeys(keys: IdentityKey[]): IdentityKey[] {
  const seen = new Set<string>();
  const out: IdentityKey[] = [];
  for (const k of keys) {
    const sig = `${k.type}:${k.value}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(k);
  }
  return out;
}

// ─── Read plumbing shared by sources/history/recordKeys ────────────────────

/** Substitutes `$name` placeholders in a read's declared `args` template
 *  against resolved values. A template value that isn't a placeholder is
 *  never produced by today's manifests, so it is passed through unchanged
 *  rather than rejected — same leniency as mapPreviewArgs. */
/**
 * Builds a read tool's args from a `{ tool, args }` declaration's template:
 * a literal string is passed as-is, a `$`-prefixed token is replaced with
 * `values[token.slice(1)]` (when present — absent otherwise). Shared by
 * every manifest-declared read here AND by document-source.ts/insert-
 * values.ts, which resolve the SAME grammar for `documents`/`values`
 * declarations (suveren-invoicing-plan.md §6/§7) — one substitution rule,
 * used everywhere a manifest names a read against a reference's own id.
 */
export function substitute(template: Record<string, string>, values: Record<string, string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [arg, token] of Object.entries(template)) {
    if (token.startsWith('$')) {
      const key = token.slice(1);
      if (key in values) out[arg] = values[key];
    } else {
      out[arg] = token;
    }
  }
  return out;
}

/** Many connector reads here (get_timeline's array result, in particular)
 *  predate structured output — `structuredContent` is normally absent and
 *  the JSON lives in the text item instead. Prefer structured when present
 *  (forward-compatible), else parse the text. */
function parseContextBody(body: PreviewBody): unknown {
  if (body.structured !== undefined) return body.structured;
  if (body.text !== undefined) {
    try {
      return JSON.parse(body.text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readContextRecord(
  integrationManager: IntegrationManager,
  connectorId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ status: 'ok'; record: unknown } | { status: 'unavailable'; reason: string } | { status: 'not_found' }> {
  const read = await readPreview(integrationManager, connectorId, tool, args);
  if (read.status === 'ok') {
    const record = parseContextBody(read.body);
    if (record === undefined) return { status: 'unavailable', reason: 'connector_error' };
    return { status: 'ok', record };
  }
  if (read.status === 'not_found') return { status: 'not_found' };
  return { status: 'unavailable', reason: read.reason };
}

// ─── 1. Request — resolving `_source` / `sourceFromArg` (doc §1) ──────────

export interface SourceLink {
  connector: string;
  kind: string;
  id: string;
}

function parseExplicitSourceLink(raw: unknown): SourceLink | 'invalid' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const o = raw as Record<string, unknown>;
  if (typeof o.connector !== 'string' || !o.connector) return 'invalid';
  if (typeof o.kind !== 'string' || !o.kind) return 'invalid';
  if (typeof o.id !== 'string' || !o.id) return 'invalid';
  return { connector: o.connector, kind: o.kind, id: o.id };
}

export interface RequestChainItem {
  author?: string;
  at?: string;
  title?: string;
  body?: string;
}

export type RequestResult =
  | { status: 'none' }
  | { status: 'unreadable'; reason: string }
  | { status: 'not_found' }
  | {
      status: 'ok';
      connector: string;
      kind: string;
      /** True when this link came from a manifest's `sourceFromArg`, not an
       *  explicit `_source` the AI supplied. */
      implicit: boolean;
      author?: string;
      at?: string;
      title?: string;
      body?: string;
      chain: RequestChainItem[];
    };

/** Explicit `_source` wins when both are present (doc §1 lists it first;
 *  `sourceFromArg` exists so an action that already carries a reference
 *  "needs no `_source`" — a fallback, not an override). */
function resolveSourceLink(
  toolArgs: Record<string, unknown>,
  connectorId: string,
  sourceFromArg: SourceFromArgDeclaration | undefined,
): SourceLink | 'invalid' | undefined {
  const explicit = parseExplicitSourceLink(toolArgs._source);
  if (explicit !== undefined) return explicit;
  if (sourceFromArg) {
    const argVal = toolArgs[sourceFromArg.arg];
    if (typeof argVal === 'string' && argVal) {
      return { connector: connectorId, kind: sourceFromArg.kind, id: argVal };
    }
  }
  return undefined;
}

async function readSourceOnce(
  integrationManager: IntegrationManager,
  link: SourceLink,
  sourceConfig: ContextSourceConfig,
): Promise<{ record: unknown; keys: IdentityKey[] } | { status: 'unreadable' | 'not_found'; reason?: string }> {
  const args = substitute(sourceConfig.read.args, { id: link.id });
  const read = await readContextRecord(integrationManager, link.connector, sourceConfig.read.tool, args);
  if (read.status === 'not_found') return { status: 'not_found' };
  if (read.status === 'unavailable') return { status: 'unreadable', reason: read.reason };
  const keys: IdentityKey[] = [];
  if (sourceConfig.keys?.email) {
    const v = resolveFieldPath(read.record, sourceConfig.keys.email);
    if (typeof v === 'string' && v) keys.push(...deriveIdentityKeysFromEmail(v));
  }
  return { record: read.record, keys };
}

/** Resolves the full Request block, including a declared `chain` (doc §1:
 *  "Thread chain shown collapsed below"), capped at `chain.max` hops. A
 *  failing/missing chain hop simply stops the chain — it never turns the
 *  primary record's own result into an error. */
export async function resolveRequestContext(
  integrationManager: IntegrationManager,
  toolArgs: Record<string, unknown>,
  actionConnectorId: string,
  sourceFromArg: SourceFromArgDeclaration | undefined,
  /** AU10 F4 — connector ids actually configured on THIS gateway (installed,
   *  whether currently running or not) — see buildRequestContext's doc
   *  comment. An explicit `_source` may name any connector id; a gateway
   *  that never set that connector up at all must say so plainly rather
   *  than guess at a manifest it merely happens to have on disk. */
  configuredConnectorIds: ReadonlySet<string>,
): Promise<{ result: RequestResult; keys: IdentityKey[] }> {
  const link = resolveSourceLink(toolArgs, actionConnectorId, sourceFromArg);
  if (link === undefined) return { result: { status: 'none' }, keys: [] };
  if (link === 'invalid') {
    return { result: { status: 'unreadable', reason: 'malformed link' }, keys: [] };
  }
  if (!configuredConnectorIds.has(link.connector)) {
    return { result: { status: 'unreadable', reason: 'connector not installed' }, keys: [] };
  }
  const connectorManifest = getManifest(link.connector);
  if (!connectorManifest) {
    return { result: { status: 'unreadable', reason: 'connector not installed' }, keys: [] };
  }
  const sourceConfig = connectorManifest.context?.sources?.[link.kind];
  if (!sourceConfig) {
    return { result: { status: 'unreadable', reason: `connector "${link.connector}" declares no "${link.kind}" source` }, keys: [] };
  }

  const primary = await readSourceOnce(integrationManager, link, sourceConfig);
  if ('status' in primary) {
    if (primary.status === 'not_found') return { result: { status: 'not_found' }, keys: [] };
    return { result: { status: 'unreadable', reason: primary.reason ?? 'connector unreachable' }, keys: [] };
  }

  const implicit = toolArgs._source === undefined;
  const base = {
    connector: link.connector,
    kind: link.kind,
    implicit,
    ...(sourceConfig.title ? { title: asString(resolveFieldPath(primary.record, sourceConfig.title)) } : {}),
    ...(sourceConfig.author ? { author: asString(resolveFieldPath(primary.record, sourceConfig.author)) } : {}),
    ...(sourceConfig.at ? { at: asString(resolveFieldPath(primary.record, sourceConfig.at)) } : {}),
    ...(sourceConfig.body ? { body: asBody(resolveFieldPath(primary.record, sourceConfig.body)) } : {}),
  };

  const chain: RequestChainItem[] = [];
  if (sourceConfig.chain) {
    let currentId: string | undefined = asString(getByDottedPath(primary.record, sourceConfig.chain.field));
    let hops = 0;
    const seen = new Set<string>([link.id]);
    while (currentId && hops < sourceConfig.chain.max && !seen.has(currentId)) {
      seen.add(currentId);
      const hopLink: SourceLink = { connector: link.connector, kind: link.kind, id: currentId };
      const hop = await readSourceOnce(integrationManager, hopLink, sourceConfig);
      hops++;
      if ('status' in hop) break; // chain stops here, primary result stands
      chain.push({
        ...(sourceConfig.author ? { author: asString(resolveFieldPath(hop.record, sourceConfig.author)) } : {}),
        ...(sourceConfig.at ? { at: asString(resolveFieldPath(hop.record, sourceConfig.at)) } : {}),
        ...(sourceConfig.title ? { title: asString(resolveFieldPath(hop.record, sourceConfig.title)) } : {}),
        ...(sourceConfig.body ? { body: asBody(resolveFieldPath(hop.record, sourceConfig.body)) } : {}),
      });
      currentId = sourceConfig.chain ? asString(getByDottedPath(hop.record, sourceConfig.chain.field)) : undefined;
    }
  }

  return { result: { status: 'ok', ...base, chain }, keys: primary.keys };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** doc §3: "hard cap 20 kB read" on the Request block's body text. */
const REQUEST_BODY_CAP = 20_000;

function asBody(v: unknown): string | undefined {
  const s = asString(v);
  return s === undefined ? undefined : (s.length > REQUEST_BODY_CAP ? s.slice(0, REQUEST_BODY_CAP) : s);
}

// ─── 2. Identity keys from the action's own contextKeys (doc §2) ──────────

/**
 * AU10 §8.2 — resolves ONE `recordKeys` entry's own identity keys, and
 * (when it declares `next`) follows that second record too. `stepsLeft`
 * guards the manifest-validated cap ({@link MAX_RECORD_KEY_STEPS}) again at
 * runtime — a manifest that passed validation cannot exceed it, but this
 * keeps the function correct on its own rather than trusting the caller.
 */
async function resolveRecordKeyChain(
  integrationManager: IntegrationManager,
  connectorId: string,
  manifest: IntegrationManifest,
  recordKeyName: string,
  idValue: string,
  stepsLeft: number,
): Promise<IdentityKey[]> {
  if (stepsLeft <= 0) return [];
  const recordKey: ContextRecordKeyConfig | undefined = manifest.context?.recordKeys?.[recordKeyName];
  if (!recordKey) return [];
  const args = substitute(recordKey.read.args, { id: idValue });
  const read = await readContextRecord(integrationManager, connectorId, recordKey.read.tool, args);
  if (read.status !== 'ok') return [];

  const out: IdentityKey[] = [];
  const emailField = recordKey.keys?.email;
  if (emailField) {
    const v = resolveFieldPath(read.record, emailField);
    if (typeof v === 'string' && v) out.push(...deriveIdentityKeysFromEmail(v));
  }
  if (recordKey.next) {
    // `next.field` is a plain dotted path, not a FieldPath object (doc §8.2
    // declares it separately from `keys.*`).
    const nextId = asString(getByDottedPath(read.record, recordKey.next.field));
    if (nextId) {
      out.push(
        ...(await resolveRecordKeyChain(
          integrationManager,
          connectorId,
          manifest,
          recordKey.next.recordKey,
          nextId,
          stepsLeft - 1,
        )),
      );
    }
  }
  return out;
}

export async function gatherContextKeysFromAction(
  integrationManager: IntegrationManager,
  connectorId: string,
  contextKeys: ContextKeysDeclaration | undefined,
  toolArgs: Record<string, unknown>,
): Promise<IdentityKey[]> {
  if (!contextKeys) return [];
  const manifest = getManifest(connectorId);
  const out: IdentityKey[] = [];
  for (const [name, argName] of Object.entries(contextKeys)) {
    const raw = toolArgs[argName];
    if (raw === undefined || raw === null) continue;
    if (name === 'email') {
      out.push(...deriveIdentityKeysFromValue(raw));
      continue;
    }
    if (!manifest?.context?.recordKeys?.[name] || typeof raw !== 'string' || !raw) continue;
    out.push(...(await resolveRecordKeyChain(integrationManager, connectorId, manifest, name, raw, MAX_RECORD_KEY_STEPS)));
  }
  return out;
}

// ─── 3. History — every connector that declares it (doc §2–§3) ────────────

export interface HistoryItem {
  kind?: string;
  title?: string;
  body?: string;
  at?: string;
  author?: string;
  type?: string;
  /** Set when this item's `ticket` field resolves to a ticket this
   *  gateway's OWN execution journal recorded as executed — "Written by the
   *  AI via Suveren" (doc §3), regardless of the record's own author field. */
  aiWritten?: { at?: number };
}

export interface ConnectorHistoryMatch {
  connectorId: string;
  matchedKeyType: HistoryKeyType;
  matchedKeyValue: string;
  items: HistoryItem[];
}

export type HistoryResult =
  | { status: 'no_customer_link' }
  /** At least one identity key exists, but no loaded connector's declared
   *  `byKey` type matches any of them (e.g. a free-mail sender and every
   *  history connector matches by `email_domain` only). */
  | { status: 'no_match' }
  | { status: 'unreachable'; connectorIds: string[] }
  | { status: 'ok'; matches: ConnectorHistoryMatch[]; unreachableConnectorIds: string[] };

function mapHistoryItem(raw: unknown, mapping: ContextHistoryConfig['item']): HistoryItem {
  return {
    // `kind` is a literal label, copied as-is — never a path (doc §8.1).
    ...(mapping.kind ? { kind: mapping.kind } : {}),
    ...(mapping.title ? { title: asString(resolveFieldPath(raw, mapping.title)) } : {}),
    ...(mapping.body ? { body: asBody(resolveFieldPath(raw, mapping.body)) } : {}),
    ...(mapping.at ? { at: asString(resolveFieldPath(raw, mapping.at)) } : {}),
    ...(mapping.author ? { author: asString(resolveFieldPath(raw, mapping.author)) } : {}),
    ...(mapping.type ? { type: asString(resolveFieldPath(raw, mapping.type)) } : {}),
  };
}

function withinWindow(at: string | undefined, cutoffMs: number): boolean {
  if (!at) return true; // nothing to judge by — don't drop it on a missing date
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return true;
  return ms >= cutoffMs;
}

/**
 * AU10 F7 — `byKey` is a preference-ordered list (a single type is just a
 * list of one): the FIRST type in that order a gathered key exists for
 * wins. A company domain and an exact address for the SAME sender are never
 * both available (doc §2's free-mail exclusion), so this is a fallback
 * chain — "use the domain when there is one, else the exact address" — not
 * a widening of the match.
 */
function chooseHistoryKey(byKey: HistoryKeyType | HistoryKeyType[], keys: IdentityKey[]): IdentityKey | undefined {
  const order = Array.isArray(byKey) ? byKey : [byKey];
  for (const type of order) {
    const found = keys.find((k) => k.type === type);
    if (found) return found;
  }
  return undefined;
}

/**
 * AU10 F7 — `read.args`' one special KEY name `"$keyType"` is replaced with
 * the resolved key type itself (e.g. `email_domain`), so one declared read
 * can serve a connector tool that names its filter argument after the key
 * type (`get_timeline`'s `email` / `email_domain`). Every other key is a
 * literal argument name, unchanged.
 */
function resolveHistoryArgsTemplate(template: Record<string, string>, keyType: HistoryKeyType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [argName, token] of Object.entries(template)) {
    out[argName === '$keyType' ? keyType : argName] = token;
  }
  return out;
}

/**
 * Reads this ONE connector's declared history for the first gathered key
 * matching its `byKey` preference order. Defensively re-applies
 * `maxAgeDays` client-side (the connector is ASKED to filter by `since`,
 * but a card read never trusts a downstream to enforce the window it was
 * given — same spirit as AU8's own fail-closed checks).
 */
async function readConnectorHistory(
  integrationManager: IntegrationManager,
  connectorId: string,
  history: ContextHistoryConfig,
  keys: IdentityKey[],
  executionJournal: ExecutionJournal,
): Promise<{ status: 'no_match' } | { status: 'unreachable' } | { status: 'ok'; match: ConnectorHistoryMatch }> {
  const key = chooseHistoryKey(history.byKey, keys);
  if (!key) return { status: 'no_match' };

  const sinceMs = Date.now() - history.maxAgeDays * 24 * 60 * 60 * 1000;
  const args = substitute(resolveHistoryArgsTemplate(history.read.args, key.type), {
    key: key.value,
    since: new Date(sinceMs).toISOString(),
    limit: history.limit,
  });
  const read = await readContextRecord(integrationManager, connectorId, history.read.tool, args);
  if (read.status !== 'ok') return { status: 'unreachable' };
  const rows = Array.isArray(read.record) ? read.record : [];

  const items: HistoryItem[] = [];
  for (const row of rows.slice(0, history.limit)) {
    const item = mapHistoryItem(row, history.item);
    if (!withinWindow(item.at, sinceMs)) continue;
    if (history.item.ticket) {
      const ticketId = asString(resolveFieldPath(row, history.item.ticket));
      if (ticketId) {
        const entry = executionJournal.get(ticketId);
        if (entry?.state === 'done') {
          item.aiWritten = { at: entry.finishedAt ? entry.finishedAt * 1000 : undefined };
        }
      }
    }
    items.push(item);
  }

  return { status: 'ok', match: { connectorId, matchedKeyType: key.type, matchedKeyValue: key.value, items } };
}

export async function buildHistory(
  integrationManager: IntegrationManager,
  keys: IdentityKey[],
  executionJournal: ExecutionJournal,
  /** AU10 F4 — only connectors actually configured on THIS gateway count. A
   *  manifest this gateway has on disk but whose connector was never
   *  installed is skipped SILENTLY — never surfaced as "not reachable",
   *  which would wrongly imply something is broken rather than merely
   *  absent. An installed-but-stopped/crashed connector still counts here
   *  (its read then genuinely fails → 'unreachable', below). */
  configuredConnectorIds: ReadonlySet<string>,
): Promise<HistoryResult> {
  if (keys.length === 0) return { status: 'no_customer_link' };

  const connectors = getAllManifests().filter((m) => m.context?.history && configuredConnectorIds.has(m.id));
  if (connectors.length === 0) return { status: 'no_match' };

  const matches: ConnectorHistoryMatch[] = [];
  const unreachable: string[] = [];
  let anyMatchedType = false;

  for (const manifest of connectors) {
    const history = manifest.context!.history!;
    const outcome = await readConnectorHistory(integrationManager, manifest.id, history, keys, executionJournal);
    if (outcome.status === 'no_match') continue;
    anyMatchedType = true;
    if (outcome.status === 'unreachable') {
      unreachable.push(manifest.id);
      continue;
    }
    matches.push(outcome.match);
  }

  if (!anyMatchedType) return { status: 'no_match' };
  if (matches.length === 0 && unreachable.length > 0) return { status: 'unreachable', connectorIds: unreachable };
  return { status: 'ok', matches, unreachableConnectorIds: unreachable };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface RequestContextResult {
  request: RequestResult;
  history: HistoryResult;
}

/**
 * Full orchestration for one `/internal/request-context` call. `actionGating`
 * is the manifest override entry for the ACTION tool itself (its
 * `contextKeys`/`sourceFromArg`, if any) — resolved by the caller the same
 * way it already resolves `preview`/`display` (see preview.ts's
 * `getToolPreviewConfig`).
 *
 * `configuredConnectorIds` (AU10 F4) — every connector id actually set up on
 * THIS gateway (`IntegrationRegistry.getAll()`, not `getAllManifests()`): a
 * manifest shipped in `content/integrations/` is not the same as a connector
 * the owner installed. Governs both which connector a `_source` may name and
 * which connectors' `context.history` are consulted.
 */
export async function buildRequestContext(
  integrationManager: IntegrationManager,
  executionJournal: ExecutionJournal,
  actionConnectorId: string,
  toolArgs: Record<string, unknown>,
  actionGating: { contextKeys?: ContextKeysDeclaration; sourceFromArg?: SourceFromArgDeclaration } | undefined,
  configuredConnectorIds: ReadonlySet<string>,
): Promise<RequestContextResult> {
  const { result: request, keys: sourceKeys } = await resolveRequestContext(
    integrationManager,
    toolArgs,
    actionConnectorId,
    actionGating?.sourceFromArg,
    configuredConnectorIds,
  );
  const actionKeys = await gatherContextKeysFromAction(
    integrationManager,
    actionConnectorId,
    actionGating?.contextKeys,
    toolArgs,
  );
  const keys = dedupeKeys([...actionKeys, ...sourceKeys]);
  const history = await buildHistory(integrationManager, keys, executionJournal, configuredConnectorIds);
  return { request, history };
}
