import { useState, useCallback } from 'react';
import { IntegrationCard } from '../components/IntegrationCard';
import { useIntegrationStatus, type IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { groupIntegrationsForDisplay } from '../lib/integration-grouping';
import { integrationIcon } from '../lib/integration-icon';

/** One compact row in the "Paused while simulation mode is on" disclosure —
 *  no actions, since there is nothing to do here: the connector will start
 *  again on its own once simulation mode is switched off. */
function PausedRow({ entry }: { entry: IntegrationEntry }) {
  return (
    <div className="int-paused-row">
      <span aria-hidden="true">{integrationIcon(entry.manifest.icon)}</span>
      <span className="int-paused-name">{entry.manifest.name}</span>
      <span className="int-chip int-chip-paused"><span className="int-dot" />Paused</span>
    </div>
  );
}

export function IntegrationsPage() {
  const { loading, mcpServerUp, manifestsError, entries, refresh } = useIntegrationStatus();
  const simulationOn = useSimulationMode();
  const [successMsg, setSuccessMsg] = useState('');

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 5000);
  }, []);

  const grouped = groupIntegrationsForDisplay(entries, simulationOn);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Integrations</h1>
        <p className="page-subtitle">Connect external services and manage MCP integrations.</p>
      </div>

      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading integrations...</p>
      ) : mcpServerUp === false ? (
        <div className="status-banner status-banner-error">
          <span className="status-banner-icon">!</span>
          <span className="status-banner-text">
            MCP server is not reachable. Make sure it is running.
          </span>
        </div>
      ) : grouped.grouped ? (
        <>
          {grouped.testSystems.length > 0 && (
            <>
              <div className="int-group-label">Test systems</div>
              {grouped.testSystems.map(entry => (
                <IntegrationCard
                  key={entry.id}
                  manifest={entry.manifest}
                  integration={entry.integration}
                  state={entry.state}
                  onStatusChange={refresh}
                  onSuccess={showSuccess}
                />
              ))}
            </>
          )}

          {(grouped.realErrors.length > 0 || grouped.pausedReal.length > 0) && (
            <>
              <div className="int-group-label">Real systems</div>
              {/* A genuine error (unrelated to the simulation block) stays a
                  full card — folding it into the paused disclosure would
                  bury an actual problem behind a collapsed, neutral summary. */}
              {grouped.realErrors.map(entry => (
                <IntegrationCard
                  key={entry.id}
                  manifest={entry.manifest}
                  integration={entry.integration}
                  state={entry.state}
                  onStatusChange={refresh}
                  onSuccess={showSuccess}
                />
              ))}
              {grouped.pausedReal.length > 0 && (
                <details className="int-paused-group" open>
                  <summary>Paused while simulation mode is on ({grouped.pausedReal.length})</summary>
                  <p className="int-paused-group-note">
                    Nothing is lost — mandates, credentials and data stay. They start again when
                    simulation mode is switched off (<code>suveren-gateway simulation off</code>).
                  </p>
                  {grouped.pausedReal.map(entry => <PausedRow key={entry.id} entry={entry} />)}
                </details>
              )}
            </>
          )}

          {entries.length === 0 && <EmptyState manifestsError={manifestsError} />}
        </>
      ) : (
        <>
          {entries.map(entry => (
            <IntegrationCard
              key={entry.id}
              manifest={entry.manifest}
              integration={entry.integration}
              state={entry.state}
              onStatusChange={refresh}
              onSuccess={showSuccess}
            />
          ))}

          {entries.length === 0 && <EmptyState manifestsError={manifestsError} />}
        </>
      )}
    </>
  );
}

function EmptyState({ manifestsError }: { manifestsError: boolean }) {
  return manifestsError ? (
    <div className="status-banner status-banner-error">
      <span className="status-banner-icon">!</span>
      <span className="status-banner-text">
        Couldn't load integrations — the gateway can't reach its MCP server
        (or you're signed out). Check the control-plane's
        {' '}<code>SUVEREN_MCP_INTERNAL_URL</code> (dev MCP is :3431), then refresh.
      </span>
    </div>
  ) : (
    <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', marginTop: '2rem' }}>
      No integrations available yet.
    </p>
  );
}
