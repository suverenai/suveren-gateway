import { useState, useCallback } from 'react';
import { IntegrationCard } from '../components/IntegrationCard';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';

export function IntegrationsPage() {
  const { loading, mcpServerUp, manifestsError, entries, refresh } = useIntegrationStatus();
  const [successMsg, setSuccessMsg] = useState('');

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 5000);
  }, []);

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

          {entries.length === 0 && (
            manifestsError ? (
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
            )
          )}
        </>
      )}
    </>
  );
}
