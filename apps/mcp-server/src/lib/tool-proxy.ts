/**
 * Tool Proxy — Suveren gating wrapper for proxied tool calls.
 *
 * Wraps downstream MCP tool calls with Suveren authorization verification.
 * ALL tools require authorization — no ungated access.
 *
 * - Read-only tools (category: "read") require a matching authorization
 *   but skip execution context verification.
 * - Write tools require full execution context verification against bounds.
 */

import type { IntegrationManager, DiscoveredTool } from './integration-manager';
import type { SharedState, EnrichedAuthorization } from './shared-state';
import { lockedNotice } from './locked-notice';
import type { DenialReason } from './denial-log';
import { SPReceiptError } from './sp-client';
import { isCommitmentDowngrade, AsKeyMismatchError } from './attestation-cache';
import { appendVerificationFooter, shouldAttachFooter } from './receipt-footer';
import { computeContentBinding, attachReceiptId } from './content-binding';
import { hashToolArgs } from './execution-journal';
import { verifyTicket, TicketBindingMismatchError } from './ticket-verify';
import { notifyControlPlane } from './cp-notify';
import { encodeOutgoingArgs } from './arg-encoding';
import { normalizeIncomingArgs } from './arg-normalization';
import { selectAuthorization } from './scope-specificity';
import {
  boundsSatisfyReadGate,
  resolveAgeBoundField,
  maxReadAgeDays,
  parseMessageTimestamp,
  isOlderThanMaxAge,
  getByDottedPath,
  firstParsableDate,
  renderAgeConstraint,
  clampAgeFloor,
  composeReadQuery,
  detectAgeConflict,
  readToolIsGoverned,
  allowedResources,
  deniedResources,
  filterItemsByResource,
  hasBlockedValue,
  type BoundsSchemaLike,
} from './read-gate';
import { getProfile, ContentBindingError, boundActionTypes } from '@hap/core';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSimulationMode } from './simulation-mode';

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

// Cap preview payload: proposals are stored in Redis and fetched on every
// thread poll. 1 MB file → ~1.3 MB base64. Larger files skip the preview
// and the card just shows the path as text.
const MAX_PREVIEW_BYTES = 1 * 1024 * 1024;

/**
 * If the tool call passes a local image path, read the file and attach a
 * data-URL preview to toolArgs so the review card can render it. The actual
 * tool execution still uses the original imagePath (downstream MCP reads the
 * file at execute time). The _imagePreview key is informational only and is
 * ignored by the downstream tool's zod schema.
 */
