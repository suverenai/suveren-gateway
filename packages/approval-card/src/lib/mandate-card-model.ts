/**
 * The facts of a mandate proposal as the card shows them, from the three things every host has: the limits, the scope and the profile's
 * schema (plus how long it is granted for). The gateway reads them from the opened proposal, the phone from the give it checked; both get
 * the same rows, the same summary line and the same "Valid" text from here.
 */
import { mandateFacts, type FactSchema, type MandateFact } from './mandate-facts';
import { giveSummaryLine, validText, type SchemaLike } from '../mandate-screens/give-view';
import type { SourceManifestLike } from './attachment-sources';

export interface CardFactsInput {
  limits?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
  boundsSchema?: FactSchema;
  scopeSchema?: FactSchema;
  hidden?: ReadonlySet<string>;
  manifests?: SourceManifestLike[];
  /** The granted duration in seconds. */
  durationSeconds?: number | null;
  nowMs: number;
}

export function cardFacts(i: CardFactsInput): { limits: MandateFact[]; scope: MandateFact[]; valid: string; summary: string } {
  const { limits, scope } = mandateFacts(i);
  return {
    limits, scope,
    valid: validText(i.durationSeconds, i.nowMs),
    summary: giveSummaryLine({
      limits: i.limits as Record<string, string | number> | null | undefined, scope: i.scope, durationSeconds: i.durationSeconds,
      boundsSchema: i.boundsSchema as SchemaLike | undefined, scopeSchema: i.scopeSchema as SchemaLike | undefined, hidden: i.hidden,
    }),
  };
}
