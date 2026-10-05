/**
 * The commitment modes the mandate screen offers. A profile may allow only some
 * (`commitment_modes`, e.g. review only); the Authority Server refuses any other
 * (hap-core `allowedCommitmentModes`), so the screen offers exactly what the AS
 * will sign.
 *
 * The rule is restated here, not imported: hap-core's runtime pulls in Node's
 * crypto and cannot be bundled for the browser (the UI imports only its types,
 * like computeBoundsHashBrowser restates the bounds hash). The tests pin the
 * same cases as hap-core's: absent = both, a list = those, malformed = none.
 */
import type { AgentProfile } from '@hap/core';

/** hap-core allowedCommitmentModes, for the browser: display order, fail-closed. */
function allowedCommitmentModes(profile: AgentProfile): Array<'review' | 'automatic'> {
  const declared = (profile as { commitment_modes?: unknown }).commitment_modes;
  if (declared === undefined) return ['review', 'automatic'];
  if (!Array.isArray(declared)) return [];
  return (['review', 'automatic'] as const).filter((m) => declared.includes(m));
}

/** The screen's names: 'per-action' = review, 'immediate' = automatic. */
export type UiCommitMode = 'immediate' | 'per-action';

export function toProtocolMode(mode: UiCommitMode): 'review' | 'automatic' {
  return mode === 'per-action' ? 'review' : 'automatic';
}

/** The modes to offer, review first. Before the profile has loaded: both, as before. */
export function offeredCommitModes(profile: AgentProfile | null): UiCommitMode[] {
  if (!profile) return ['per-action', 'immediate'];
  return allowedCommitmentModes(profile).map((m) => (m === 'review' ? 'per-action' : 'immediate'));
}

/**
 * The mode to show selected: the current one if offered, else the first offered
 * (a template or an edited grant may carry a mode the profile no longer allows).
 * Null when the profile allows none — nothing can be signed.
 */
export function settleCommitMode(current: UiCommitMode, offered: UiCommitMode[]): UiCommitMode | null {
  if (offered.includes(current)) return current;
  return offered[0] ?? null;
}
