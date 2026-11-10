/**
 * The words on the mandate change card. Everything comes from the sealed
 * differences (computed by the gateway from the signed mandate) and the gateway's
 * own local facts: the AI supplies no text except the intent, shown only as a
 * labelled word diff.
 */
import type { ChangeRow, ChangeTag, MandateDiff } from '@hap/core/mandate-change';
import { formatUnit } from './bound-format';
import { modeView } from './mandate-proposal';

export const CHANGE_MANDATE_TOOL = 'setup__change_mandate';

export interface ChangeArgs {
  mandate_id?: string;
  mandate_title?: string;
  change?: MandateDiff;
  intent?: string;
}

export interface ChangeFacts {
  limitReached: Array<{ field: string; label: string; limit: number; days: number; ofDays: number }>;
  today: Array<{ field: string; label: string; current: number; unit?: string }>;
  waiting: number | null;
}

export function tagClass(tag: ChangeTag): 'mc-more' | 'mc-less' {
  // Only "New" and "More" open something; a neutral "Changed" still stands out as a change.
  return tag === 'Less' || tag === 'Gone' ? 'mc-less' : 'mc-more';
}

export function rowValue(row: Pick<ChangeRow, 'unit'>, value: string | number | null): string {
  if (value === null) return '—';
  const u = formatUnit(row.unit);
  if (!u) return String(value);
  if (row.unit === 'percent') return `${value}${u}`;
  if (row.unit?.startsWith('currency:')) return `${u} ${value}`;
  return `${value} ${u}`;
}

export function dateText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function modeWord(mode: string): string {
  return modeView(mode)?.title ?? mode;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one warning sentence, or null when nothing would close. Null count = unknown: shown as such. */
export function waitingWarning(waiting: number | null | undefined): string | null {
  if (waiting === null) return 'The gateway could not check whether requests are waiting under the old mandate. Any that are will be closed.';
  if (waiting === undefined || waiting === 0) return null;
  return `${plural(waiting, 'waiting request', 'waiting requests')} under the old mandate will be closed.`;
}

/** "From your gateway": local facts about limits, one sentence each. */
export function gatewayFacts(facts: ChangeFacts | null, diff: MandateDiff): string[] {
  const lines: string[] = [];
  for (const f of facts?.limitReached ?? []) {
    lines.push(`The limit of ${f.limit} was reached on ${plural(f.days, 'day', 'days')} of the last ${f.ofDays}.`);
  }
  if (diff.versionMove) {
    lines.push(`Today's count restarts: this change moves to a newer version of the area.`);
  } else {
    const many = (facts?.today ?? []).length > 1;
    for (const t of facts?.today ?? []) {
      lines.push(`Today's count stays: ${t.current} already used${many ? ` (${t.label})` : ''}.`);
    }
  }
  return lines;
}

export function staysLines(diff: MandateDiff): string[] {
  return diff.stays.flatMap((s) => {
    if (s.label === 'mode') return [modeWord(s.value)];
    if (s.label === 'lasts-until') return [`Lasts until ${dateText(Number(s.value))}`];
    if (s.label === 'intent') return ['Why it\'s for'];
    return [`${s.label}: ${s.value}`];
  });
}
