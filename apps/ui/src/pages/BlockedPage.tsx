import { useState, useCallback, useEffect } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient, type DenialRecord } from '../lib/sp-client';
import { blockedView, kindOf, todaysCount } from '../lib/blocked-view';
import { EmptyState } from '../components/EmptyState';
import { useVisiblePolling } from '../hooks/useVisiblePolling';

/**
 * Every refusal of a gated tool call (AU2, work-plan.md "Added 2026-10-09") —
 * local Gatekeeper refusals, Authority Server ticket refusals, simulation
 * blocks, and "no matching mandate" — shown the way the read-denial log
 * always was: no content, just what was tried, which limit stopped it, and
 * what the owner can do (one generic sentence per refusal kind, decision 3).
 */
export function BlockedPage() {
  const [records, setRecords] = useState<DenialRecord[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, AgentProfile>>({});
  const [failed, setFailed] = useState(false);

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
            return (
              <div className="blocked-row" key={`${r.ts}-${i}`} data-kind={kindOf(r)}>
                <span className={`blocked-dot blocked-dot-${kindOf(r)}`} aria-hidden="true" />
                <div className="blocked-row-main">
                  <div className="blocked-title">{view.title}</div>
                  <div className="blocked-sentence">{view.sentence}</div>
                  <div className="blocked-source">{view.sourceLine}</div>
                  <details>
                    <summary>What you can do</summary>
                    <div className="blocked-advice">{view.whatYouCanDo}</div>
                  </details>
                </div>
                <div className="blocked-when">
                  {new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
