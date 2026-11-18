/**
 * "Change it myself": the mandate form pre-filled with what the AI proposed. The
 * values are the signed mandate with the sealed differences applied, so nothing
 * the AI said beyond those differences reaches the form.
 */
import type { MandateDiff } from '@hap/core/mandate-change';
import type { ChangeArgs } from './mandate-change-view';

interface SignedEntry {
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string | null;
  deferredCommitmentDomains: string[];
  expiresAt?: number | null;
}

function applyRows(values: Record<string, string | number>, rows: MandateDiff['rows'], section: 'limit' | 'scope') {
  const out = { ...values };
  for (const r of rows) {
    if (r.section !== section) continue;
    if (r.after === null) delete out[r.field];
    else out[r.field] = r.after;
  }
  return out;
}

/** The prefill for the form (the `agentGate` shape). Duration: the proposed end, else the signed one. */
export function applyChangeForEdit(old: SignedEntry, args: ChangeArgs, nowSec = Math.floor(Date.now() / 1000)) {
  const diff = args.change!;
  const ttl = diff.lastsUntil ? diff.lastsUntil.after - nowSec : (old.expiresAt ?? 0) - nowSec;
  return {
    bounds: applyRows(old.bounds, diff.rows, 'limit'),
    context: applyRows(old.context, diff.rows, 'scope'),
    gateContent: { intent: typeof args.intent === 'string' ? args.intent : old.intent ?? '' },
    templateMode: (diff.mode?.after ?? (old.deferredCommitmentDomains.length > 0 ? 'review' : 'automatic')) as 'review' | 'automatic',
    templateTtl: ttl > 0 ? ttl : undefined,
  };
}
