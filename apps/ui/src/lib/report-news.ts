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
