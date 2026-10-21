/**
 * Two generic additions to the "What will be created" view (ERP Local
 * checks, signed off by Andreas 2026-10-21 — temp/erp-checks-mockup):
 *
 *  - a DISPLAY-ONLY read (manifest `displayOnly`, e.g. a live register
 *    lookup) is shown as its own "From <label> — checked <time>" system box,
 *    never merged into the sealed values: it is not what will be saved, and
 *    the connector asks again when it saves;
 *  - `display.compare` (arg -> path of the current value in an attached
 *    read) renders those args as one Now / New table.
 *
 * Pure: no fetch, no connector names — everything comes from the manifest's
 * declarations and the reads the gateway ran.
 */
import type { PreviewReadSection, ToolDisplayHints } from './sp-client';
import { resolveBodyObject } from './preview-render';

export interface SystemBoxRow { key: string; label: string; value: string }
export interface SystemBox { key: string; heading: string; rows: SystemBoxRow[] }
export interface CompareLine { key: string; label: string; now: string; next: string }

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** One value as plain text — a list as "a, b", nothing as "—". */
export function plainText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(plainText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** "21 Oct 2026, 09:15" in the viewer's locale. */
export function checkedAtText(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The system box for a display-only read with an `attach`: its rows are the
 * read's fields the manifest LABELS (`labels["<attach>.<path>"]`), minus
 * `hidden`, in label order. Null when the read did not answer or nothing
 * labelled has a value.
 */
export function displayOnlyBox(section: PreviewReadSection, hints: ToolDisplayHints | undefined, readAt?: number): SystemBox | null {
  if (!section.displayOnly || !section.attach) return null;
  const outcome = section.result;
  if (!outcome || outcome.status !== 'ok') return null;
  const body = resolveBodyObject(outcome.body)?.obj;
  if (!body) return null;
  const prefix = `${section.attach}.`;
  const hidden = new Set(hints?.hidden ?? []);
  const rows: SystemBoxRow[] = [];
  for (const [path, label] of Object.entries(hints?.labels ?? {})) {
    if (!path.startsWith(prefix) || hidden.has(path)) continue;
    const v = at(body, path.slice(prefix.length));
    if (v === undefined || v === null || v === '') continue;
    rows.push({ key: path, label, value: plainText(v) });
  }
  if (rows.length === 0) return null;
  const source = section.label ?? section.tool;
  return { key: section.tool, heading: `From ${source}${readAt ? ` — checked ${checkedAtText(readAt)}` : ''}`, rows };
}

/** The Now / New lines for `display.compare`, in declared order; args the call does not carry are left out. */
export function compareLines(
  toolArgs: Record<string, unknown>,
  hints: ToolDisplayHints | undefined,
  attachedBody: (topKey: string) => Record<string, unknown> | undefined,
): CompareLine[] {
  const out: CompareLine[] = [];
  for (const [arg, path] of Object.entries(hints?.compare ?? {})) {
    if (!(arg in toolArgs)) continue;
    const [top, ...rest] = path.split('.');
    const now = rest.length > 0 ? at(attachedBody(top), rest.join('.')) : undefined;
    out.push({ key: arg, label: hints?.labels?.[arg] ?? arg, now: plainText(now), next: plainText(toolArgs[arg]) });
  }
  return out;
}
