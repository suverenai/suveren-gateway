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
}

interface ContextValue {
  loading: boolean;
  mcpServerUp: boolean | null;
  /** True when the manifests fetch itself failed (vs. genuinely zero manifests). */
  manifestsError: boolean;
  entries: IntegrationEntry[];
  /** Count of entries that need user attention (not-running OR error). `starting` is excluded. */
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

interface RawState {
  manifests: IntegrationManifest[];
  integrations: McpIntegrationStatus[];
  activeSessions: number;
  mcpServerUp: boolean | null;
  manifestsError: boolean;
  fetchCount: number;
}

export function IntegrationStatusProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<RawState>({
    manifests: [],
    integrations: [],
    activeSessions: 0,
    mcpServerUp: null,
    manifestsError: false,
    fetchCount: 0,
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
      manifests: manifestsData.manifests,
      integrations: healthData?.integrations ?? prev.integrations,
      activeSessions: healthData?.activeSessions ?? prev.activeSessions,
      mcpServerUp: healthData ? true : false,
      manifestsError,
      fetchCount: prev.fetchCount + 1,
    }));
  }, []);

  // SSE-driven refresh: fire immediately when the server emits integration-changed.
  useSSEEvent('integration-changed', refresh);
  // Fallback full-sync every 5min — catches any events missed during reconnect races.
  useVisiblePolling(refresh, 300_000);

  const entries: IntegrationEntry[] = useMemo(() => {
    const byId = new Map(raw.integrations.map(i => [i.id, i]));
    const now = Date.now();

    // Track when we first saw any integration in a not-running state.
    // We reset this if no integrations are non-running (everything healthy).
    const anyNotRunning = raw.fetchCount > 0 && raw.manifests.some(m => {
      const i = byId.get(m.id);
      return i && !i.running;
    });
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

      let state: IntegrationState;
      if (raw.fetchCount === 0) {
        state = 'loading';
      } else if (integration?.running) {
        state = 'running';
      } else if (integration?.error) {
        state = 'error';
      } else if (integration && withinStartupWindow) {
        state = 'starting';
      } else if (integration) {
        state = 'not-running';
      } else {
        // No integration entry at all — manifest exists but nothing registered.
        state = 'not-running';
      }

      return { id: manifest.id, manifest, integration, state };
    });
  }, [raw]);

  const attentionCount = useMemo(
    () => entries.filter(e => e.state === 'not-running' || e.state === 'error').length,
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
