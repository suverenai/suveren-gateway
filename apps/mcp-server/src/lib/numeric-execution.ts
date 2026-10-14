/**
 * Numeric execution-context fields that arrive from a tool call as a STRING.
 *
 * Some downstream connectors declare a numeric field as a string in their OWN
 * tool schema — Mollie's `amount` (Pydantic `amount: str`, e.g. "0.10") is the
 * motivating case, found when no amount could pass both the Gatekeeper (which
 * wants a number to compare against `amount_max`) and Mollie (which wants the
 * exact string it was given, back unchanged). The AI must keep sending
 * whichever type the connector's schema demands — it has no say over that —
 * so the fix is not to coerce what goes downstream. It is to parse a STRING
 * for the LOCAL bound comparison and for what travels to the Authority
 * Server, which both need a real number.
 *
 * Generic and profile-schema-driven, not Mollie-specific: it applies to
 * whichever execution-context field a profile's OWN `executionContextSchema`
 * declares numeric (`source: 'declared'`, `constraint.type: 'number'`) —
 * `amount` on `charge`/`purchase` today, nothing hardcoded for either.
 */

import { getProfile, type AgentProfile } from '@hap/core';

/**
 * Parse a numeric string for a numeric execution-context field. Accepts only
 * a PLAIN decimal — optional leading "-", digits, optional "." + digits:
 * "0.10", "12", "1234.50". Rejects everything `Number()` would otherwise
 * accept that a plain decimal should not: exponents ("1e3"), hex ("0x10"),
 * empty or whitespace-padded strings ("", " 1"), thousands separators
 * ("1,00"), and the non-finite literals ("NaN", "Infinity").
 *
 * Returns `undefined` on anything that fails the check, so the caller can
 * leave the original string in place — the existing type-mismatch bound
 * error then still fires with that original value visible in its message,
 * rather than silently passing a malformed input through as some number.
 */
export function parseNumericString(value: string): number | undefined {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The execution-context field names a profile's OWN `executionContextSchema`
 * declares as `source: 'declared'` and `constraint.type: 'number'` — e.g.
 * `amount` on `charge`. Schema-driven: reads the profile's own declaration,
 * never a field name or connector literal.
 */
export function declaredNumericFields(profile: AgentProfile | undefined): Set<string> {
  const out = new Set<string>();
  const fields = profile?.executionContextSchema?.fields;
  if (!fields) return out;
  for (const [name, def] of Object.entries(fields)) {
    if (def.source === 'declared' && def.constraint?.type === 'number') out.add(name);
  }
  return out;
}

/**
 * Mutate `execution` in place: for every field the profile declares numeric,
 * parse a string value as a plain decimal and replace it with the number.
 * A value that is already a number, or a string that fails the strict
 * parse, is left untouched — the latter keeps the Gatekeeper's own
 * type-mismatch refusal intact (see `parseNumericString`).
 *
 * Never touches the caller's original tool `args` — only the derived
 * `execution` object used for the Gatekeeper's local check and for what is
 * sent to the Authority Server. The exact original argument the agent
 * supplied still reaches the downstream tool unchanged.
 */
export function coerceDeclaredNumericFields(
  profileId: string,
  execution: Record<string, string | number>,
): void {
  const fields = declaredNumericFields(getProfile(profileId));
  for (const field of fields) {
    const value = execution[field];
    if (typeof value !== 'string') continue;
    const parsed = parseNumericString(value);
    if (parsed !== undefined) execution[field] = parsed;
  }
}
