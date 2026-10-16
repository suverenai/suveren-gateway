/**
 * "Is there a new report?" — reports mockup (2026-10-16): there is only ever
 * one report (each write replaces it), so it is NEW or not — never a count.
 * New = saved after the person last opened the Reports page.
 */
import type { ReportModel } from './sp-client';

export function isNewReport(report: Pick<ReportModel, 'savedAt'> | null | undefined, lastSeenMs: number): boolean {
  return !!report && report.savedAt * 1000 > lastSeenMs;
}

/** The report's own first heading, else "Report". Plain text only. */
export function reportTitle(renderedHtml: string): string {
  const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(renderedHtml);
  const text = m ? m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
  return text ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : 'Report';
}

/** What the gateway verified, and what it could not check. */
export function reportCheckCounts(report: Pick<ReportModel, 'proof' | 'elements'>): { verified: number; unchecked: number } {
  return {
    verified: report.proof?.verifiedValues?.length ?? 0,
    unchecked: (report.elements ?? []).filter((e) => e.status === 'unverifiable').length,
  };
}

const fmtDT = (sec: number, locale?: string) =>
  new Date(sec * 1000).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtExact = (sec: number, locale?: string) =>
  new Date(sec * 1000).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * The exact period a report covers, date-time to date-time, as the gateway
 * scoped its evidence (coverage.window). `title` carries the seconds and the
 * 2-minute tolerance for a hover. Reports stored before the window was
 * recorded say so — never a made-up period.
 */
export function reportPeriod(
  coverage: { window?: { start: number; end: number; days: number } } | undefined,
  locale?: string,
): { text: string; title?: string } {
  const w = coverage?.window;
  if (!w) return { text: 'Period not recorded' };
  return {
    text: `Covers ${fmtDT(w.start, locale)} → ${fmtDT(w.end, locale)} (${w.days} day${w.days === 1 ? '' : 's'})`,
    title: `From ${fmtExact(w.start, locale)} to ${fmtExact(w.end, locale)}. Tickets up to 2 minutes after the end count, for small clock differences.`,
  };
}

/** "today 09:12" / "16 Oct, 09:12 (9 days ago)" — the age shows once it is old. */
export function writtenLabel(savedAtSec: number, nowMs: number, locale?: string): string {
  const d = new Date(savedAtSec * 1000);
  const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((nowMs - savedAtSec * 1000) / 86_400_000);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  if (sameDay) return `today ${hm}`;
  const date = `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}, ${hm}`;
  return days >= 2 ? `${date} (${days} days ago)` : date;
}
