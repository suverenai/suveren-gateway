/**
 * The dashboard's report line (reports mockup, signed off 2026-10-16): shown
 * only while the one report is NEW — saved after the Reports page was last
 * opened. When it was written, what the gateway verified, and — in bold —
 * anything it could not check. Nothing when there is no new report.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { spClient, type ReportModel } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { isNewReport, reportTitle, reportCheckCounts } from '../lib/report-news';
import { ticketTime } from '../lib/core-objects';

export function ReportLine() {
  const [report, setReport] = useState<ReportModel | null>(null);
  const [lastSeen, setLastSeen] = useState<number>(Number.POSITIVE_INFINITY);

  const load = useCallback(() => {
    Promise.all([
      spClient.getReport().then((r) => r.report).catch(() => null),
      spClient.getLastSeenReportAt().catch(() => Number.POSITIVE_INFINITY),
    ]).then(([r, seen]) => { setReport(r); setLastSeen(seen); });
  }, []);
  useVisiblePolling(load, 300_000);
  useSSEEvent('report-written', load);

  if (!report || !isNewReport(report, lastSeen)) return null;
  const { verified, unchecked } = reportCheckCounts(report);
  return (
    <div className="report-line" data-testid="report-line">
      <span className="nav-new" style={{ marginLeft: 0 }}>New</span>
      <span className="report-line-text">
        <b>{reportTitle(report.renderedHtml)}</b> — written {ticketTime(report.savedAt, Date.now())}
        {unchecked === 0
          ? <> · all {verified} value{verified === 1 ? '' : 's'} verified</>
          : <> · {verified} value{verified === 1 ? '' : 's'} verified · <b>✕ {unchecked} could not be checked</b></>}
      </span>
      <Link to="/reports" className="col-btn">Open report ›</Link>
    </div>
  );
}