async function attachImagePreview(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const imagePath = typeof args.imagePath === 'string' ? args.imagePath : null;
  if (!imagePath) return args;
  if (args._imagePreview) return args; // already attached
  try {
    const mime = IMAGE_MIME[extname(imagePath).toLowerCase()];
    if (!mime) return args;
    const buf = await readFile(imagePath);
    if (buf.byteLength > MAX_PREVIEW_BYTES) return args; // don't bloat proposals
    return { ...args, _imagePreview: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return args; // file unreadable — show path only
  }
}

/**
 * Apply a single mapping entry to produce an execution context field.
 * Handles divisor, transform, and direct copy.
 */
function applyMapping(
  m: { field: string; divisor?: number; transform?: string },
  value: unknown,
  execution: Record<string, string | number>,
): void {
  if (m.divisor) {
    const numValue = typeof value === 'number' ? value : Number(value);
    execution[m.field] = numValue / m.divisor;
    return;
  }
  // Extract .email when the item is an attendee object — Google Calendar
  // accepts attendees as `{ email, displayName?, ... }` objects, but the
  // join / join_domains transforms only know how to read flat strings.
  // Without this, an object stringifies to "[object Object]" and the
  // gatekeeper rejects with "[object object] not in authorized set".
  const coerce = (v: unknown): string => {
    if (typeof v === 'object' && v !== null && 'email' in v) {
      return String((v as { email: unknown }).email);
    }
    return String(v);
  };
  const arr = Array.isArray(value) ? value.map(coerce) : [coerce(value)];
  switch (m.transform) {
    case 'length':
      execution[m.field] = arr.length;
      break;
    case 'join':
      execution[m.field] = arr.join(',');
      break;
    case 'join_domains': {
      const domains = [...new Set(arr.map(email => {
        const at = email.lastIndexOf('@');
        return at >= 0 ? email.substring(at + 1).toLowerCase() : email.toLowerCase();
      }))].sort();
      execution[m.field] = domains.join(',');
      break;
    }
    default:
      execution[m.field] = typeof value === 'number' ? value : String(value);
  }
}

/** Match a short profile name (e.g. "charge") against a full qualified ID (e.g. "github.com/.../charge@0.3") */
export function profileMatches(profileId: string, shortName: string): boolean {
  return profileId === shortName || profileId.includes('/' + shortName + '@') || profileId.endsWith('/' + shortName);
}

/**
 * Whether a `hideUnlessAuthorized` tool should be listed in `tools/list`,
 * given the COMPLETE authorizations already matched to its profile.
 *
 * Generic by construction — reads the profile's OWN boundsSchema and
 * hap-core's `boundActionTypes` (never a connector or bound-field literal in
 * code), the same helper the Authority Server uses to decide what a
 * cumulative bound counts. A tool without the flag is unaffected: always
 * visible once `matchingAuths` is non-empty, exactly as before this existed.
 *
 * "Authorized for display" means: at least one matching mandate sets EVERY
 * cumulative_count bound that applies to this tool's declared action_type to
 * a value > 0. A tool whose action type carries no cumulative_count bound at
 * all has nothing to require, so it is vacuously visible.
 */
/**
 * The cumulative_count bounds of a profile that govern `actionType` (by appliesTo,
 * or all action types when it is absent — see hap-core's boundActionTypes).
 */
function countBoundsFor(profileId: string, actionType: string): string[] | null {
  const fields = getProfile(profileId)?.boundsSchema?.fields;
  if (!fields) return null;
  return Object.entries(fields)
    .filter(([, def]) => def.boundType?.kind === 'cumulative_count')
    .filter(([name, def]) => {
      const applies = boundActionTypes(name, def);
      return applies === undefined || applies.includes(actionType);
    })
    .map(([name]) => name);
}

/**
 * A count bound of 0 for this action type means the mandate can never allow it —
 * the Authority Server would refuse every ticket. Returns that bound's name, or
 * null when nothing caps the action at zero.
 *
 * Used in selection: with two mandates on one profile (a work mandate with
 * setup_daily_max 0 and a setup mandate with 1), the tiebreak could pick the
 * zero-capped one and the call failed at the AS although another mandate allowed
 * it (found 2026-10-02, hap-e2e simulation-mode). Skipping it locally also gives a
 * clearer refusal than the AS's limit message when no mandate allows the action.
 */
export function zeroCappedBound(
  profileId: string,
  bounds: Record<string, string | number> | undefined,
  actionType: string | undefined,
): string | null {
  if (typeof actionType !== 'string') return null;
  const names = countBoundsFor(profileId, actionType);
  if (!names) return null;
  for (const n of names) {
    const v = bounds?.[n];
    if (v !== undefined && v !== '' && Number(v) <= 0) return n;
  }
  return null;
}

export function toolIsAuthorizedForDisplay(
  tool: DiscoveredTool,
  matchingAuths: EnrichedAuthorization[],
): boolean {
  if (!tool.gating?.hideUnlessAuthorized) return true;
  if (matchingAuths.length === 0) return false;

  const profileId = tool.gating.profile;
  const actionType = tool.gating.staticExecution?.action_type;
  if (!profileId || typeof actionType !== 'string') return false;

  const requiredFields = countBoundsFor(profileId, actionType);
  if (!requiredFields) return false;
  if (requiredFields.length === 0) return true;

  return matchingAuths.some(a => {
    const bounds = (a.bounds ?? a.frame) as Record<string, string | number> | undefined;
    return requiredFields.every(f => Number(bounds?.[f] ?? 0) > 0);
  });
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Parse the first JSON text block of a downstream tool result, for post-fetch
 * read enforcement (age + coverage). MCP tools return their payload as JSON
 * text. Returns undefined on any parse/shape failure so callers fail closed.
 * The exact provider response shape is validated live on the gateway.
 */
function parseFirstJson(result: ToolResult): unknown {
  const text = result.content?.find(c => c.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Deny a read: record the block (F7.4 denial log — for the human, never any
 * content) and return the user-facing error. `detail` is the human sentence
 * WITHOUT the "Read blocked by Gatekeeper:" prefix (added here). `target` is an
 * optional coarse token (e.g. a calendar name) — never content. Recording never
 * breaks the denial (denialLog may be absent in tests → optional-chain).
 */
function denyRead(
  state: SharedState,
  tool: DiscoveredTool,
  reason: DenialReason,
  detail: string,
  target?: string,
): ToolResult {
  try {
    state.denialLog?.record({
      ts: Date.now(),
      tool: tool.originalName,
      integrationId: tool.integrationId,
      profile: tool.gating?.profile ?? null,
      reason,
      detail,
      target,
    });
  } catch { /* recording must never break the denial */ }
  return { content: [{ type: 'text', text: `Read blocked by Gatekeeper: ${detail}` }], isError: true };
}

/**
 * Create a handler function for a proxied tool that gates calls through Suveren.
 *
 * All tools require authorization:
 * - Read tools (category: "read") → need matching auth, no execution context checks
 * - Write tools → full execution context verification against bounds
 */
/**
 * Refuse arguments the manifest blocks — on every path, before any other gate.
 *
 * They are already stripped from the schema the agent sees, but a schema is
 * advice an agent may ignore, so hiding is prevention and refusing is the
 * control. Wrapping rather than checking inside means no gating path can
 * forget it: disabled, read and write are all covered by construction.
 *
 * The motivating case is Gmail's `raw` — a whole pre-encoded message whose own
 * description says it causes to/cc/subject/body to be ignored. Every control
 * reads those fields, so such a call cannot be scope-checked, cannot be content
 * bound, and cannot be shown to a human in any form they could judge.
 */
export function createGatedToolHandler(
  tool: DiscoveredTool,
  integrationManager: IntegrationManager,
  state: SharedState,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  // Simulation mode, defence in depth: integration-manager already refuses to
  // START a connector whose manifest carries no `simulation` marker while
  // simulation mode is on, so in the normal case this tool never exists to be
  // called. This is a second, independent check at CALL time — so a bug in
  // that start-time gate, or some future path that registers tools without
  // going through IntegrationManager.startIntegration, can never let a real
  // system execute. No ticket is requested; this runs before any gating,
  // bounds, or receipt logic.
  //
  // The text is deliberately neutral: the working agent must not be able to
  // tell simulation from live (Andreas, 2026-10-02). The explicit reason stays
  // on the human side — SIMULATION_BLOCK_REASON in the integration status, the
  // UI banner and `suveren-gateway simulation status`.
  if (isSimulationMode() && !integrationManager.isSimulationSafe(tool.integrationId)) {
    return async () => ({
      content: [{
        type: 'text',
        text: `Refused: "${tool.namespacedName}" is not available. No ticket was requested.`,
      }],
      isError: true,
    });
  }

  const gated = createGatedToolHandlerInner(tool, integrationManager, state);

  // Normalize declared identifier arguments FIRST, so every later stage — the
  // approval card, the bounds check, the content hash, the downstream call —
  // sees one spelling. Normalizing after the proposal would bind a string the
  // approver never saw.
  // A built-in's own refusal (simulation-only, invalid arguments) comes before any
  // proposal or ticket, so no person is asked to approve a call that cannot run.
  // Skipped for a tool the gate refuses outright anyway (no profile, disabled):
  // that refusal must not depend on — or touch — the manager.
  const gateable = !!tool.gating?.profile && tool.gating.category !== 'disabled';
  const inner = async (args: Record<string, unknown>) => {
    const normalized = normalizeIncomingArgs(tool, args);
    // Optional call: test doubles of the manager predate built-ins.
    const refusal = gateable ? await integrationManager.precheckBuiltin?.(tool, normalized) : null;
    if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true };
    return gated(normalized);
  };

  const blocked = tool.gating?.blockedArgs ?? [];
  if (blocked.length === 0) return inner;

  return async (args: Record<string, unknown>) => {
    const present = blocked.filter(a => a in (args ?? {}));
    if (present.length === 0) return inner(args);
    return {
      content: [{
        type: 'text',
        text:
          `Refused: "${tool.namespacedName}" was called with ${present.map(b => `"${b}"`).join(', ')}, ` +
          `which the integration manifest blocks. That argument carries the whole ` +
          `request in one opaque value, so the recipients, the content and the ` +
          `limits on this authorization cannot be read from it — the call could ` +
          `not be shown to stay in scope, and could not be shown to a human for ` +
          `approval in any form they could judge. Use the individual arguments instead.`,
      }],
      isError: true,
    };
  };
}

/**
 * True when the Authority Server refused a receipt because the SELECTED
 * MANDATE itself is no longer valid — revoked, past its signed expiry, or
 * unknown to the AS at all — as opposed to a refusal about the CALL
 * (BOUND_EXCEEDED, approval_required, a malformed request). Only THIS class
 * of refusal is safe to retry with a different mandate: the call was never
 * judged on its merits, only the authority offered to cover it turned out to
 * be dead. Everything else (bounds, approval, idempotency, shape) must fail
 * exactly as before — retrying those would either paper over an enforcement
 * refusal or risk a double execution.
 *
 * Matched on the AS's structured `errors[0].code` (suveren-as's
 * `app/api/as/receipt/route.ts`), never on the free-text message — codes are
 * the contract. `ATTESTATION_REVOKED` / `ATTESTATION_EXPIRED` (403) cover a
 * mandate the AS actively invalidated; `ATTESTATION_NOT_FOUND` (404) covers
 * a cached mandate the AS has no record of at all (e.g. the cache is stale
 * about an id that was deleted). There is currently no distinct "superseded"
 * code on the wire — a renewal reuses the same authorizationId (see
 * `authz-store.ts`'s `renewAuthorization`) rather than minting a new one, so
 * a superseded mandate surfaces as one of these two codes, not a third.
 */
function isStaleMandateRefusal(err: SPReceiptError): boolean {
  const errors = err.body?.errors as Array<{ code?: unknown }> | undefined;
  const code = errors?.[0]?.code;
  if (err.statusCode === 403 && (code === 'ATTESTATION_REVOKED' || code === 'ATTESTATION_EXPIRED')) {
    return true;
  }
  if (err.statusCode === 404 && code === 'ATTESTATION_NOT_FOUND') {
    return true;
  }
  return false;
}

function createGatedToolHandlerInner(
  tool: DiscoveredTool,
  integrationManager: IntegrationManager,
  state: SharedState,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  // Tools without gating config still require authorization if integration has a profile
  if (!tool.gating || !tool.gating.profile) {
    return async () => {
      return {
        content: [{
          type: 'text',
          text: `Tool "${tool.namespacedName}" has no gating configuration. All tools require authorization.`,
        }],
        isError: true,
      };
    };
  }

  const { profile, executionMapping, staticExecution, category } = tool.gating;

  // Locked ⇒ no authorization can be read, so every gated call fails. Say WHY
  // before the gate reports the symptom ("no authorization grants it"), which
  // would send the user off to create one they already have.
  const lockedGuard = (inner: (args: Record<string, unknown>) => Promise<ToolResult>) =>
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      if (!state.spClient.isUnlocked()) {
        return {
          content: [{ type: 'text', text: lockedNotice(`use ${tool.namespacedName}`, state.spClient.getLockReason() ?? 'restart') }],
          isError: true,
        };
      }
      return inner(args);
    };


  // Tools the manifest declares unavailable — and tools it does not describe
  // at all — are always blocked at the gate.
  if (category === 'disabled') {
    const reason = tool.gating.disabledReason;
    return async () => ({
      content: [{
        type: 'text',
        text: reason
          ? `Tool "${tool.namespacedName}" is refused: ${reason}. A tool that no manifest entry ` +
            `describes cannot be gated — there is nothing declaring which action type it performs ` +
            `or how its arguments map to the bounds. Add an entry for "${tool.originalName}" under ` +
            `this integration's toolGating.overrides (with "category": "read" for a read-only tool) ` +
            `before it can be used.`
          : `Tool "${tool.namespacedName}" is disabled by the integration manifest and cannot be used.`,
      }],
      isError: true,
    });
  }

  // Read-only tools: require a matching authorization AND satisfaction of any
  // declared read gate. (Previously the read path only checked that a matching
  // authorization existed and proxied verbatim — so declared read gates like
  // records' `read_access: unlimited` were never enforced. doc §1 F1.)
  if (category === 'read') {
    const readGate = { boundField: tool.gating.boundField, requiredValue: tool.gating.requiredValue };
    const readAdapter = tool.gating.read;
    // F9: a read tool MUST declare governance (gate, adapter, or explicit
    // exemption). Absence of all three ⇒ deny. Decided once here, from the tool
    // config, so an unconfigured read can never fall through to pass-through.
    const governed = readToolIsGoverned(tool.gating);
    return lockedGuard(async (args: Record<string, unknown>) => {
      if (!governed) {
        return denyRead(state, tool, 'ungoverned',
          `${tool.originalName} declares no read governance (no static gate, no read adapter, ` +
          `no explicit exemption), so the gateway cannot bound what it returns. This is a manifest ` +
          `defect — the tool must declare how its reads are limited before it can be used.`);
      }
      const auths = state.getEnrichedAuthorizations();
      const matchingAuths = auths.filter(
        a => a.complete && profileMatches(a.profileId, profile!),
      );

      if (matchingAuths.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No active authorization matching profile "${profile}". ` +
              `A decision owner must grant authority via the Authority UI before this tool can be used.`,
          }],
          isError: true,
        };
      }

      // Enforce the static read gate: at least one matching authorization must
      // grant the required bound (e.g. read_access:unlimited). Fail closed.
      if (readGate.boundField) {
        const permitted = matchingAuths.some(a =>
          boundsSatisfyReadGate((a.bounds ?? a.frame) as Record<string, string | number> | undefined, readGate),
        );
        if (!permitted) {
          return denyRead(state, tool, 'read_gate',
            `using ${tool.originalName} requires an authorization with ` +
            `"${readGate.boundField}: ${readGate.requiredValue}", but no active authorization grants it.`);
        }
      }

      // Per-item read enforcement — generic (doc §1, §3.0, and the read model in
      // doc/read-authorization-identity-coverage.md):
      //  • AGE: the item must fall inside the most-permissive read_max_age_days
      //    window across matching authorizations.
      // The only read-denial reason is AGE. Correspondent COVERAGE denial (the
      // superseded "Option A / authority scope binds reads" model) is removed:
      // grant scope no longer restricts reads. Per-correspondent overrides that
      // *raise* the window are a future slice (doc §7) and will consume the
      // participant helpers, not a coverage predicate. See the §4 supersession
      // banner in read-bounds-enforcement-plan.md.
      // Bound field comes from the profile SCHEMA; date location + query syntax
      const readProfile = readAdapter ? getProfile(matchingAuths[0].profileId) : undefined;
      const boundsSchema = readProfile?.boundsSchema as BoundsSchemaLike | undefined;
      const ageBoundField = readAdapter?.ageField ? resolveAgeBoundField(boundsSchema, readAdapter.ageField) : null;

      // FAIL-CLOSED on an unset read-age window (F11). A tool that declares an age
      // dimension (ageField → a profile age bound) MUST be bounded by some grant's
      // value. `read_max_age_days` is optional in the profile, so a grant can omit
      // it — and an omitted window used to mean "read all history" (the pentest
      // hole). Instead: if no matching grant sets the window, DENY. Resolved once
      // here and reused by the pre-fetch and post-fetch checks.
      //
      // WHERE THE WINDOW COMES FROM. Read policy is enforced only by this
      // Gatekeeper — it never reaches the Authority Server and no receipt ever
      // checks it — so the window belongs in LOCAL, live-editable config rather
      // than in a signed grant ("a limit lives in the same trust domain as its
      // enforcement", `content/0.5/protocol.md` → *Bounds, Context, and Read
      // Policy*). Precedence, deliberately in this order:
      //
      //   1. the integration's local `readAgeDays` — the owner's live setting,
      //      editable in one place and applying to the very next read;
      //   2. else the signed `read_max_age_days` grant bound — the legacy
      //      source, kept so existing grants keep working unchanged;
      //   3. else DENY (F11).
      //
      // The local value WINS when set, rather than being min()'d with the
      // grant: the whole point is one place to change it, and a grant silently
      // overriding the owner's own setting would make the control a lie. It is
      // the owner's data and the owner's Gatekeeper either way.
      // A tool HAS an age dimension when its manifest adapter declares one.
      // Whether the profile also carries a signed bound is a separate, optional
      // question: read policy is local, so a signed read bound is a fallback
      // for older grants, not a precondition for enforcing anything. Gating on
      // the bound instead would mean a connector could declare an age-bounded
      // read and silently get NO enforcement because its profile happened not
      // to list one — fail-open by omission, the exact shape of the original
      // hole.
      const hasAgeDimension = Boolean(readAdapter?.ageField);
      let readMaxAge: number | null = null;
      if (hasAgeDimension) {
        const localAge = integrationManager.getReadAgeDays(tool.integrationId);
        readMaxAge = localAge ?? (ageBoundField
          ? maxReadAgeDays(
              matchingAuths.map(a => (a.bounds ?? a.frame) as Record<string, string | number> | undefined),
              ageBoundField,
            )
          : null);
        // FAIL-CLOSED (F11): no window from either source. An omitted window
        // must never be read as "all history" — that was the pentest hole.
        if (readMaxAge === null) {
          return denyRead(state, tool, 'unset_age',
            `no read-age window is set for this integration${ageBoundField ? ` (or on your authorization's ${ageBoundField})` : ''}. ` +
            `Reads are not permitted with an unbounded window — set how far back the agent may ` +
            `read under the integration's Read policy, then try again. Nothing was read.`);
        }
      }

      // F7 — RESOURCE scope: which container this read may touch (calendar, mail
      // folder, …). Pre-fetch, before any fetch: the requested container(s) must
      // be inside the grant's permitted set, else DENY. Fail-closed — an empty
      // permitted set allows nothing (that is the point: don't expose every
      // container by default). The container id the agent asked for is PINNED
      // into the outgoing args so the downstream can't reinterpret an omitted arg.
      let outgoing = args;
      if (readAdapter?.resourceBound && (readAdapter.resourceArg || readAdapter.resourceArrayArg)) {
        const allowed = allowedResources(
          matchingAuths.map(a => (a.context ?? {}) as Record<string, string | number>),
          readAdapter.resourceBound,
        );
        const isArray = Boolean(readAdapter.resourceArrayArg);
        const argName = (readAdapter.resourceArrayArg ?? readAdapter.resourceArg) as string;
        const raw = args[argName];
        // Resolve requested containers, substituting the provider default for an
        // omitted arg (an omitted arg still resolves to a real container).
        let requested: string[];
        if (isArray) {
          requested = Array.isArray(raw) && raw.length > 0
            ? raw.map(String)
            : readAdapter.resourceDefault ? [readAdapter.resourceDefault] : [];
        } else {
          requested = typeof raw === 'string' && raw.trim() !== ''
            ? [raw]
            : readAdapter.resourceDefault ? [readAdapter.resourceDefault] : [];
        }
        const denied = deniedResources(requested, allowed);
        if (requested.length === 0 || denied.length > 0) {
          const why = requested.length === 0
            ? 'no container was resolved for this read'
            : `not in your permitted set (${denied.join(', ')})`;
          return denyRead(state, tool, 'resource',
            `${tool.originalName} may only read the containers your authorization permits ` +
            `(${readAdapter.resourceBound}); the requested one is ${why}. Nothing was read.`,
            denied.length > 0 ? denied.join(', ') : undefined);
        }
        // Pin the validated container back onto the args so an omitted arg can't
        // fall through to a wider provider default.
        outgoing = { ...args, [argName]: isArray ? requested : requested[0] };
      }

      // F7 — PINNED args: force provider flags the agent must not control (e.g.
      // includeSpamTrash:false), overriding whatever it sent. A widening arg is
      // the gateway's to set, not the agent's.
      if (readAdapter?.pinnedArgs) {
        outgoing = { ...outgoing, ...readAdapter.pinnedArgs };
      }

      // Pre-fetch: clamp the read's lower time bound (time-range tools — a
      // calendar's `timeMin`, a chat history's `oldest`). Same job the query
      // ceiling does below, for providers that take a range instead of a
      // search string. Applied even when the agent omitted the argument: at
      // most providers an absent lower bound means all history.
      if (readAdapter?.ageFloorArg && hasAgeDimension && readMaxAge !== null) {
        outgoing = {
          ...outgoing,
          [readAdapter.ageFloorArg]: clampAgeFloor(
            outgoing[readAdapter.ageFloorArg],
            readMaxAge,
            Date.now(),
            readAdapter.ageFloorFormat,
          ),
        };
      }

      // Pre-fetch: AND the age ceiling into the search query (list/search tools)
      // so out-of-window items can't come back at all.
      if (readAdapter?.queryArg) {
        const clauses: string[] = [];
        if (hasAgeDimension && readAdapter.ageConstraint && readMaxAge !== null) {
          // {days} for relative syntax (Gmail), {date} for absolute (Slack).
          clauses.push(renderAgeConstraint(readAdapter.ageConstraint, readMaxAge, Date.now()));
        }
        if (clauses.length > 0) {
          // F8: the agent's fragment must not be able to bind across the
          // boundary and capture the injected clauses (a trailing `OR` turns
          // the intended AND into a union). composeReadQuery validates and
          // brackets; an unsafe fragment is a denial, never a silent rewrite.
          const base = typeof args[readAdapter.queryArg] === 'string' ? (args[readAdapter.queryArg] as string) : '';

          // Refuse AUDIBLY when the agent asks for older data than the window
          // allows. ANDing the ceiling on would produce a contradiction and
          // return zero results, and an empty set reads as "nothing exists" —
          // so the agent reports there is no such mail when in fact it is
          // simply out of bounds. Silence here manufactures false answers.
          const conflictDays = detectAgeConflict(base, readAdapter.ageConflictPattern, readMaxAge);
          if (conflictDays !== null) {
            return denyRead(state, tool, 'age_window',
              `you asked for items older than ${conflictDays} days, but this authorization allows ` +
              `${readMaxAge} days. Nothing outside that window can be read, so the search was not ` +
              `run — it would have returned an empty result that looks like "none exist". Items ` +
              `may well exist beyond ${readMaxAge} days; widen read_max_age_days if you need them.`);
          }

          const composed = composeReadQuery(base, clauses);
          if (!composed.ok) {
            return denyRead(state, tool, 'query_unsafe',
              `${composed.reason}. The gateway must AND its read limits onto your search, and this ` +
              `query could not be safely combined. Re-send it without a trailing operator or ` +
              `unbalanced parenthesis.`);
          }
          outgoing = { ...outgoing, [readAdapter.queryArg]: composed.query };
        }
      }

      const result = await integrationManager.callTool(tool.integrationId, tool.originalName, outgoing);

      // F7 — post-fetch container exclusion: block a get-by-id whose item is in
      // a forbidden container (e.g. a message labelled SPAM/TRASH), so it can't
      // be fetched directly around the list-level pin.
      if (readAdapter?.blockResultValues && readAdapter.resultValuesPath) {
        const parsed = parseFirstJson(result);
        const blocked = new Set(readAdapter.blockResultValues);
        if (parsed !== undefined && hasBlockedValue(parsed, readAdapter.resultValuesPath, blocked)) {
          return denyRead(state, tool, 'spam',
            `this item is in a container your authorization excludes (e.g. spam/trash). ` +
            `Its contents were not returned.`);
        }
      }

      // Post-fetch (get-by-id tools): AGE only. Parse the response once.
      // readMaxAge is guaranteed non-null here when the tool has an age
      // dimension (the
      // unset case failed closed above).
      if (readAdapter && hasAgeDimension && readAdapter.resultDatePath && readMaxAge !== null) {
        const parsed = parseFirstJson(result);
        // Candidate paths, first parseable wins — a provider may carry the date
        // in more than one shape (timed vs all-day events). Unparseable stays
        // fail-closed: null reads as "older than the window".
        const itemDate = parsed === undefined
          ? null
          : firstParsableDate(parsed, readAdapter.resultDatePath);
        if (isOlderThanMaxAge(itemDate, readMaxAge, Date.now())) {
          return denyRead(state, tool, 'age',
            `this item is older than the ${readMaxAge}-day read window your authorization grants ` +
            `(read_max_age_days). Its contents were not returned.`);
        }
      }

      // F7 — RESOURCE result filter (enumeration tools, e.g. list_calendars):
      // drop items in containers the grant doesn't permit, so an excluded
      // container's existence isn't disclosed. Fail closed: if the result can't
      // be parsed as an array, return an empty list rather than the raw payload.
      if (readAdapter?.resourceBound && readAdapter.resultResourcePath && !readAdapter.resourceArg && !readAdapter.resourceArrayArg) {
        const allowed = allowedResources(
          matchingAuths.map(a => (a.context ?? {}) as Record<string, string | number>),
          readAdapter.resourceBound,
        );
        const parsed = parseFirstJson(result);
        const items = Array.isArray(parsed) ? parsed : [];
        const kept = filterItemsByResource(items, readAdapter.resultResourcePath, allowed);
        return { ...result, content: [{ type: 'text', text: JSON.stringify(kept) }] };
      }

      return result;
    });
  }

  // Write tools: full execution context verification
  return lockedGuard(async (args: Record<string, unknown>) => {
    // Start with static values (e.g., scope: "external")
    const execution: Record<string, string | number> = { ...staticExecution };

    // Build execution context from tool args using the mapping
    for (const [argName, mapping] of Object.entries(executionMapping)) {
      const value = args[argName];
      if (value !== undefined && value !== null) {
        if (typeof mapping === 'string') {
          // Direct mapping: argName → contextField
          execution[mapping] = typeof value === 'number' ? value : String(value);
        } else if (Array.isArray(mapping)) {
          // Array mapping: one arg → multiple execution fields
          for (const m of mapping) applyMapping(m, value, execution);
        } else if ('divisor' in mapping) {
          // Divisor mapping: convert units (e.g., cents ÷ 100 → EUR)
          const numValue = typeof value === 'number' ? value : Number(value);
          execution[mapping.field] = numValue / mapping.divisor;
        } else if ('transform' in mapping) {
          // Transform mapping: array-aware transforms
          applyMapping(mapping, value, execution);
        }
      }
    }

    // v0.5+ actionType discipline (protocol.md → Tool-Gating Manifests). A
    // write whose manifest declares no action_type used to log a warning and
    // proceed with an undefined actionType — indistinguishable from unenforced
    // bounds, and the AS would have had to guess the cumulative bucket. Fail
    // closed instead: the manifest is the only legitimate source of actionType
    // (never the tool name), so a missing declaration is a manifest bug the
    // human must fix, not a condition to execute through.
    const declaredActionType =
      typeof execution.action_type === 'string' && execution.action_type.length > 0
        ? execution.action_type
        : undefined;
    if (!declaredActionType) {
      return {
        content: [{
          type: 'text',
          text: `Blocked by Gatekeeper: tool ${tool.namespacedName} declares no action_type in its ` +
            `manifest's staticExecution. A write cannot be bounds-checked without its action type — ` +
            `fix the integration manifest.`,
        }],
        isError: true,
      };
    }
    // When the profile declares an actionTypes registry (v0.5+ profiles), the
    // manifest's action_type must be a member — an unregistered value would
    // land in a cumulative bucket no bound governs. Profiles published before
    // the registry declare none; membership is then uncheckable and skipped.
    {
      const profileDef = getProfile(profile!);
      const registry = (profileDef?.boundsSchema as { actionTypes?: unknown } | undefined)
        ?.actionTypes;
      if (Array.isArray(registry) && registry.length > 0 && !registry.includes(declaredActionType)) {
        return {
          content: [{
            type: 'text',
            text: `Blocked by Gatekeeper: action_type "${declaredActionType}" is not in profile ` +
              `${profile}'s actionTypes registry (${registry.join(', ')}). Fix the integration manifest.`,
          }],
          isError: true,
        };
      }
    }

    // Find all active authorizations matching this profile
    const auths = state.getEnrichedAuthorizations();
    const matchingAuths = auths.filter(
      a => a.complete && profileMatches(a.profileId, profile!),
    );

    if (matchingAuths.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No active authorization matching profile "${profile}". ` +
            `A decision owner must grant authority via the Authority UI before this tool can be used.`,
        }],
        isError: true,
      };
    }

    // Verify EVERY matching authorization and collect the ones that pass
    // ("passers"). Selection among them is most-specific-wins + fail-safe
    // (scope-specificity.ts / doc §7) — NOT first-pass-wins, which let an
    // overlapping grant silently override a stricter one by cache order.
    const errors: string[] = [];
    const passers: EnrichedAuthorization[] = [];
    for (const candidate of matchingAuths) {
      // Pass v0.4 enriched fields (bounds/context from gate store) to gatekeeper
      const { result } = await state.gatekeeper.verifyExecution(candidate.authorizationId, execution, {
        bounds: candidate.bounds,
        context: candidate.context,
      });
      const capped = result.approved
        ? zeroCappedBound(candidate.profileId, (candidate.bounds ?? candidate.frame) as Record<string, string | number> | undefined, typeof execution.action_type === 'string' ? execution.action_type : undefined)
        : null;
      if (result.approved && capped) {
        errors.push(`${candidate.path}: ${capped} is 0 — this mandate does not allow "${execution.action_type}"`);
      } else if (result.approved) {
        passers.push(candidate);
      } else {
        const reasons = result.errors.map(e => {
          if (e.code === 'BOUND_EXCEEDED') {
            return `${candidate.path}: ${e.field}: ${e.message}`;
          }
          return `${candidate.path}: ${e.message}`;
        });
        errors.push(...reasons);
      }
    }

    if (passers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `Tool call rejected by Gatekeeper. Tried ${matchingAuths.length} authorization(s):\n` +
            errors.map(e => `  - ${e}`).join('\n'),
        }],
        isError: true,
      };
    }

    // Most-specific-wins + fail-safe selection over the profile's context schema.
    // Generic: specificity is set-containment over contextSchema.keyOrder — no
    // per-profile code. A tie / partial overlap / no-scope profile falls back to
    // requiring approval if any passer does (never a silent bypass).
    const contextKeys = getProfile(passers[0].profileId)?.contextSchema?.keyOrder ?? [];

    // Fallback on a stale-mandate refusal (see isStaleMandateRefusal): the AS
    // — not this process's local cache — is the source of truth on whether a
    // mandate is still valid. `attemptWithCandidates` reruns selection over a
    // candidate pool that shrinks by exactly the refused mandate on each
    // retry, so it is bounded by `passers.length`: at most one attempt per
    // distinct mandate, never the same id twice, and no path that loops
    // forever against an AS that keeps refusing.
    return attemptWithCandidates(passers);

    // `candidates` is never empty: the initial call passes `passers`, already
    // checked non-empty above, and the only recursive call site below only
    // recurses when at least one candidate remains — when none do, it returns
    // the AS's own refusal directly instead of recursing into an empty pool.
    async function attemptWithCandidates(candidates: EnrichedAuthorization[]): Promise<ToolResult> {
      const selection = selectAuthorization(
        contextKeys,
        candidates.map(a => ({
          id: a.authorizationId,
          auth: a,
          context: a.context ?? {},
          requiresApproval: (a.deferredCommitmentDomains ?? []).length > 0,
        })),
      );
      const auth = selection.chosen.auth;
      if (selection.superseded.length > 0) {
        console.error(
          `[Suveren MCP] selection(${tool.namespacedName}): chose ${auth.authorizationId} ` +
            `(${selection.reason}) over [${selection.superseded.map(s => s.id).join(', ')}]`,
        );
      }

        // Every SP reference (receipt, proposals, summary) is the per-ceremony id.
        const authzId = auth.authorizationId;

        // Enforce the SIGNED commitment_mode (defense against a downgrade via
        // unsigned AS metadata). For an honest AS, commitment_mode === 'review'
        // always comes with deferred commitment domains; if the signed payload
        // says review/review_above_cap but the AS supplied none, the unsigned
        // routing data contradicts the signature — fail closed rather than
        // silently auto-executing an action that required approval.
        if (isCommitmentDowngrade(auth)) {
          return {
            content: [{
              type: 'text',
              text: `Refusing to execute ${tool.originalName}: the signed authorization requires review ` +
                `(commitment_mode="${auth.signedCommitmentMode}") but the Authority Server returned no pending ` +
                `approvers. This inconsistency (a possible commitment-mode downgrade) is rejected fail-closed. ` +
                `Re-fetch the authorization or contact the Authority Server operator.`,
            }],
            isError: true,
          };
        }

        // Check for deferred commitment domains — submit proposal instead of executing
        if ((auth.deferredCommitmentDomains ?? []).length > 0) {
          try {
            const enrichedArgs = await attachImagePreview(args);
            const { proposal } = await state.spClient.submitProposal({
              authorizationId: authzId,
              profileId: auth.profileId,
              path: auth.path,
              pendingDomains: auth.deferredCommitmentDomains,
              tool: tool.namespacedName,
              toolArgs: enrichedArgs,
              executionContext: { ...execution },
            });
            // Record what WE submitted — ticket-verify.ts / commitments.ts
            // compares against this at execution time rather than trusting
            // the AS's echoed-back tool/args at face value.
            state.proposalSubmissions.record({
              proposalId: proposal.id,
              tool: tool.namespacedName,
              toolArgs: enrichedArgs,
              executionContext: { ...execution },
              authorizationId: authzId,
              profileId: auth.profileId,
            });
            return {
              content: [{
                type: 'text',
                text: `Awaiting commitment from domain${auth.deferredCommitmentDomains.length > 1 ? 's' : ''} ` +
                  `"${auth.deferredCommitmentDomains.join('", "')}" for tool ${tool.originalName}.\n` +
                  `Proposal ID: ${proposal.id}. Check status with check-pending-commitments(proposal_id: "${proposal.id}").`,
              }],
            };
          } catch (err) {
            // The submission's 401 (if that's what it was) already cleared our
            // session inside SPClient.fetch() — check the RESULT, not the error
            // shape, so this catches it regardless of how submitProposal threw.
            if (!state.spClient.isUnlocked()) {
              return {
                content: [{ type: 'text', text: lockedNotice(`use ${tool.namespacedName}`, 'expired') }],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to submit proposal: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }

        // Request receipt from SP (pre-flight — fail closed).
        //
        // `action` is the tool identifier used by the SP for the
        // PROPOSAL_MISMATCH equality check in review mode. In automatic
        // mode there's no proposal to match; we use the namespaced tool
        // name for consistency with the review-mode path.
        //
        // `actionType` tells the SP which bounds field to enforce
        // (e.g. write_daily_max vs delete_daily_max vs post_daily_max).
        // It MUST come from the integration manifest's staticExecution —
        // no prefix-based fallbacks. Presence and registry membership were
        // validated fail-closed above (declaredActionType), and the AS
        // rejects requests without it (INVALID_ACTION_TYPE) — its old
        // name-derived fallback is deleted.
        // Receipt id captured pre-flight, used to embed a verification link in
        // the outgoing content (Category-A profiles). Hoisted so it's in scope
        // after the try/catch where the downstream call happens.
        let receiptId: string | undefined;
        try {
          const actionType = declaredActionType;

          // M3: one stable idempotency key per tool invocation, generated
          // once here and reused across postReceipt's internal retries. If a
          // transient failure hides the AS response after it already counted
          // this execution, the retry returns the original receipt rather than
          // double-counting against the authority's bounds.
          // v0.5 Content Provenance: if the profile declares content_binding,
          // hash the agent's content (pre-footer `args`) and send the hash only.
          const binding = computeContentBinding(auth.profileId, tool, args, actionType);
          // G4: generated once here, sent on every postReceipt attempt
          // (including its internal retries) AND checked below against the
          // ticket the AS signs — binding the ticket to THIS invocation, not
          // just to "a call shaped like this one". See ticket-verify.ts.
          const idempotencyKey = randomUUID();
          const { receipt } = await state.spClient.postReceipt({
            authorizationId: authzId,
            // Optional cross-check — the AS fails closed on a mismatch.
            boundsHash: auth.boundsHash,
            profileId: auth.profileId,
            action: tool.namespacedName,
            actionType,
            executionContext: { ...execution },
            amount: typeof execution.amount === 'number' ? execution.amount : undefined,
            idempotencyKey,
            // Privacy: send the hash and how to reproduce it — never the
            // preimage. `binding` also carries `boundContent`, the plaintext
            // that was hashed (an email's to/cc/subject/body); it stays on
            // this machine for the local archive, so it must be picked out
            // field by field rather than spread.
            ...(binding
              ? { contentHash: binding.contentHash, contentBinding: binding.contentBinding }
              : {}),
          });
          receiptId = typeof receipt?.id === 'string' ? receipt.id : undefined;

          // Verify the ticket BEFORE trusting it for anything — signature
          // against the PINNED key, and its own bound fields against what
          // was just requested. "No ticket, no execution" is meaningless if
          // the ticket itself is never checked. Fail closed: this throws
          // (caught below) rather than returning a result, so there is no
          // path from here to the downstream tool call on a ticket that
          // didn't verify.
          await verifyTicket(state.cache, receipt, {
            action: tool.namespacedName,
            executionContext: { ...execution },
            authorizationId: authzId,
            profileId: auth.profileId,
            idempotencyKey,
            contentHash: binding?.contentHash,
            contentBinding: binding?.contentBinding,
          });

          // Subject custody: keep the complete signed receipt (+ attestation
          // blobs) locally so the evidence stays verifiable without the AS.
          // Best-effort — never blocks the execution the AS just authorized.
          await state.archiveReceipt(receipt, {
            authorizationId: authzId,
            profileId: auth.profileId,
            boundsHash: auth.boundsHash,
            contextHash: auth.contextHash,
            bounds: auth.bounds ?? auth.frame,
            context: auth.context,
            intent: auth.gateContent?.intent,
            attestations: auth.attestations,
            // Automatic path has no proposal, so without this the archive
            // would hold a hash of content it cannot reproduce.
            boundContent: binding?.boundContent,
          });
        } catch (err) {
          // The ticket didn't verify — either its signature disagrees with
          // the pinned Authority Server key, or its own bound fields
          // disagree with what was just requested. Refuse AND lock: this is
          // exactly the "different server / tampered ticket" case pinning
          // exists to catch, so a human must notice, not just this one call.
          if (err instanceof AsKeyMismatchError || err instanceof TicketBindingMismatchError) {
            void notifyControlPlane('as-key-mismatch');
            return {
              content: [{ type: 'text', text: `Blocked: ${err.message}` }],
              isError: true,
            };
          }

          // The profile binds a declared field set and this call cannot supply
          // it. Refuse: issuing the receipt anyway would produce one that
          // verifies while committing to less than it appears to.
          if (err instanceof ContentBindingError) {
            return {
              content: [{
                type: 'text',
                text: `Blocked: this action's content cannot be bound to the receipt — ${err.message}`,
              }],
              isError: true,
            };
          }

          if (err instanceof SPReceiptError && isStaleMandateRefusal(err)) {
            // The mandate selected for THIS call failed validity at the AS —
            // not a bound/approval refusal, so retrying the same call under a
            // different mandate is safe: the call itself was never judged,
            // only the authority offered to cover it was found dead. Purge it
            // from the local cache (the AS, not this cache, decided it's
            // dead — list-authorizations/list-integrations must stop
            // offering it immediately, same as the pre-existing revoked-403
            // purge below) and retry ONCE for this mandate: drop it from
            // THIS call's candidate pool and recurse. A sibling call already
            // in flight keeps its own pool, so this never cross-cancels
            // another invocation's in-progress selection.
            state.cache.invalidate(auth.authorizationId);
            const code = (err.body?.errors as Array<{ code?: unknown }> | undefined)?.[0]?.code ?? 'unknown';
            const remaining = candidates.filter(c => c.authorizationId !== auth.authorizationId);
            if (remaining.length === 0) {
              // Nothing left to fall back to — fail closed with the Authority
              // Server's own reason, exactly as a single-candidate refusal
              // always has, rather than a generic "exhausted" message that
              // would hide WHY (revoked vs. expired vs. not found).
              console.error(
                `[Suveren MCP] fallback(${tool.namespacedName}): mandate ${auth.authorizationId} invalid ` +
                  `(${code}) — no remaining candidates`,
              );
              return {
                content: [{ type: 'text', text: `Blocked by SP: ${err.message}` }],
                isError: true,
              };
            }
            console.error(
              `[Suveren MCP] fallback(${tool.namespacedName}): mandate ${auth.authorizationId} invalid ` +
                `(${code}) → retrying with [${remaining.map(c => c.authorizationId).join(', ')}]`,
            );
            return attemptWithCandidates(remaining);
          }

          if (err instanceof SPReceiptError && err.statusCode === 409) {
            // P8.2: SP returned approval_required — this action exceeds the team cap
            // for an above-cap authority. Route to per-action multi-party approval:
            // creator + all profile approvers must approve before execution.
            const spBody = err.body as {
              approvers?: string[];
              authorizationId?: string;
              field?: string;
              cap?: number;
            };
            // Prefer approvers from the 409 body; fall back to frameMeta frozen list.
            let pendingApprovers: string[] = spBody.approvers ?? [];
            if (pendingApprovers.length === 0) {
              // Defensive fallback: fetch frameMeta to get approversFrozen
              try {
                const summary = await state.spClient.getAuthorizationSummary(authzId);
                if (summary?.approvers_frozen) {
                  pendingApprovers = summary.approvers_frozen;
                }
                if (summary?.created_by) {
                  pendingApprovers = [summary.created_by, ...pendingApprovers];
                }
              } catch {
                // best effort
              }
            } else {
              // Always include creator at the front — Decision #4: above-cap = everyone reviews,
              // creator INCLUDED regardless of authority-level mode.
              try {
                const summary = await state.spClient.getAuthorizationSummary(authzId);
                if (summary?.created_by) {
                  pendingApprovers = [summary.created_by, ...pendingApprovers];
                }
              } catch {
                // best effort — proceed without creator in front
              }
            }
            const uniqueApprovers = [...new Set(pendingApprovers)];

            try {
              const enrichedArgs = await attachImagePreview(args);
              const { proposal } = await state.spClient.submitProposal({
                authorizationId: authzId,
                profileId: auth.profileId,
                path: auth.path,
                pendingDomains: [],
                tool: tool.namespacedName,
                toolArgs: enrichedArgs,
                executionContext: { ...execution },
                pendingApprovers: uniqueApprovers,
              });
              state.proposalSubmissions.record({
                proposalId: proposal.id,
                tool: tool.namespacedName,
                toolArgs: enrichedArgs,
                executionContext: { ...execution },
                authorizationId: authzId,
                profileId: auth.profileId,
              });
              return {
                content: [{
                  type: 'text',
                  text: `Action exceeds team cap. Approval required from ${uniqueApprovers.length} reviewer(s).\n` +
                    `Proposal ID: ${proposal.id}. Use check-pending-commitments to track status.`,
                }],
              };
            } catch (proposalErr) {
              if (!state.spClient.isUnlocked()) {
                return {
                  content: [{ type: 'text', text: lockedNotice(`use ${tool.namespacedName}`, 'expired') }],
                  isError: true,
                };
              }
              return {
                content: [{ type: 'text', text: `Failed to submit approval proposal: ${proposalErr instanceof Error ? proposalErr.message : String(proposalErr)}` }],
                isError: true,
              };
            }
          }

          if (err instanceof SPReceiptError && err.statusCode === 422) {
            // Hard ceiling — no approver path configured. Bubble as a hard error.
            return {
              content: [{ type: 'text', text: `Action blocked: ${err.message} (hard team ceiling — contact the team admin)` }],
              isError: true,
            };
          }

          if (err instanceof SPReceiptError && err.statusCode === 403) {
            // SP rejected — limit exceeded or revoked. If revoked, purge the
            // cached attestation so list-authorizations/list-integrations
            // reflect reality instead of serving a stale "authorized" view.
            if (/revoked/i.test(err.message)) {
              state.cache.invalidate(auth.authorizationId);
            }
            return {
              content: [{ type: 'text', text: `Blocked by SP: ${err.message}` }],
              isError: true,
            };
          }
          // A 401 here means the AS session ended (30-day expiry, or revoked)
          // — SPClient.fetch() already cleared it fail-fast for every other
          // in-flight call. Report the reason, not a bare "Authentication
          // required" that reads like a transient SP fault.
          if (!state.spClient.isUnlocked()) {
            return {
              content: [{ type: 'text', text: lockedNotice(`use ${tool.namespacedName}`, 'expired') }],
              isError: true,
            };
          }
          // SP unreachable — fail closed
          return {
            content: [{ type: 'text', text: `SP unavailable — tool call blocked. ${err instanceof Error ? err.message : ''}` }],
            isError: true,
          };
        }

        // Record execution in log for cumulative tracking
        state.executionLog.record({
          profileId: auth.profileId,
          path: auth.path,
          execution: { ...execution },
          timestamp: Math.floor(Date.now() / 1000),
        });

        // Authorization verified. Append the verification footer (Category-A
        // communicative profiles) and/or the store receipt_id (Category-B
        // structured stores that declare the field) to the outgoing call.
        let outgoingArgs =
          shouldAttachFooter() && receiptId
            ? appendVerificationFooter(tool, args, receiptId, auth.subjects?.[0])
            : args;
        if (receiptId) outgoingArgs = attachReceiptId(tool, outgoingArgs, receiptId);
        // LAST: transport encoding. After the hash and the footer, so the
        // binding stays over what was approved rather than over the wire form.
        outgoingArgs = encodeOutgoingArgs(tool, outgoingArgs);

        // One execution per ticket (see execution-journal.ts). On this path
        // the ticket was minted for this very invocation, so an existing row
        // means a retry re-entered here with a replayed ticket — the tool must
        // not run again on it. Read-only calls carry no ticket and no journal.
        if (receiptId) {
          const begun = state.executionJournal.begin({
            ticketId: receiptId,
            tool: tool.namespacedName,
            argsHash: hashToolArgs(args),
          });
          if (!begun.ok) {
            return {
              content: [{
                type: 'text',
                text:
                  `Blocked: ticket ${receiptId} was already used to execute ${tool.namespacedName} ` +
                  `(state: ${begun.existing.state}). Not running it again.`,
              }],
              isError: true,
            };
          }
          try {
            const result = await integrationManager.callTool(tool.integrationId, tool.originalName, outgoingArgs);
            state.executionJournal.complete(receiptId, 'done');
            return result;
          } catch (err) {
            state.executionJournal.complete(receiptId, 'failed');
            throw err;
          }
        }
        return integrationManager.callTool(tool.integrationId, tool.originalName, outgoingArgs);
    }
  });
}

