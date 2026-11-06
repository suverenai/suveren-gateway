/**
 * ApprovalQueueContext — the approvals waiting for THIS person, read once for
 * the whole app: the Approvals page and the approval panel that opens by itself
 * share it, so the two can never disagree.
 *
 * New approvals are learned the way the UI already learns about them: the SSE
 * events that move the nav badge (usePendingCount), re-reading over the
 * authenticated API, plus the 30-second visible-tab poll the Approvals page
 * always had. The events carry no payload; the lists come from the gateway.
 *
 * Also holds the gateway setting "Open approvals by themselves". It is stored
 * in the control plane (GET/PUT /api/gateway-settings), never in the browser,
 * and every write is shown as the gateway answered it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useSSEEvent } from './EventSourceContext';
import { spClient, type Proposal, type IntegrationManifest } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { APPROVALS_CHANGED_EVENT } from '../lib/approval-flow';
import { buildMyQueue, pruneDecided, type QueueEntry } from '../lib/approval-queue';
import { loadAutoOpen, saveAutoOpen } from '../lib/approval-panel';
import type { ToolDisplay } from '../lib/approval-view';

interface ApprovalQueue {
  entries: QueueEntry[];
  ids: string[];
  /** Both lists have answered at least once. */
  loaded: boolean;
  userId: string;
  manifests: IntegrationManifest[];
  toolDisplay: Record<string, ToolDisplay>;
  /** Mandate titles by authorization id (for the card's "Covered by"). */
  titles: Record<string, string>;
  /** The gateway answered a decision for this id: it leaves the queue at once. */
  markDecided: (id: string) => void;
  /** Re-read the lists from the gateway. */
  refresh: () => Promise<void>;
  /** The gateway setting. null = not read (yet, or unreadable). */
  autoOpen: boolean | null;
  /** The setting has been asked for at least once (answered or failed) — until then nothing may open by itself. */
  settingRead: boolean;
  autoOpenError: string | null;
  /** Writes the setting; resolves once the gateway has answered. */
  setAutoOpen: (value: boolean) => Promise<void>;
}

const Ctx = createContext<ApprovalQueue | null>(null);

const REFRESH_EVENTS = ['proposal-added', 'proposal-approved', 'proposal-rejected', 'proposal-resolved', 'action-approval-needed', 'action-resolved', 'team-membership-changed'] as const;

export function ApprovalQueueProvider({ children }: { children: ReactNode }) {
  const { user, domain } = useAuth();
  const userId = user?.id ?? '';

  const [approverProposals, setApproverProposals] = useState<Proposal[]>([]);
  const [myProposals, setMyProposals] = useState<Proposal[]>([]);
  const [approverLoaded, setApproverLoaded] = useState(false);
  const [myLoaded, setMyLoaded] = useState(false);
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [toolDisplay, setToolDisplay] = useState<Record<string, ToolDisplay>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [autoOpen, setAutoOpenState] = useState<boolean | null>(null);
  const [settingRead, setSettingRead] = useState(false);
  const [autoOpenError, setAutoOpenError] = useState<string | null>(null);

  const fetchApprover = useCallback(async () => {
    try { setApproverProposals(await spClient.getProposalsForApprover()); } catch { /* keep previous on a background refresh */ } finally { setApproverLoaded(true); }
  }, []);
  const fetchMine = useCallback(async () => {
    try { setMyProposals(await spClient.getMyProposals(domain)); } catch { /* keep previous */ } finally { setMyLoaded(true); }
  }, [domain]);
  const refresh = useCallback(async () => { await Promise.all([fetchApprover(), fetchMine()]); }, [fetchApprover, fetchMine]);

  // Same events as the nav badge (usePendingCount). Hook count stays constant: REFRESH_EVENTS is a literal.
  useSSEEvent(REFRESH_EVENTS[0], refresh);
  useSSEEvent(REFRESH_EVENTS[1], refresh);
  useSSEEvent(REFRESH_EVENTS[2], refresh);
  useSSEEvent(REFRESH_EVENTS[3], refresh);
  useSSEEvent(REFRESH_EVENTS[4], refresh);
  useSSEEvent(REFRESH_EVENTS[5], refresh);
  useSSEEvent(REFRESH_EVENTS[6], refresh);
  useVisiblePolling(fetchApprover, 30_000);
  useVisiblePolling(fetchMine, 30_000, domain);

  // A decision the gateway answered somewhere else in the UI: re-read.
  useEffect(() => {
    const on = () => { void refresh(); };
    window.addEventListener(APPROVALS_CHANGED_EVENT, on);
    return () => window.removeEventListener(APPROVALS_CHANGED_EVENT, on);
  }, [refresh]);

  // What the cards need besides the proposal itself. Enhancements: never block deciding on them.
  useEffect(() => {
    spClient.getLabelManifests().then(setManifests).catch(() => {});
    spClient.getToolDisplay().then(setToolDisplay).catch(() => {});
    spClient.getMyAttestations()
      .then((items) => {
        const t: Record<string, string> = {};
        for (const i of items) if (i.authorization_id && i.title) t[i.authorization_id] = i.title;
        setTitles(t);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { setDecided((prev) => (prev.size === 0 ? prev : pruneDecided(prev, myProposals, approverProposals))); }, [myProposals, approverProposals]);

  const entries = useMemo(() => buildMyQueue(myProposals, approverProposals, decided, userId), [myProposals, approverProposals, decided, userId]);
  const ids = useMemo(() => entries.map((e) => e.id), [entries]);

  const markDecided = useCallback((id: string) => setDecided((prev) => new Set(prev).add(id)), []);

  // The setting: read on mount and when the tab is visible again; written through the gateway.
  const readSetting = useCallback(async () => {
    const v = await loadAutoOpen(spClient);
    setAutoOpenState(v);
    setAutoOpenError(v === null ? 'Could not read the setting from the gateway' : null);
    setSettingRead(true);
  }, []);
  useVisiblePolling(readSetting, 60_000);

  const writing = useRef(false);
  const setAutoOpen = useCallback(async (value: boolean) => {
    if (writing.current) return;
    writing.current = true;
    try {
      const saved = await saveAutoOpen(spClient, value); // what the gateway kept
      setAutoOpenState(saved);
      setAutoOpenError(null);
    } catch (err) {
      setAutoOpenError(err instanceof Error ? err.message : 'Failed to save');
      await readSetting(); // show the truth, not the attempt
    } finally {
      writing.current = false;
    }
  }, [readSetting]);

  const value = useMemo<ApprovalQueue>(() => ({
    entries, ids, loaded: approverLoaded && myLoaded, userId, manifests, toolDisplay, titles,
    markDecided, refresh, autoOpen, settingRead, autoOpenError, setAutoOpen,
  }), [entries, ids, approverLoaded, myLoaded, userId, manifests, toolDisplay, titles, markDecided, refresh, autoOpen, settingRead, autoOpenError, setAutoOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApprovalQueue(): ApprovalQueue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApprovalQueue must be used inside ApprovalQueueProvider');
  return v;
}
