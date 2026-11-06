import { useState, useCallback } from 'react';
import { IntegrationCard } from '../components/IntegrationCard';
import { useIntegrationStatus, type IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { groupIntegrationsForDisplay, connectorAreas, sortConnectors, splitByUse } from '../lib/integration-grouping';
import { integrationIcon } from '../lib/integration-icon';
import { useAreaCatalog } from '../lib/area-catalog';

/**
 * One card per connector (UI spec §13.3 revised): the connector's areas, taken from its manifest, are
 * chips under its name — a connector serving several areas is still ONE card with one form and one status.
 */
export function ConnectorCards({ entries, catalog, refresh, onSuccess }: {
  entries: IntegrationEntry[];
  catalog: ReturnType<typeof useAreaCatalog>;
  refresh: () => void;
  onSuccess: (msg: string) => void;
}) {
  return (
    <>
      {sortConnectors(entries).map(entry => (
        <IntegrationCard
          key={entry.id}
          manifest={entry.manifest}
          areas={connectorAreas(entry.manifest, catalog)}
          integration={entry.integration}
          state={entry.state}
          onStatusChange={refresh}
          onSuccess={onSuccess}
        />
      ))}
    </>
  );
}

/** A group heading with its count: "In use  4 connectors". */
function GroupHeading({ title, count, note }: { title: string; count: number; note?: string }) {
  return (
    <div className="su-sec">
      {title}
      <small>{count} {count === 1 ? 'connector' : 'connectors'}{note ? ` · ${note}` : ''}</small>
    </div>
  );
}

/** One compact row in the "Paused while simulation mode is on" disclosure —
 *  no actions, since there is nothing to do here: the connector will start
 *  again on its own once simulation mode is switched off. */
function PausedRow({ entry }: { entry: IntegrationEntry }) {
  return (
    <div className="int-paused-row">
      <span aria-hidden="true">{integrationIcon(entry.manifest.icon)}</span>
      <span className="int-paused-name">{entry.manifest.name}</span>
      <span className="int-paused-state">Paused</span>
    </div>
  );
}

export function IntegrationsPage() {
  const { loading, mcpServerUp, manifestsError, entries, refresh } = useIntegrationStatus();
  const simulationOn = useSimulationMode();
  const [successMsg, setSuccessMsg] = useState('');
  const catalog = useAreaCatalog();

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 5000);
  }, []);

  const grouped = groupIntegrationsForDisplay(entries, simulationOn);
  // Simulation mode off: "In use" / "Not set up". One card per connector, so the counts are the connectors.
  const { inUse, notSetUp, paused } = splitByUse(entries);
  const inUseCards = inUse.length;
  const notSetUpCards = notSetUp.length;
  const subtitle = !loading && mcpServerUp !== false && entries.length > 0 && !grouped.grouped
    ? ` ${inUseCards} in use · ${notSetUpCards} not set up.`
    : '';

  return (
    <div className="su-page">
      <div className="page-header">
        <h1 className="page-title">Connectors</h1>
        <p className="page-subtitle">The systems your AI can reach, each under its mandate.{subtitle}</p>
      </div>

      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading connectors...</p>
      ) : mcpServerUp === false ? (
        <div className="status-banner status-banner-error">
          <span className="status-banner-icon">!</span>
          <span className="status-banner-text">
            The gateway can't reach its connectors. Restart the gateway.
          </span>
        </div>
      ) : grouped.grouped ? (
        <>
          {/* Simulation mode on: Test systems (answer from simulated data) and Real systems (paused). */}
          {grouped.testSystems.length > 0 && (
            <>
              <GroupHeading title="Test systems" count={grouped.testSystems.length} />
              <ConnectorCards entries={grouped.testSystems} catalog={catalog} refresh={refresh} onSuccess={showSuccess} />
            </>
          )}

          {(grouped.realErrors.length > 0 || grouped.pausedReal.length > 0) && (
            <>
              <GroupHeading title="Real systems" count={grouped.realErrors.length + grouped.pausedReal.length} />
              {/* A genuine error (unrelated to the simulation block) stays a
                  full card — folding it into the paused disclosure would
                  bury an actual problem behind a collapsed, neutral summary. */}
              <ConnectorCards entries={grouped.realErrors} catalog={catalog} refresh={refresh} onSuccess={showSuccess} />
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
          {inUse.length > 0 && (
            <>
              <GroupHeading title="In use" count={inUseCards} />
              <ConnectorCards entries={inUse} catalog={catalog} refresh={refresh} onSuccess={showSuccess} />
            </>
          )}
          {paused.length > 0 && (
            <>
              <GroupHeading title="Paused" count={paused.length} />
              <ConnectorCards entries={paused} catalog={catalog} refresh={refresh} onSuccess={showSuccess} />
            </>
          )}

          {notSetUp.length > 0 && (
            <>
              <GroupHeading title="Not set up" count={notSetUpCards} note="open one to set it up" />
              <ConnectorCards entries={notSetUp} catalog={catalog} refresh={refresh} onSuccess={showSuccess} />
            </>
          )}

          {entries.length === 0 && <EmptyState manifestsError={manifestsError} />}
        </>
      )}
    </div>
  );
}

function EmptyState({ manifestsError }: { manifestsError: boolean }) {
  return manifestsError ? (
    <div className="status-banner status-banner-error">
      <span className="status-banner-icon">!</span>
      <span className="status-banner-text">
        Couldn't load connectors — the gateway can't reach its connectors
        (or you're signed out). Check the control-plane's
        {' '}<code>SUVEREN_MCP_INTERNAL_URL</code> (dev: :3431), then refresh.
      </span>
    </div>
  ) : (
    <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', marginTop: '2rem' }}>
      No connectors available yet.
    </p>
  );
}
