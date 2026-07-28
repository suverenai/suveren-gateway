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
import { isCommitmentDowngrade } from './attestation-cache';
import { appendVerificationFooter, shouldAttachFooter } from './receipt-footer';
import { computeContentBinding, attachReceiptId } from './content-binding';
import { selectAuthorization } from './scope-specificity';
import {
  boundsSatisfyReadGate,
  resolveAgeBoundField,
  maxReadAgeDays,
  parseMessageTimestamp,
  isOlderThanMaxAge,
  getByDottedPath,
  composeReadQuery,
  readToolIsGoverned,
  allowedResources,
  deniedResources,
  filterItemsByResource,
  hasBlockedValue,
  type BoundsSchemaLike,
} from './read-gate';
import { getProfile } from '@hap/core';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
export function createGatedToolHandler(
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
          content: [{ type: 'text', text: lockedNotice(`use ${tool.namespacedName}`) }],
          isError: true,
        };
      }
      return inner(args);
    };


  // Tools the manifest declares unavailable are always blocked at the gate.
  if (category === 'disabled') {
    return async () => ({
      content: [{
        type: 'text',
        text: `Tool "${tool.namespacedName}" is disabled by the integration manifest and cannot be used.`,
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
      // NOTE (deferred feature): a "local per-integration read age" was designed
      // and scaffolded (IntegrationConfig.readAgeDays + IntegrationManager
      // .getReadAgeDays) but PARKED — moving the value off the signed grant needs
      // the control-plane + UI to set it, or reads fail-closed with no way to fix
      // it. Until that ships, the age stays a signed grant bound (below).
      let readMaxAge: number | null = null;
      if (ageBoundField) {
        readMaxAge = maxReadAgeDays(
          matchingAuths.map(a => (a.bounds ?? a.frame) as Record<string, string | number> | undefined),
          ageBoundField,
        );
        if (readMaxAge === null) {
          return denyRead(state, tool, 'unset_age',
            `no read-age window is set on your authorization (${ageBoundField}). Reads are not ` +
            `permitted with an unbounded window — set how far back the agent may read, then try ` +
            `again. Nothing was read.`);
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

      // Pre-fetch: AND the age ceiling into the search query (list/search tools)
      // so out-of-window items can't come back at all.
      if (readAdapter?.queryArg) {
        const clauses: string[] = [];
        if (ageBoundField && readAdapter.ageConstraint && readMaxAge !== null) {
          clauses.push(readAdapter.ageConstraint.replace('{days}', String(readMaxAge)));
        }
        if (clauses.length > 0) {
          // F8: the agent's fragment must not be able to bind across the
          // boundary and capture the injected clauses (a trailing `OR` turns
          // the intended AND into a union). composeReadQuery validates and
          // brackets; an unsafe fragment is a denial, never a silent rewrite.
          const base = typeof args[readAdapter.queryArg] === 'string' ? (args[readAdapter.queryArg] as string) : '';
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
      // readMaxAge is guaranteed non-null here when ageBoundField is set (the
      // unset case failed closed above).
      if (readAdapter && ageBoundField && readAdapter.resultDatePath && readMaxAge !== null) {
        const parsed = parseFirstJson(result);
        const rawDate = parsed === undefined ? undefined : getByDottedPath(parsed, readAdapter.resultDatePath);
        if (isOlderThanMaxAge(parseMessageTimestamp(rawDate), readMaxAge, Date.now())) {
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
      if (result.approved) {
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
    const selection = selectAuthorization(
      contextKeys,
      passers.map(a => ({
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
    {
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
            return {
              content: [{
                type: 'text',
                text: `Awaiting commitment from domain${auth.deferredCommitmentDomains.length > 1 ? 's' : ''} ` +
                  `"${auth.deferredCommitmentDomains.join('", "')}" for tool ${tool.originalName}.\n` +
                  `Proposal ID: ${proposal.id}. Check status with check-pending-commitments(proposal_id: "${proposal.id}").`,
              }],
            };
          } catch (err) {
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
        // no prefix-based fallbacks. If a manifest declares a write tool
        // without action_type, we log a warning and send undefined; the
        // SP's generic action.split('_')[0] fallback is a last-resort
        // guard but is never expected to fire in practice.
        // Receipt id captured pre-flight, used to embed a verification link in
        // the outgoing content (Category-A profiles). Hoisted so it's in scope
        // after the try/catch where the downstream call happens.
        let receiptId: string | undefined;
        try {
          const actionType =
            typeof execution.action_type === 'string' ? execution.action_type : undefined;
          if (!actionType) {
            console.error(
              `[Suveren MCP] Warning: tool ${tool.namespacedName} has no action_type in staticExecution. ` +
                `Bounds check may be skipped. Fix the integration manifest.`,
            );
          }

          // M3: one stable idempotency key per tool invocation, generated
          // once here and reused across postReceipt's internal retries. If a
          // transient failure hides the AS response after it already counted
          // this execution, the retry returns the original receipt rather than
          // double-counting against the authority's bounds.
          // v0.5 Content Provenance: if the profile declares content_binding,
          // hash the agent's content (pre-footer `args`) and send the hash only.
          const binding = computeContentBinding(auth.profileId, tool, args);
          const { receipt } = await state.spClient.postReceipt({
            authorizationId: authzId,
            // Optional cross-check — the AS fails closed on a mismatch.
            boundsHash: auth.boundsHash,
            profileId: auth.profileId,
            action: tool.namespacedName,
            actionType,
            executionContext: { ...execution },
            amount: typeof execution.amount === 'number' ? execution.amount : undefined,
            idempotencyKey: randomUUID(),
            ...(binding ?? {}),
          });
          receiptId = typeof receipt?.id === 'string' ? receipt.id : undefined;
        } catch (err) {
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
              return {
                content: [{
                  type: 'text',
                  text: `Action exceeds team cap. Approval required from ${uniqueApprovers.length} reviewer(s).\n` +
                    `Proposal ID: ${proposal.id}. Use check-pending-commitments to track status.`,
                }],
              };
            } catch (proposalErr) {
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
