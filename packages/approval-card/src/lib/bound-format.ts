/**
 * How a limit's unit reads next to its value — one definition for the mandate
 * editor and the approval screen. `count` reads as nothing: the count is its own
 * meaning.
 */
export function formatUnit(unit?: string): string {
  if (!unit || unit === 'count') return '';
  if (unit === 'minutes') return 'min';
  if (unit === 'hours') return 'hr';
  if (unit === 'days') return 'days';
  if (unit === 'percent') return '%';
  if (unit.startsWith('currency:')) return unit.slice('currency:'.length);
  return unit;
}

/** "€2,000": an amount in the currency a field's unit names (`currency:EUR`), the way the person reads money. */
export function formatMoney(amount: number, currencyCode: string): string {
  const code = currencyCode.trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // A code the runtime does not know: the code itself, never a guess.
    return `${amount.toLocaleString('en-US')} ${code}`;
  }
}

/**
 * One limit's value with its unit, in the one way every surface reads it (card, tile, list, phone): "€2,000" for a currency unit,
 * "20%" for percent, "30 days" / "240 min" for the others, the plain value for a count. Driven by the profile field's `unit` only.
 */
export function formatLimitValue(value: unknown, unit?: string): string {
  const text = String(value);
  if (!unit || unit === 'count') return text;
  if (unit.startsWith('currency:')) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isFinite(n) ? formatMoney(n, unit.slice('currency:'.length)) : `${text} ${unit.slice('currency:'.length)}`;
  }
  if (unit === 'percent') return `${text}%`;
  return `${text} ${formatUnit(unit)}`;
}
