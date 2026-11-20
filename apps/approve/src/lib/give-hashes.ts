/**
 * The hashes a give covers, recomputed on THIS phone from the plaintext it shows (device-keys plan 4.4: "The granting device computes
 * every hash it signs from the plaintext it shows"). hap-core's own functions, the ones the gateway and the Authority Server use.
 *
 * `computeBoundsHash`, `computeScopeHash` and `computeIntentHash` are in hap-core's MAIN entry, not in its `/browser` entry (0.17.0). The
 * main entry imports no Node built-in (only @noble/ed25519 and @hpke/core); the phone build is checked for that by
 * `give-hashes.bundle.test.ts`, the same check hap-core runs on its browser entry.
 */
import { computeBoundsHash, computeScopeHash, computeIntentHash, computeProfileHash, computeExecutionContextHash, type AgentProfile } from '@hap/core';

export interface GiveHashes { profile: string; bounds: string; scope: string; intent: string; executionContext: string }

export function giveHashes(i: { profile: AgentProfile; bounds: Record<string, string | number>; scope: Record<string, string | number>; intent: string }): GiveHashes {
  return {
    profile: computeProfileHash(i.profile),
    bounds: computeBoundsHash(i.bounds as never, i.profile),
    scope: computeScopeHash(i.scope as never, i.profile),
    intent: computeIntentHash(i.intent),
    executionContext: computeExecutionContextHash(i.profile),
  };
}
