/**
 * The words on the mandate change card. Everything comes from the sealed
 * differences (computed by the gateway from the signed mandate) and the gateway's
 * own local facts: the AI supplies no text except the intent, shown only as a
 * labelled word diff.
 */
import type { ChangeRow, ChangeTag, MandateDiff } from '@hap/core/mandate-change';
import { formatUnit } from './bound-format';
import { modeView } from './mandate-proposal';
import { ATTACHMENT_SOURCE_HEADING, attachmentSourceLabel, isAttachmentSourceField, type SourceManifestLike } from './attachment-sources';

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
  /** Refusals the gateway recorded that this change would have allowed (absent from an older gateway). */
  refused?: Array<{ field: string; ts: number; values?: string[]; value?: number }>;
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

/** The field's name as the mandate form shows it: its own heading where it has one, else the profile's name. */
export function rowLabel(row: Pick<ChangeRow, 'label' | 'format'>): string {
  return isAttachmentSourceField(row) ? ATTACHMENT_SOURCE_HEADING : row.label;
}

/** One list value by the name the person knows: a document source by its manifest title. */
export function valueName(row: Pick<ChangeRow, 'format'>, value: string, manifests: SourceManifestLike[] | undefined): string {
  return isAttachmentSourceField(row) ? attachmentSourceLabel(manifests, value) : value;
}

function names(row: ChangeRow, values: string[] | undefined, manifests: SourceManifestLike[] | undefined): string {
  return (values ?? []).map((v) => valueName(row, v, manifests)).join(', ');
}

/**
 * One sentence under a changed row: what the change allows. Built only from the sealed row
 * (field, values, tag) and the manifests' names, never from the AI's words. A document-source
 * list reads in the form's own terms (the picker's "these emails", "text only"); every other
 * field uses the generic "This allows more/less than before: ..." form.
 */
export function rowMeaning(row: ChangeRow, manifests: SourceManifestLike[] | undefined): string {
  if (row.added || row.removed) {
    const added = names(row, row.added, manifests);
    const removed = names(row, row.removed, manifests);
    if (isAttachmentSourceField(row)) {
      if (row.after === null && row.emptyMeans === 'nothing') return 'From now on, emails under this mandate carry text only.';
      if (added && removed) return `From now on, emails under this mandate may also carry: ${added}; no longer: ${removed}.`;
      if (added) return `From now on, emails under this mandate may also carry: ${added}.`;
      return `From now on, emails under this mandate may no longer carry: ${removed}.`;
    }
    if (row.emptyMeans !== 'nothing' && row.before === null) return `This allows less than before: only ${added} from now on.`;
    if (row.emptyMeans !== 'nothing' && row.after === null) return `This allows more than before: no longer only ${removed}.`;
    if (added && removed) return `This allows more than before: also ${added}; no longer ${removed}.`;
    if (added) return `This allows more than before: also ${added}.`;
    return `This allows less than before: no longer ${removed}.`;
  }
  switch (row.tag) {
    case 'More': return `This allows more than before: up to ${rowValue(row, row.after)} instead of ${rowValue(row, row.before)}.`;
    case 'Less': return `This allows less than before: up to ${rowValue(row, row.after)} instead of ${rowValue(row, row.before)}.`;
    case 'New': return `The newer version of the area adds this: ${rowValue(row, row.after)}.`;
    case 'Gone': return 'The newer version of the area no longer has this.';
    default: return `This changes what is allowed: ${rowValue(row, row.after)} instead of ${rowValue(row, row.before)}.`;
  }
}

/** The sentence under "How it runs". */
export function modeMeaning(tag: ChangeTag): string {
  if (tag === 'More') return 'From now on, your AI acts without asking you first.';
  if (tag === 'Less') return 'From now on, your AI asks you before each action.';
  return 'This changes how your AI acts under this mandate.';
}

/** The sentence under "Lasts until". */
export function lastsUntilMeaning(tag: ChangeTag): string {
  return tag === 'Less' ? 'This mandate ends sooner than before.' : 'This mandate lasts longer than before.';
}

/** "today at 10:42", "yesterday at 10:42", "on 9 Nov at 10:42" — in the reader's own time. */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

/** A refusal the gateway recorded that this change would have allowed, as one sentence. */
export function refusalLine(
  r: NonNullable<ChangeFacts['refused']>[number],
  diff: MandateDiff,
  manifests: SourceManifestLike[] | undefined,
  now = Date.now(),
): string | null {
  const row = diff.rows.find((x) => x.field === r.field);
  if (!row) return null;
  const when = whenText(r.ts, now);
  const tail = `${when}, because this mandate did not allow it.`;
  if (r.values?.length) {
    const what = names(row, r.values, manifests);
    return isAttachmentSourceField(row)
      ? `Your AI was refused attaching ${what} ${tail}`
      : `Your AI was refused ${what} (${rowLabel(row)}) ${tail}`;
  }
  if (typeof r.value === 'number') return `Your AI was refused ${rowValue(row, r.value)} (${rowLabel(row)}) ${tail}`;
  return `Your AI was refused under ${rowLabel(row)} ${tail}`;
}

/** "From your gateway": local facts about limits, one sentence each. */
export function gatewayFacts(facts: ChangeFacts | null, diff: MandateDiff, manifests?: SourceManifestLike[], now = Date.now()): string[] {
  const lines: string[] = [];
  // Why the change is asked for, from the gateway's own refusal log: at most two lines.
  for (const r of (facts?.refused ?? []).slice(0, 2)) {
    const line = refusalLine(r, diff, manifests, now);
    if (line) lines.push(line);
  }
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

export function staysLines(diff: MandateDiff, manifests?: SourceManifestLike[]): string[] {
  return diff.stays.flatMap((s) => {
    if (s.label === 'mode') return [modeWord(s.value)];
    if (s.label === 'lasts-until') return [`Lasts until ${dateText(Number(s.value))}`];
    if (s.label === 'intent') return ['Why it\'s for'];
    if (isAttachmentSourceField(s)) {
      const named = s.value.split(',').map((v) => v.trim()).filter(Boolean).map((v) => valueName(s, v, manifests)).join(', ');
      return [`${ATTACHMENT_SOURCE_HEADING}: ${named}`];
    }
    return [`${s.label}: ${s.value}`];
  });
}
