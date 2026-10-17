import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AgentProfile } from '@hap/core';
import { spClient, type DenialRecord } from '../lib/sp-client';
import { blockedView, kindOf, todaysCount, formatBlockedWhen, resolveMandateTitle } from '../lib/blocked-view';
import { EmptyState } from '../components/EmptyState';
import { ObjectLine } from '../components/ObjectLine';
import { AreaFilterPills, type AreaFilterOption } from '../components/AreaFilterPills';
import { systemDisplayName } from '../lib/approval-view';
import { useAreaCatalog } from '../lib/area-catalog';
import { resolveAreaName, areaIcon, parseAreaFilter, matchesAreaFilter } from '../lib/area';
import { shortProfileId } from '../lib/profile-identity';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';

/**
 * Every refusal of a gated tool call (AU2, work-plan.md "Added 2026-10-09") —
 * local Gatekeeper refusals, Authority Server ticket refusals, simulation
 * blocks, and "no matching mandate" — shown the way the read-denial log
 * always was: no content, just what was tried, which limit stopped it, and
 * what the owner can do (one generic sentence per refusal kind, decision 3).
 *
 * Each row uses the Mandates card shape (`.id-card` → `ProfileRail` +
 * `.id-body`), so a refusal is traced to the same profile identity (icon +
 * name) the owner already knows from Mandates — see temp/blocked-mockup.
 */
