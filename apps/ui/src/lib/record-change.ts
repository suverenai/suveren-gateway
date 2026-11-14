/**
 * An update's approval card shows the CHANGE, not the record (walkthrough
 * 2026-11-11: a CRM update_contact card showed "Name: Andreas", revision 1 and
 * every field — the contact as it is — so nobody could see that the name would
 * become "Andreas Schadauer").
 *
 * Input: the gateway's own preview read of the record the action changes (the
 * single read the manifest marks with a `version`, wire flag `target`) and the
 * action's bound arguments. Output, generic for any connector — matched by
 * argument name against the record's own field names, nothing named in code:
 *   - `lines`: each bound argument whose value differs from the record's —
 *     now (read by the gateway) → new (bound, what runs);
 *   - `also`: bound arguments the record does not carry (sent as they are);
 *   - `unchanged`: the record's other fields, for a folded "Unchanged" row.
 * Null when no bound argument changes a field of the record: then there is no
 * change to show and the card shows the record and the bound values apart.
 */
import { renderPreviewBody, resolveBodyObject, allPreviewFields, type RenderedPreview } from './preview-render';
import { HIDDEN_ARG_KEYS, humanizeKey } from './approval-view';
import { plainText, type CompareLine } from './creation-extras';
import type { PreviewBody } from './sp-client';

export interface RecordChange {
  lines: CompareLine[];
  also: Array<{ key: string; label: string; value: string }>;
  unchanged: RenderedPreview;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  // A scalar compares as the person reads it: 5 and "5" are the same, null and "" both empty.
  return plainText(v);
}

export function recordChange(
  body: PreviewBody | undefined,
  toolArgs: Record<string, unknown>,
  opts: { fields?: string[]; exclude?: readonly string[] } = {},
): RecordChange | null {
  const record = resolveBodyObject(body)?.obj;
  if (!record) return null;
  const labels = new Map(allPreviewFields(body).map((r) => [r.key, r.label]));
  const exclude = new Set(opts.exclude ?? []);
  const lines: CompareLine[] = [];
  const also: RecordChange['also'] = [];
  for (const [key, value] of Object.entries(toolArgs)) {
    if (value === undefined || HIDDEN_ARG_KEYS.has(key) || key.startsWith('_') || exclude.has(key)) continue;
    const label = labels.get(key) ?? humanizeKey(key);
    if (key in record) {
      if (stable(record[key]) !== stable(value)) lines.push({ key, label, now: plainText(record[key]), next: plainText(value) });
    } else {
      also.push({ key, label, value: plainText(value) });
    }
  }
  if (lines.length === 0) return null;
  const changed = new Set(lines.map((l) => l.key));
  const all = renderPreviewBody(body, { fields: opts.fields });
  const unchanged: RenderedPreview = {
    ...all,
    fields: all.fields.filter((f) => !changed.has(f.key)),
    moreFields: all.moreFields.filter((f) => !changed.has(f.key)),
    totalFields: all.totalFields - changed.size,
  };
  return { lines, also, unchanged };
}
