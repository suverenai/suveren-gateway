/**
 * The sealed body of a mandate on a gateway that did not create it (device-keys plan 4.4 Transport, 20.19, DEC-58; step 13).
 *
 * Scope and intent are the person's words and values; the Authority Server holds only their hashes (signed in the mandate, covered by
 * the owner's grant). A second computer of the same owner gets them as a sealed body, opened by its own control plane with its own
 * key. Nothing of it is used before it is compared here with what the owner's grant signed:
 *
 *   - `scope_hash` = hash of the scope under the profile's own scope schema (and no value outside that schema);
 *   - `gate_content_hashes.intent` = hash of the intent.
 *
 * `intent_disclosure_hash` is the hash of the intent sealed to the APPROVERS (a different text form), and the bounds are not in the
 * body (their values come with the signed mandate and are covered by `bounds_hash`); neither can be checked against a body.
 *
 * What does not match, or cannot be opened, is not used: the mandate is not honoured on this computer and says "not yet received".
 * There is no path from the Authority Server's own plaintext to the gate: only an opened body that matched is kept.
 */
import { computeIntentHash, computeScopeHash, getProfile, type MandatePayload } from '@hap/core';
import type { GateStore } from './gate-store';

export interface BodyContent { scope: Record<string, string | number>; intent: string }

/** What a gateway holds of a mandate's scope and intent, and where an opened body goes. */
export interface BodyHold {
  /** What is stored for this authorization on this computer, if anything. */
  held(authorizationId: string): { scope?: Record<string, string | number>; intent?: string } | null;
  /** Keep a body that {@link checkBody} accepted. */
  keep(authorizationId: string, payload: MandatePayload, content: BodyContent): void;
}

export type BodyCheck = { ok: true } | { ok: false; why: string };

/** Does this scope and intent hash to what the (grant-covered) mandate says? */
export function checkBody(payload: MandatePayload, content: { scope?: unknown; intent?: unknown }): BodyCheck {
  const { scope, intent } = content;
  if (typeof intent !== 'string' || typeof scope !== 'object' || scope === null || Array.isArray(scope)) return { ok: false, why: 'malformed' };
  const profile = getProfile(payload.profile_id);
  if (!profile) return { ok: false, why: 'profile_unknown' };
  // A profile without scope fields hashes every scope the same: nothing may hide in it. A value outside the schema is not the scope.
  const fields = new Set(Object.keys((profile as { scopeSchema?: { fields?: Record<string, unknown> } }).scopeSchema?.fields ?? {}));
  if (Object.keys(scope).some(k => !fields.has(k))) return { ok: false, why: 'scope_field_unknown' };
  try {
    if (computeScopeHash(scope as never, profile) !== payload.scope_hash) return { ok: false, why: 'scope_mismatch' };
  } catch {
    return { ok: false, why: 'scope_invalid' };
  }
  const want = payload.gate_content_hashes?.intent;
  if (typeof want !== 'string' || computeIntentHash(intent) !== want) return { ok: false, why: 'intent_mismatch' };
  return { ok: true };
}

/** The gate store is the hold: the same entry the creating gateway gets at delivery, written here only from an accepted body. */
export function gateStoreHold(store: () => GateStore): BodyHold {
  return {
    held: id => {
      const e = store().get(id);
      return e ? { ...(e.context ? { scope: e.context } : {}), intent: e.gateContent?.intent } : null;
    },
    keep: (id, payload, content) => {
      const prev = store().get(id);
      store().set(id, {
        authorizationId: id,
        boundsHash: payload.bounds_hash,
        contextHash: payload.scope_hash,
        path: prev?.path ?? id,
        profileId: payload.profile_id,
        gateContent: { intent: content.intent },
        context: content.scope,
        // display names are UI sugar of the same scope values: kept only while the scope is the one they were made for
        ...(prev?.contextHash === payload.scope_hash && prev.contextLabels ? { contextLabels: prev.contextLabels } : {}),
        storedAt: new Date().toISOString(),
      });
    },
  };
}
