import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { spClient, type IntegrationManifest, type McpIntegrationStatus } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from './EventSourceContext';

export type IntegrationState =
  | 'loading'      // haven't fetched yet
  | 'starting'     // not-running, but within post-mount startup window
  | 'running'      // healthy
  | 'not-running'  // not-running past startup window (user stopped it, or never started)
  | 'error';       // has an error message from the subprocess

export interface IntegrationEntry {
  id: string;
  manifest: IntegrationManifest;
  integration?: McpIntegrationStatus;
  state: IntegrationState;
  /** OAuth liveness for oauth integrations: 'failed' = token expired/revoked,
   *  needs reconnect. Undefined for non-oauth or not-yet-probed. */
  authStatus?: 'ok' | 'failed' | 'not_connected' | 'not_configured' | 'unverified';
  authAccount?: string;
  authError?: string;
}

interface ContextValue {
  loading: boolean;
  mcpServerUp: boolean | null;
  /** True when the manifests fetch itself failed (vs. genuinely zero manifests). */
  manifestsError: boolean;
  entries: IntegrationEntry[];
  /** Count of entries that need user attention (not-running, error, OR a failed
   *  OAuth token that needs reconnect). `starting` is excluded. */
  attentionCount: number;
  /** Number of active MCP client sessions — exposed so Dashboard doesn't have to fetch /mcp/health separately. */
  activeSessions: number;
  refresh: () => Promise<void>;
}

const IntegrationStatusContext = createContext<ContextValue | null>(null);

// Integrations that start after login can take a few seconds — npm install,
// subprocess spawn, MCP handshake. Within this window we show "starting" so
// users aren't greeted with a red "not running" banner on every fresh boot.
const STARTUP_WINDOW_MS = 30_000;

/** Poll interval while something is still coming up, vs. the settled fallback. */
export const POLL_MS_STARTING = 5_000;
export const POLL_MS_SETTLED = 300_000;

/**
 * One integration's display state. Pure, so the precedence can be tested:
 * `running` must beat everything (a running integration is never "Starting"),
 * and a real `error` must beat the startup window rather than being hidden
 * behind a hopeful "Starting…" until it expires.
 */
export function deriveIntegrationState(
  integration: McpIntegrationStatus | undefined,
  fetchCount: number,
  withinStartupWindow: boolean,
): IntegrationState {
  if (fetchCount === 0) return 'loading';
  if (integration?.running) return 'running';
  if (integration?.error) return 'error';
  if (integration && withinStartupWindow) return 'starting';
  // Either registered-but-down past the window, or no entry at all (manifest
  // exists, nothing registered) — both are "not running" to the user.
  return 'not-running';
}

interface AuthHealth {
  status: 'ok' | 'failed' | 'not_connected' | 'not_configured' | 'unverified';
  account?: string;
  error?: string;
}

interface RawState {
  manifests: IntegrationManifest[];
  integrations: McpIntegrationStatus[];
  activeSessions: number;
  mcpServerUp: boolean | null;
  manifestsError: boolean;
  fetchCount: number;
  authHealth: Record<string, AuthHealth>;
}

export function IntegrationStatusProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<RawState>({
    manifests: [],
    integrations: [],
    activeSessions: 0,
    mcpServerUp: null,
    manifestsError: false,
    fetchCount: 0,
    authHealth: {},
  });
  // The first time we observed any not-running entry; used to decide
  // when to stop calling things "starting" and admit they're stuck.
  const firstSeenStartingAt = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    let manifestsError = false;
    const [manifestsData, healthData] = await Promise.all([
      spClient.getIntegrationManifests().catch(() => { manifestsError = true; return { manifests: [] }; }),
      spClient.getMcpHealth().catch(() => null),
    ]);
    setRaw(prev => ({
      ...prev,
      manifests: manifestsData.manifests,
      integrations: healthData?.integrations ?? prev.integrations,
      activeSessions: healthData?.activeSessions ?? prev.activeSessions,
      mcpServerUp: healthData ? true : false,
      manifestsError,
      fetchCount: prev.fetchCount + 1,
    }));

    // OAuth liveness is an EXTERNAL probe (e.g. LinkedIn /v2/me) — layer it in
    // after the fast local snapshot so its latency never delays process status.
    // Best-effort: a probe failure just leaves the prior authHealth in place.
    const oauthManifests = manifestsData.manifests.filter(m => m.oauth);
    if (oauthManifests.length > 0) {
      const results = await Promise.all(
        oauthManifests.map(async m => [m.id, await spClient.getOAuthHealth(m.id)] as const),
      );
      setRaw(prev => ({ ...prev, authHealth: Object.fromEntries(results) }));
    }
  }, []);

  // Is anything not yet up? Computed here rather than inside the entries memo
  // because it drives the poll rate, which must be decided before polling.
  const anyNotRunning = raw.fetchCount > 0 && raw.manifests.some(m => {
    const i = raw.integrations.find(x => x.id === m.id);
    return i && !i.running;
  });

  // SSE-driven refresh: fire immediately when the server emits integration-changed.
  useSSEEvent('integration-changed', refresh);
  // Poll fast while anything is still coming up, slowly once everything is
  // healthy. Two reasons, both observed live:
  //   • an SSE 'integration-changed' event missed during a gateway restart left
  //     the page showing "Starting…" for a healthy gateway until the 5-minute
  //     fallback fired — a working system looked broken;
  //   • the startup window below is evaluated during render, so without a
  //     refresh to re-render, `Date.now()` never advances and the window can
  //     never expire. Polling is what lets the state settle at all.
  // Cost is a local gateway call, not an SP/Redis read, and it stops as soon as
  // everything reports running.
  useVisiblePolling(refresh, anyNotRunning ? POLL_MS_STARTING : POLL_MS_SETTLED);

  const entries: IntegrationEntry[] = useMemo(() => {
    const byId = new Map(raw.integrations.map(i => [i.id, i]));
    const now = Date.now();

    // Track when we first saw any integration in a not-running state.
    // We reset this if no integrations are non-running (everything healthy).
    if (anyNotRunning && firstSeenStartingAt.current === null) {
      firstSeenStartingAt.current = now;
    } else if (!anyNotRunning) {
      firstSeenStartingAt.current = null;
    }

    const withinStartupWindow =
      firstSeenStartingAt.current !== null &&
      now - firstSeenStartingAt.current < STARTUP_WINDOW_MS;

    return raw.manifests.map(manifest => {
      const integration = byId.get(manifest.id);

      const state = deriveIntegrationState(integration, raw.fetchCount, withinStartupWindow);

      const ah = raw.authHealth[manifest.id];
      return {
        id: manifest.id, manifest, integration, state,
        authStatus: ah?.status, authAccount: ah?.account, authError: ah?.error,
      };
    });
  }, [raw, anyNotRunning]);

  const attentionCount = useMemo(
    () => entries.filter(
      e => e.state === 'not-running' || e.state === 'error' || e.authStatus === 'failed',
    ).length,
    [entries],
  );

  const value: ContextValue = {
    loading: raw.fetchCount === 0,
    mcpServerUp: raw.mcpServerUp,
    manifestsError: raw.manifestsError,
    entries,
    attentionCount,
    activeSessions: raw.activeSessions,
    refresh,
  };

  return <IntegrationStatusContext.Provider value={value}>{children}</IntegrationStatusContext.Provider>;
}

export function useIntegrationStatus(): ContextValue {
  const ctx = useContext(IntegrationStatusContext);
  if (!ctx) throw new Error('useIntegrationStatus must be used inside IntegrationStatusProvider');
  return ctx;
}
