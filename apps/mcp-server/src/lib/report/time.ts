/**
 * Parses a simulator timestamp to unix seconds. Connector SQLite columns use
 * SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`, UTC, no
 * timezone marker) OR a full ISO 8601 string (e.g. email-mcp's
 * `exported_at`, and package-supplied `received_at` values) — both are
 * produced across the three connectors' exports, so both must parse.
 * Returns `undefined`, never `NaN`, on anything else — callers must treat
 * that as "could not verify", not as epoch 0.
 */
export function parseTimestampSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z` // bare "YYYY-MM-DD HH:MM:SS" — SQLite's datetime('now') is UTC
    : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