/**
 * Build a description for a proxied tool that includes a short gating tag.
 *
 * Tags:
 * - [Suveren: charge — read] — read-only, requires authorization
 * - [Suveren: charge — charge, amount checked] — gated with specific checks
 * - [Suveren: charge — no active authorization] — gated but no auth available
 */
export function buildProxiedToolDescription(
  tool: DiscoveredTool,
  state: SharedState,
): string {
  if (!tool.gating || !tool.gating.profile) {
    return `[Suveren: no gating config] ${tool.description}`;
  }

  const profile = tool.gating.profile;
  const auths = state.getEnrichedAuthorizations();
  const hasAuth = auths.some(
    a => a.complete && profileMatches(a.profileId, profile),
  );

  if (!hasAuth) {
    return `[Suveren: ${profile} — no active authorization] ${tool.description}`;
  }

  if (tool.gating.category === 'read') {
    return `[Suveren: ${profile} — read] ${tool.description}`;
  }

  // Build a short tag describing what's checked
  const parts: string[] = [];
  if (tool.gating.staticExecution?.action_type) {
    parts.push(String(tool.gating.staticExecution.action_type));
  }
  const mappedFields = Object.values(tool.gating.executionMapping ?? {}).flatMap(m =>
    typeof m === 'string' ? [m] : Array.isArray(m) ? m.map(e => e.field) : [m.field],
  );
  if (mappedFields.length > 0) {
    parts.push(`${mappedFields.join(', ')} checked`);
  }

  const tag = parts.length > 0 ? parts.join(', ') : 'gated';
  return `[Suveren: ${profile} — ${tag}] ${tool.description}`;
}
