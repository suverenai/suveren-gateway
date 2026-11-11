/**
 * Reading the signed mandate an AI wants to change, and the gateway's own local facts
 * for the approval card. Nothing here takes the AI's word for anything.
 */
import { computeBoundsHash, computeIntentHash, computeScopeHash, decodeMandateBlob, getProfile, verifyMandateSignature } from '@hap/core';
import type { ChangeRow, MandateDiff } from '@hap/core/mandate-change';
import type { SharedState, EnrichedAuthorization } from './shared-state';
import { getConsumptionState } from './consumption';
import type { DenialRecord } from './denial-log';
import { issuerFromPublicKeyHex } from './issuer-from-hex';

export interface SignedMandate {
  authorizationId: string;
  profileId: string;
  groupId: string;
  ownerDid: string;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string;
  mode: 'review' | 'automatic';
  expiresAt: number;
  title?: string;
  disclosesIdentity?: boolean;
}

export type SignedMandateRead = { old: SignedMandate; short: string; authorization: EnrichedAuthorization };

const short = (id: string) => id.replace(/@.*$/, '').split('/').pop()?.toLowerCase() ?? id;

/** The newest decodable blob of this mandate: the one the Authority Server treats as current. */
function latestSigned(auth: EnrichedAuthorization) {
  let best: ReturnType<typeof decodeMandateBlob> | undefined;
  let at = -Infinity;
  for (const a of auth.attestations) {
    try {
      const d = decodeMandateBlob(a.blob);
      const issued = typeof d.payload.issued_at === 'number' ? d.payload.issued_at : 0;
      if (issued >= at) { at = issued; best = d; }
    } catch { /* an undecodable blob names nothing */ }
  }
  return best;
}

export function readSignedMandate(state: SharedState, id: string): SignedMandateRead | { refusal: string; code: string } {
  const auth = state.getEnrichedAuthorizations().find(a => a.authorizationId === id);
  if (!auth) return { refusal: `No active mandate here has the id "${id}". Check list-authorizations.`, code: 'MANDATE_NOT_ACTIVE' };
  if (!auth.complete) return { refusal: 'This mandate is not complete yet, so it cannot be changed.', code: 'MANDATE_NOT_ACTIVE' };
  const decoded = latestSigned(auth);
  const ownerDid = decoded?.payload.mandate_owners?.[0]?.did;
  if (!decoded || !ownerDid) return { refusal: 'This mandate\'s signed copy cannot be read here, so it cannot be changed.', code: 'MANDATE_NOT_READABLE' };
  const profile = getProfile(auth.profileId);
  if (!profile) return { refusal: `This gateway does not know the area version this mandate was signed on (${auth.profileId}). Ask the person to update the gateway.`, code: 'MANDATE_NOT_READABLE' };

  const bounds = (auth.bounds ?? auth.frame) as Record<string, string | number>;
  const context = auth.context ?? {};
  const intent = auth.gateContent?.intent ?? '';
  if (!intent) return { refusal: 'This mandate\'s intent is not on this gateway, so it cannot be changed here.', code: 'MANDATE_NOT_READABLE' };
  // The gateway's own copy must reproduce what was signed, or it would build the change on something the person never signed.
  const same = computeBoundsHash(bounds as never, profile) === decoded.payload.bounds_hash
    && computeScopeHash(context as never, profile) === decoded.payload.scope_hash
    && computeIntentHash(intent) === decoded.payload.gate_content_hashes?.intent;
  if (!same) return { refusal: 'This gateway\'s copy of the mandate does not match what was signed, so it cannot be changed. Tell the person.', code: 'MANDATE_COPY_MISMATCH' };

  const signedMode = auth.signedCommitmentMode ?? (auth.deferredCommitmentDomains.length > 0 ? 'review' : 'automatic');
  // review_above_cap is a team's cap on an automatic mandate, not the person's own choice; the AS applies the cap again.
  const mode: 'review' | 'automatic' = signedMode === 'review' ? 'review' : 'automatic';
  const expiresAt = Math.max(...auth.attestations.map(a => a.expiresAt));
  if (!auth.groupId) return { refusal: 'This mandate\'s workspace could not be read, so it cannot be changed yet. Try again in a moment.', code: 'MANDATE_NOT_READABLE' };

  return {
    short: short(auth.profileId),
    authorization: auth,
    old: {
      authorizationId: auth.authorizationId,
      profileId: auth.profileId,
      groupId: auth.groupId,
      ownerDid,
      bounds,
      context,
      intent,
      mode,
      expiresAt,
      ...(auth.title ? { title: auth.title } : {}),
      ...((auth.subjects?.length ?? 0) > 0 ? { disclosesIdentity: true } : {}),
    },
  };
}

/** Verify the signed copy with the pinned Authority Server key. Throws when it does not. */
export async function verifySignedCopy(state: SharedState, auth: EnrichedAuthorization): Promise<void> {
  const decoded = latestSigned(auth);
  if (!decoded) throw new Error('no signed copy');
  await verifyMandateSignature(decoded, { trustedIssuers: [issuerFromPublicKeyHex(await state.cache.getPublicKey())] });
}

/**
 * A scope value is data the card shows and the Gatekeeper compares, never a sentence. Each list
 * element is at most 120 characters and 5 words, on one line: enough for any real value, too
 * little to carry instructions to the person approving.
 */
