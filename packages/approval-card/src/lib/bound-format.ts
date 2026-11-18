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
