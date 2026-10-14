import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient, type DenialRecord } from '../lib/sp-client';
import { blockedView, kindOf, todaysCount, formatBlockedWhen } from '../lib/blocked-view';
import { EmptyState } from '../components/EmptyState';
import { ProfileRail } from '../components/ProfileRail';
import { useVisiblePolling } from '../hooks/useVisiblePolling';

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

  if (failed) {
    return <EmptyState icon="⛔" title="Could not load blocked actions" text="Try again shortly." />;
  }
  if (records === null) return null;

  const today = todaysCount(records, Date.now());

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
        <div className="blocked-list">
          {records.map((r, i) => {
            const view = blockedView(r, r.profile ? profiles[r.profile] : undefined);
            const unseen = seenCutoff !== null && r.ts > seenCutoff;
            return (
              <div
                className="card id-card blocked-item"
                data-seen={unseen ? 'false' : 'true'}
                key={`${r.ts}-${i}`}
              >
                <ProfileRail profileId={r.profile ?? r.integrationId} />
                <div className="id-body">
                  <div className="blocked-row-head">
                    <span className={`blocked-dot blocked-dot-${kindOf(r)}`} aria-hidden="true" />
                    <span className="blocked-title">{view.title}</span>
                    {unseen && <span className="new-pill">New</span>}
                    <span className="blocked-when">{formatBlockedWhen(r.ts, Date.now())}</span>
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
      )}
    </div>
  );
}
