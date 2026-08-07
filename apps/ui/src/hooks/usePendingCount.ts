import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { spClient } from '../lib/sp-client';
import { countPending } from '../lib/pending';

/**
 * How many things are waiting for this human to decide.
 *
 * One definition of "pending", shared by the dashboard and the tab badge:
 * domain proposals still in `pending`, plus the Phase-6 above-cap proposals
 * routed to me as an approver.
 *
 * The SSE events that drive the refresh carry no payload — by design, the
 * stream reports only that something changed. The count is then re-fetched over
 * the authenticated API, which is the only place it may come from.
 */
const REFRESH_EVENTS = [
  'proposal-added',
  'proposal-resolved',
  'proposal-approved',
  'proposal-rejected',
  'action-approval-needed',
  'action-resolved',
  // Team membership decides WHICH proposals are routed to me as approver, so a
  // change here changes the count even though no proposal moved.
  'team-membership-changed',
] as const;

const DEBOUNCE_MS = 500;

export function usePendingCount(): number {
  const { user, domain } = useAuth();
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNow = useCallback(async () => {
    if (!user) {
      setCount(0);
      return;
    }
    try {
      const [proposals, approver] = await Promise.all([
        spClient.getProposals(domain || 'owner').catch(() => []),
        spClient.getProposalsForApprover().catch(() => []),
      ]);
      setCount(countPending(proposals, approver));
    } catch {
      // Authenticated fetches fail when the vault locks or the session ends.
      // Clear rather than freeze: a stuck "(3)" that never resolves teaches the
      // reader to distrust the badge, which is worse than showing nothing.
      setCount(0);
    }
  }, [user, domain]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    // A burst of events (five proposals landing at once) should cost one fetch.
    timer.current = setTimeout(() => { void fetchNow(); }, DEBOUNCE_MS);
  }, [fetchNow]);

  useEffect(() => {
    void fetchNow();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [fetchNow]);

  // Hook count must stay constant across renders — REFRESH_EVENTS is a literal.
  useSSEEvent(REFRESH_EVENTS[0], refresh);
  useSSEEvent(REFRESH_EVENTS[1], refresh);
  useSSEEvent(REFRESH_EVENTS[2], refresh);
  useSSEEvent(REFRESH_EVENTS[3], refresh);
  useSSEEvent(REFRESH_EVENTS[4], refresh);
  useSSEEvent(REFRESH_EVENTS[5], refresh);
  useSSEEvent(REFRESH_EVENTS[6], refresh);

  return count;
}