export function scopeValueRefusal(scope: unknown): string | undefined {
  if (scope === undefined || scope === null) return undefined;
  if (typeof scope !== 'object' || Array.isArray(scope)) return '`scope` must be an object.';
  for (const [key, value] of Object.entries(scope as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') return `\`scope.${key}\` must be a string or a number.`;
    for (const part of String(value).split(',')) {
      if (part.length > 120 || /[\r\n\t]/.test(part) || part.trim().split(/\s+/).length > 5) {
        return `\`scope.${key}\` does not look like a scope value. Give values only, such as names or addresses.`;
      }
    }
  }
  return undefined;
}

export interface LocalChangeFacts {
  /** One line per changed cumulative limit that was reached recently. */
  limitReached: Array<{ field: string; label: string; limit: number; days: number; ofDays: number }>;
  /** Today's use of each changed cumulative limit, from this gateway's own log. */
  today: Array<{ field: string; label: string; current: number; unit?: string }>;
  /** Requests waiting under the old mandate, which close when it is revoked. Null = could not be read. */
  waiting: number | null;
  /**
   * Recent refusals this gateway recorded under this mandate's area that the change would
   * have allowed, newest first, at most two. Values are only those the change adds (already
   * on the card); a number is the refused amount from the gateway's own record.
   */
  refused: Array<{ field: string; ts: number; values?: string[]; value?: number }>;
}

const MAX_REFUSED = 2;
const lower = (v: string) => v.trim().toLowerCase();

/**
 * Would this changed row have allowed that refused call? Only the gateway's own record and the
 * sealed row are read. A list: every refused value is allowed after the change (an empty list
 * by the gateway's rule for it). A number: the refused value fits the new limit.
 */
function wouldAllow(row: ChangeRow, d: DenialRecord, execField: string | undefined): { values?: string[]; value?: number } | null {
  if (d.field !== row.field && (execField === undefined || d.field !== execField)) return null;
  if (row.added || row.removed) {
    if (d.kind !== 'scope' || typeof d.value !== 'string') return null;
    const refused = d.value.split(',').map(lower).filter(Boolean);
    const after = typeof row.after === 'string' ? row.after.split(',').map(lower).filter(Boolean) : [];
    const allowsAll = after.length === 0 && row.emptyMeans !== 'nothing';
    if (refused.length === 0 || !(allowsAll || refused.every(v => after.includes(v)))) return null;
    const values = (row.added ?? []).filter(v => refused.includes(lower(v)));
    return values.length > 0 ? { values } : allowsAll ? {} : null;
  }
  const value = typeof d.value === 'number' ? d.value : typeof d.value === 'string' && d.value.trim() !== '' ? Number(d.value) : NaN;
  if (d.kind !== 'bound' || !Number.isFinite(value) || typeof row.after !== 'number') return null;
  if (value > row.after || (typeof row.before === 'number' && value <= row.before)) return null;
  return { value };
}

/** Local facts for the card: from this gateway's own logs, never from the AI. */
export async function changeFacts(state: SharedState, mandateId: unknown, change: unknown): Promise<LocalChangeFacts> {
  const facts: LocalChangeFacts = { limitReached: [], today: [], waiting: null, refused: [] };
  const auth = state.getEnrichedAuthorizations().find(a => a.authorizationId === mandateId);
  const rows = (change as MandateDiff | undefined)?.rows ?? [];
  if (auth) {
    const profile = getProfile(auth.profileId);
    const consumption = profile ? getConsumptionState(auth, state.executionLog, profile) : [];
    const since = Date.now() - 7 * 86_400_000;
    const denials = state.denialLog?.getRecent(since) ?? [];
    const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    for (const row of rows as ChangeRow[]) {
      const entry = consumption.find(e => e.field === row.field);
      if (!entry) continue;
      facts.today.push({ field: row.field, label: row.label, current: entry.current, ...(row.unit ? { unit: row.unit } : {}) });
      const days = new Set(denials
        .filter(d => d.kind === 'cumulative' && d.field === row.field && d.profile === auth.profileId && d.ts >= since)
        .map(d => dayOf(d.ts)));
      if (days.size > 0 && typeof row.before === 'number') {
        facts.limitReached.push({ field: row.field, label: row.label, limit: row.before, days: days.size, ofDays: 7 });
      }
    }
    // Refusals under this mandate (or, when the record names no mandate, its area) that the change would have allowed.
    const area = short(auth.profileId);
    const mine = denials
      .filter(d => d.ts >= since && (d.mandateId ? d.mandateId === auth.authorizationId : !!d.profile && short(d.profile) === area))
      .sort((x, y) => y.ts - x.ts);
    for (const d of mine) {
      if (facts.refused.length >= MAX_REFUSED) break;
      for (const row of rows as ChangeRow[]) {
        const bt = profile?.boundsSchema?.fields?.[row.field]?.boundType as { of?: string } | undefined;
        const hit = wouldAllow(row, d, row.section === 'limit' ? bt?.of : undefined);
        if (hit) { facts.refused.push({ field: row.field, ts: d.ts, ...hit }); break; }
      }
    }
  }
  try {
    // The gateway's own submissions: the same source the "my pending" list reads.
    const submitted = state.proposalSubmissions.list();
    const proposals = await Promise.all(submitted.map(s => state.spClient.getProposal(s.proposalId).catch(() => null)));
    facts.waiting = proposals.filter(p => p !== null && p.status === 'pending' && p.authorizationId === mandateId).length;
  } catch {
    facts.waiting = null;
  }
  return facts;
}