export function BlockedPage() {
  const [records, setRecords] = useState<DenialRecord[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, AgentProfile>>({});
  const [failed, setFailed] = useState(false);
  const catalog = useAreaCatalog();

  // UI spec §13.3 — area filter pills, next to the kind dot/legend; the URL
  // carries it so a link can land on one area directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const areaFilter = parseAreaFilter(searchParams.get('area'));
  const setAreaFilter = useCallback((shortId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (shortId === null) next.delete('area'); else next.set('area', shortId);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Mandate title, by authorization_id — the SAME list the Mandates page
  // already loads (getMyAttestations), not a new external lookup. Resolved
  // here at display time rather than stamped on the record, because the
  // MCP server has no local copy of titles to stamp with (see
  // blocked-view.ts's module doc) — and because a live lookup also covers
  // a mandate renamed since the block happened, or a block recorded before
  // this existed. An id missing from this map (unknown/revoked mandate)
  // falls back to the id alone, same as before.
  const [mandateTitlesById, setMandateTitlesById] = useState<Record<string, string>>({});
  const loadMandateTitles = useCallback(() => {
    spClient.getMyAttestations()
      .then(items => {
        const next: Record<string, string> = {};
        for (const item of items) {
          if (item.title) next[item.authorization_id] = item.title;
        }
        setMandateTitlesById(next);
      })
      .catch(() => {
        // A failed load just means ids show instead of titles — never blocks the page.
      });
  }, []);
  useEffect(() => { loadMandateTitles(); }, [loadMandateTitles]);
  // Same cadence as the Mandates page's own background refresh.
  useVisiblePolling(loadMandateTitles, 300_000);

  // The cutoff for "new", captured ONCE per visit, from the value on disk
  // BEFORE this visit marks it forward. Items newer than this OLD value
  // stay "New" for the rest of this visit even once seen is recorded —
  // marking seen must not retroactively hide what the owner is looking at
  // right now (mockup state C).
  const [seenCutoff, setSeenCutoff] = useState<number | null>(null);
  const capturedRef = useRef(false);

  const load = useCallback(() => {
    spClient.getDenials({ limit: 200 })
      .then(({ records }) => { setRecords(records); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, 60_000);

  // Resolve each distinct profile once, generically — only to label a field
  // by the profile's own displayName; never a lookup into another system.
  useEffect(() => {
    if (!records) return;
    const need = [...new Set(records.map(r => r.profile).filter((p): p is string => !!p))]
      .filter(p => !(p in profiles));
    if (need.length === 0) return;
    Promise.all(need.map(p => spClient.getProfile(p).catch(() => null)))
      .then(results => {
        setProfiles(prev => {
          const next = { ...prev };
          need.forEach((p, i) => { if (results[i]) next[p] = results[i]; });
          return next;
        });
      });
  }, [records, profiles]);

  // Mark seen once this visit has data — capture the previous cutoff first,
  // then persist "now" as the new one, then tell the sidebar to re-poll
  // immediately (same event convention as archive — no 5-minute wait).
  useEffect(() => {
    if (!records || capturedRef.current) return;
    capturedRef.current = true;
    spClient.getLastSeenBlockedAt()
      .then(previous => {
        setSeenCutoff(previous);
        return spClient.markBlockedSeen(Date.now());
      })
      .then(() => {
        window.dispatchEvent(new Event('suveren:blocked-seen-changed'));
      })
      .catch(() => {
        // Seen-tracking is a display nicety only — a failed read/write here
        // must never block the page from showing the actual blocks.
      });
  }, [records]);

  // A new block happened while this page is open (MCP server -> control
  // plane -> SSE 'denial-recorded', see cp-notify.ts). Refresh the list so
  // it appears without a reload. If the owner is actually looking at this
  // page right now, push the PERSISTED cutoff forward too — so this item
  // won't come back as unseen on a later visit — but leave the local
  // `seenCutoff` state alone, so it still renders "New" for the rest of
  // THIS visit (same rule as the initial capture above, applied live).
  const handleNewDenial = useCallback(() => {
    load();
    // The new block may be under a mandate created moments ago — refresh
    // the title lookup too instead of waiting on the 5-minute poll above.
    loadMandateTitles();
    if (seenCutoff === null) return; // the initial capture hasn't landed yet
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    spClient.markBlockedSeen(Date.now())
      .then(() => { window.dispatchEvent(new Event('suveren:blocked-seen-changed')); })
      .catch(() => {});
  }, [load, loadMandateTitles, seenCutoff]);
  useSSEEvent('denial-recorded', handleNewDenial);

  // One area pill per area present, newest-version name (UI spec §13.1),
  // ordered alphabetically — a stable, content-independent order, since
  // unlike Mandates (§13.3's "most active first") there's no "size" here
  // that wouldn't jump around as new blocks arrive.
  const areaOptions: AreaFilterOption[] = useMemo(() => {
    const m = new Map<string, AreaFilterOption>();
    for (const r of records ?? []) {
      const pid = r.profile ?? r.integrationId;
      const shortId = shortProfileId(pid);
      const entry = m.get(shortId);
      if (entry) entry.count += 1;
      else m.set(shortId, { shortId, icon: areaIcon(pid), name: resolveAreaName(pid, catalog), count: 1 });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [records, catalog]);

  if (failed) {
    return <EmptyState icon="⛔" title="Could not load blocked actions" text="Try again shortly." />;
  }
  if (records === null) return null;

  const today = todaysCount(records, Date.now());
  const filteredRecords = records.filter(r => matchesAreaFilter(r.profile ?? r.integrationId, areaFilter));

  return (
    <div className="blocked-page">
      <div className="page-header blocked-header">
        <h1 className="page-title">Blocked actions</h1>
        <span className="blocked-today">{today} today · nothing ran</span>
      </div>

      {records.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Nothing blocked"
          text="Every call your agent made stayed within its mandate."
        />
      ) : (
        <>
        {/* UI spec §13.3 — an area pill per area present, next to the
            existing per-record "what was tried" detail below. */}
        <AreaFilterPills areas={areaOptions} selected={areaFilter} onSelect={setAreaFilter} totalCount={records.length} />
        <div className="blocked-list">
          {filteredRecords.map((r, i) => {
            const view = blockedView(r, r.profile ? profiles[r.profile] : undefined, mandateTitlesById);
            const unseen = seenCutoff !== null && r.ts > seenCutoff;
            const pid = r.profile ?? r.integrationId;
            return (
              <div
                className="card blocked-item blocked-card"
                data-seen={unseen ? 'false' : 'true'}
                key={`${r.ts}-${i}`}
              >
                <div className="id-body">
                  {/* UI spec §12.2/§13.2 — the same top line as approvals,
                      mandates and tickets, instead of the profile rail. */}
                  <ObjectLine
                    profileId={pid}
                    area={resolveAreaName(pid, catalog)}
                    system={r.integrationId ? systemDisplayName(r.integrationId, undefined) : undefined}
                    time={formatBlockedWhen(r.ts, Date.now())}
                    trailing={unseen ? <span className="new-pill">New</span> : undefined}
                    mandateTitle={resolveMandateTitle(r, mandateTitlesById)}
                  />
                  <div className="blocked-row-head">
                    <span className={`blocked-dot blocked-dot-${kindOf(r)}`} aria-hidden="true" />
                    <span className="blocked-title">{view.title}</span>
                  </div>
                  <div className="blocked-sentence">{view.sentence}</div>
                  <div className="blocked-source">
                    {view.sourceLine.map((part, pi) =>
                      part.dim
                        ? <span className="mandate-id" key={pi}>{part.text}</span>
                        : <span key={pi}>{part.text}</span>
                    )}
                  </div>
                  <details>
                    <summary>What you can do</summary>
                    <div className="blocked-advice">{view.whatYouCanDo}</div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
