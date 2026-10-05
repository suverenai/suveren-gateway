/**
 * The commitment modes the mandate screen offers. A profile may allow only some
 * (`commitment_modes`, e.g. review only); the Authority Server refuses any other,
 * so the screen offers exactly what the AS will sign — from the same hap-core
 * helper, so the two cannot disagree.
 */
import { allowedCommitmentModes, type AgentProfile } from '@hap/core';

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
