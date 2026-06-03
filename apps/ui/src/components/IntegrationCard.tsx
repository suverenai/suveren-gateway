import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { spClient, type IntegrationManifest, type McpIntegrationStatus } from '../lib/sp-client';
import type { IntegrationState } from '../contexts/IntegrationStatusContext';

const ICON_MAP: Record<string, string> = {
  card: '\u{1F4B3}',
  mail: '\u2709\uFE0F',
};

interface Props {
  manifest: IntegrationManifest;
  integration: McpIntegrationStatus | undefined;
  /**
   * Canonical state derived by IntegrationStatusContext. Drives the status
   * chip so Sidebar/Dashboard/IntegrationsPage agree by construction.
   */
  state: IntegrationState;
  onStatusChange: () => void;
  onSuccess: (msg: string) => void;
}

type CardState = 'unconfigured' | 'needs-oauth' | 'ready' | 'running' | 'starting';

export function IntegrationCard({ manifest, integration, state, onStatusChange, onSuccess }: Props) {
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [credConfigured, setCredConfigured] = useState(false);
  const [credsOnFile, setCredsOnFile] = useState(false); // vault has credentials stored
  const [existingCreds, setExistingCreds] = useState<Record<string, string>>({}); // current manifest-field values, for the edit panel
  const [oauthConnected, setOauthConnected] = useState(false);
  const [authHealth, setAuthHealth] = useState<{ status: string; error?: string; account?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [activating, setActivating] = useState(false);
  // Explicit "change credentials" mode — independent of cardState, which is
  // dominated by integration.running (so the cred form would never show while
  // an integration is running/auth-failed).
  const [editingCreds, setEditingCreds] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    // Check if credentials exist
    spClient.getCredential(manifest.id).then(status => {
      if (cancelled || !status.configured) return;
      setCredConfigured(true);
      setCredsOnFile(true);
      // Capture current values for the manifest's own fields (clientId/secret)
      // so "Change credentials" can pre-fill them. Token/internal keys excluded.
      if (status.fields) {
        const current: Record<string, string> = {};
        for (const f of manifest.credentials.fields) {
          if (status.fields[f.key] != null) current[f.key] = status.fields[f.key];
        }
        setExistingCreds(current);
      }
      // Check if OAuth token exists, then probe whether it actually authenticates.
      if (manifest.oauth) {
        const connected = status.fieldNames?.includes(manifest.oauth.tokenStorage) ?? false;
        setOauthConnected(connected);
        if (connected) {
          spClient.getOAuthHealth(manifest.id).then(h => { if (!cancelled) setAuthHealth(h); });
        }
      }
    }).catch(() => {/* ignore */});
    return () => { cancelled = true; };
  }, [manifest.id, manifest.oauth]);

  // Does this integration require auth at all? OAuth or any non-optional field.
  // CRM/Records have only optional fields → no auth needed, run out of the box.
  const needsAuth = !!manifest.oauth || manifest.credentials.fields.some(f => !f.optional);
  const authConnected = manifest.oauth ? oauthConnected : credConfigured;
  // Auth is "satisfied" if none is needed, or the needed auth is present.
  const authSatisfied = !needsAuth || authConnected;

  const cardState: CardState = (() => {
    // Surface the context's starting state so users see a clear "Starting…"
    // affordance rather than the old "Not running" flicker during post-login
    // subprocess spawn.
    if (state === 'starting') return 'starting';
    // Required auth wins over the subprocess: a running process that still
    // needs credentials / an OAuth token can't do anything, so show the setup
    // it needs instead of a misleading green "Running".
    if (!authSatisfied) {
      return manifest.oauth && credConfigured && !oauthConnected ? 'needs-oauth' : 'unconfigured';
    }
    if (integration?.running) return 'running';
    // Not running, auth fine — but if there's config to (optionally) enter and
    // nothing saved yet, show the config form + Activate (e.g. CRM's DB URL).
    if (!credConfigured && manifest.credentials.fields.length > 0) return 'unconfigured';
    return 'ready';
  })();

  const saveCredentials = async () => {
    const hasValues = manifest.credentials.fields.some(f => credValues[f.key]?.trim());
    if (!hasValues) return;
    setSaving(true);
    try {
      await spClient.setCredential(manifest.id, credValues);
      setCredConfigured(true);
      setCredValues({});
      // Auto-start: if this integration doesn't need OAuth, activating now
      // skips the dead state where credentials are saved but nothing runs.
      if (!manifest.oauth) {
        onSuccess(`${manifest.name} credentials saved — starting integration...`);
        await activate();
      } else {
        onSuccess(`${manifest.name} credentials saved!`);
      }
    } catch {
      onSuccess(`Failed to save ${manifest.name} credentials`);
    } finally {
      setSaving(false);
    }
  };

  // Save new credentials from the "Change credentials" edit panel (running
  // integration). For OAuth we stay in edit mode so the user can Connect with
  // the new client; for non-OAuth we restart with the new creds and exit.
  const saveCredsEdit = async () => {
    const hasValues = manifest.credentials.fields.some(f => credValues[f.key]?.trim());
    if (!hasValues) return;
    setSaving(true);
    try {
      await spClient.setCredential(manifest.id, credValues);
      setCredValues({});
      setCredConfigured(true);
      if (manifest.oauth) {
        onSuccess(`${manifest.name} credentials saved — now click Connect.`);
      } else {
        setEditingCreds(false);
        onSuccess(`${manifest.name} credentials updated — restarting...`);
        await activate();
      }
    } catch {
      onSuccess(`Failed to update ${manifest.name} credentials`);
    } finally {
      setSaving(false);
    }
  };

  const startOAuth = () => {
    window.open(`/auth/oauth/${manifest.id}/start`, '_blank', 'width=600,height=700');
    const poll = setInterval(async () => {
      try {
        const cred = await spClient.getCredential(manifest.id);
        if (cred.configured && manifest.oauth && cred.fieldNames?.includes(manifest.oauth.tokenStorage)) {
          setOauthConnected(true);
          setEditingCreds(false);
          setAuthHealth(null);
          clearInterval(poll);
          onSuccess(`${manifest.name} connected — starting integration...`);
          // Re-probe auth health so the chip flips from "failed" to OK/account.
          spClient.getOAuthHealth(manifest.id).then(setAuthHealth).catch(() => {});
          // Auto-start after OAuth completes so the user doesn't have to click Start separately.
          await activate();
        }
      } catch { /* ignore */ }
    }, 2000);
    setTimeout(() => clearInterval(poll), 120000);
  };

  const activate = async () => {
    setActivating(true);
    try {
      const result = await spClient.activateIntegration(manifest.id);
      if (result.warning) {
        onSuccess(result.warning);
      } else {
        onSuccess(`${manifest.name} integration started with ${result.tools.length} tools`);
      }
      onStatusChange();
    } catch (err) {
      onSuccess(`Failed to start ${manifest.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setActivating(false);
    }
  };

  const remove = async () => {
    try {
      await spClient.removeMcpIntegration(manifest.id);
      onSuccess(`${manifest.name} integration removed`);
      onStatusChange();
    } catch {
      onSuccess(`Failed to remove ${manifest.name}`);
    }
  };

  const icon = ICON_MAP[manifest.icon] ?? '\u{1F527}';

  // Two truthful, binary status chips. Process = is the subprocess running;
  // Auth = can it authenticate (token/credentials present). Grey = neutral
  // (not set up / stopped), green = ok, red = error. (Auth "failed" detection
  // on a revoked/expired token is a follow-up — see auth-health work.)
  const procChip =
    cardState === 'running' ? { c: 'int-chip-ok', t: 'Running' }
    : cardState === 'starting' ? { c: 'int-chip-idle', t: 'Starting' }
    : (integration && !integration.running && integration.error) ? { c: 'int-chip-bad', t: 'Crashed' }
    : { c: 'int-chip-idle', t: 'Stopped' };
  // needsAuth / authConnected computed above (needed by cardState). For no-auth
  // integrations (local CRM/records) "Not set up" is wrong → show "No auth".
  const authFailed = manifest.oauth && oauthConnected && authHealth?.status === 'failed';
  const authChip = !needsAuth
    ? { c: 'int-chip-idle', t: 'No auth' }
    : authFailed
      ? { c: 'int-chip-bad', t: 'Auth failed' }
      : authConnected
        ? { c: 'int-chip-ok', t: 'Auth OK' }
        : { c: 'int-chip-idle', t: 'Not set up' };

  // Setup guides hardcode a redirect URI (e.g. the Docker :7400). Rewrite it to
  // THIS gateway's actual origin so npm/dev users register the correct URI.
  const withRedirectUri = (text: string) =>
    text.replace(
      /https?:\/\/[^\s)]+\/auth\/oauth\/[a-z-]+\/callback/gi,
      `${window.location.origin}/auth/oauth/${manifest.id}/callback`,
    );

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <span style={{ fontSize: '1.4rem', lineHeight: 1.2 }}>{icon}</span>
        <h3 className="card-title" style={{ margin: 0, flex: 1, alignSelf: 'center' }}>{manifest.name}</h3>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Process chip only once setup is complete — a running-but-unconfigured
              subprocess isn't meaningfully "running", so we show only what's
              missing (the auth chip) until then. */}
          {cardState !== 'unconfigured' && cardState !== 'needs-oauth' && (
            <span className={`int-chip ${procChip.c}`}><span className="int-dot" />{procChip.t}</span>
          )}
          <span className={`int-chip ${authChip.c}`}><span className="int-dot" />{authChip.t}</span>
        </div>
      </div>

      {/* Connected account. Captured at OAuth connect; unknown for connections
          made before account capture (and unrecoverable from a dead token). */}
      {manifest.oauth && oauthConnected && (
        <div className="int-account" style={{ marginTop: '0.7rem' }}>
          {authHealth?.account
            ? <>Connected as <b>{authHealth.account}</b></>
            : <span className="int-none">Account not recorded — reconnect to capture which account is used</span>}
        </div>
      )}

      {/* Auth actually broken (e.g. Google invalid_grant) — surface + recover. */}
      {authFailed && !editingCreds && (
        <div style={{ marginTop: '0.7rem' }}>
          <div className="status-banner status-banner-error" style={{ marginBottom: '0.6rem' }}>
            <span className="status-banner-icon">!</span>
            <span className="status-banner-text">
              Authentication failed{authHealth?.error ? ` — ${authHealth.error}` : ''}. Reconnect to restore access.
            </span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={startOAuth}>
            Reconnect {manifest.name}
          </button>
        </div>
      )}

      {/* Lean by default — what/profile/scopes/tools tucked behind Details */}
      <details className="int-details" style={{ marginTop: '0.85rem', marginBottom: '1.25rem' }}>
        <summary>Details</summary>
        <div className="int-meta">
          <span className="int-k">What</span><span>{manifest.description}</span>
          {manifest.profile && (<><span className="int-k">Profile</span><span>{manifest.profile}</span></>)}
          {manifest.oauth && (<><span className="int-k">Scopes</span><span>{manifest.oauth.scopes?.join(', ') || '—'}</span></>)}
          {integration && (<><span className="int-k">Tools</span><span>{integration.toolCount} gated</span></>)}
        </div>
      </details>

      {/* Setup Guide (collapsible) */}
      {manifest.setupGuide && manifest.setupGuide.length > 0 && (cardState !== 'running' || authFailed) && (
        <div style={{ marginBottom: '0.75rem' }}>
          <button
            onClick={() => setShowGuide(!showGuide)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: '0.8rem',
              color: 'var(--accent)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
            }}
          >
            <span style={{ transition: 'transform 0.2s', transform: showGuide ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>{'\u25B6'}</span>
            How to set up {manifest.name}
          </button>
          {showGuide && (
            <div style={{ marginTop: '0.75rem', paddingLeft: '0.25rem' }}>
              {manifest.setupGuide.map((step: { title: string; description: string; link?: string }, i: number) => (
                <div key={i} style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
                  <div style={{
                    width: '1.5rem',
                    height: '1.5rem',
                    borderRadius: '50%',
                    background: 'var(--border)',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    flexShrink: 0,
                    marginTop: '0.1rem',
                  }}>
                    {i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.125rem' }}>
                      {step.title}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {withRedirectUri(step.description)}
                      {step.link && (
                        <>
                          {' '}
                          <a href={step.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8rem' }}>
                            Open {'\u2197'}
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Starting state — subprocess is coming up after login; shown
          deliberately instead of "Not running" to stop the post-login flicker. */}
      {cardState === 'starting' && (
        <div className="service-status" style={{ color: 'var(--warning)' }}>
          <span className="service-status-dot" style={{ background: 'var(--warning)' }} />
          Starting…
        </div>
      )}

      {/* Change-credentials edit panel — renders regardless of cardState so it
          works while the integration is running/auth-failed. */}
      {editingCreds && (
        <div style={{ marginTop: '0.7rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>Change credentials</div>
          {credsOnFile && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
              Your current values are filled in below (secret hidden — click {'“'}show{'”'}). Edit them, then{manifest.oauth ? ' Save and Connect to re-link the account.' : ' Save to apply.'}
            </p>
          )}
          {manifest.credentials.fields.map(field => (
            <div className="form-group" key={field.key} style={{ marginBottom: '0.6rem' }}>
              <label className="form-label">{field.label}</label>
              {field.type === 'password' ? (
                <div className="cred-field">
                  <input
                    className="form-input"
                    type={showSecrets[field.key] ? 'text' : 'password'}
                    placeholder={field.placeholder}
                    value={credValues[field.key] || ''}
                    onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
                  />
                  <button className="cred-toggle" onClick={() => setShowSecrets(s => ({ ...s, [field.key]: !s[field.key] }))}>
                    {showSecrets[field.key] ? 'hide' : 'show'}
                  </button>
                </div>
              ) : (
                <input
                  className="form-input"
                  type="text"
                  placeholder={field.placeholder}
                  value={credValues[field.key] || ''}
                  onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
            <button className="btn btn-primary btn-sm" onClick={saveCredsEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {manifest.oauth && (
              <button className="btn btn-secondary btn-sm" onClick={startOAuth}>
                Connect {manifest.name}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditingCreds(false); setCredValues({}); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Running state — status shown by the chips above; just the actions here */}
      {!editingCreds && cardState === 'running' && integration && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Link to="/agent/new" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
              Authorize agent
            </Link>
            {(manifest.credentials.fields.length > 0 || manifest.oauth) && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => { setCredValues({ ...existingCreds }); setEditingCreds(true); }}
                title="Re-enter client ID / secret (e.g. a new OAuth client)."
              >
                Change credentials
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              className="btn btn-sm btn-ghost"
              style={{ color: 'var(--danger)' }}
              onClick={remove}
              title="Stops the subprocess and removes the integration from the registry. It will NOT auto-start on next gateway restart. Re-enable with Install."
            >
              Disable
            </button>
          </div>

          {/* (legacy authorize link kept hidden — replaced by the button above) */}
          <div style={{ display: 'none' }}>
            <Link to="/agent/new" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', display: 'block', textAlign: 'center' }}>
              Authorize your agent
            </Link>
          </div>
        </>
      )}

      {/* Unconfigured state — show credential form */}
      {cardState === 'unconfigured' && (() => {
        const allOptional = manifest.credentials.fields.every(f => f.optional);
        const hasRequiredFields = manifest.credentials.fields.some(f => !f.optional);
        const hasValues = manifest.credentials.fields.some(f => credValues[f.key]?.trim());
        return (
          <>
            {credsOnFile && (
              <div className="alert" style={{
                fontSize: '0.8rem',
                background: 'var(--bg-main)',
                border: '1px solid var(--border)',
                borderRadius: '0.375rem',
                padding: '0.5rem 0.75rem',
                marginBottom: '0.75rem',
                color: 'var(--text-secondary)',
              }}>
                <strong style={{ color: 'var(--text-primary)' }}>Credentials on file.</strong>{' '}
                Existing values are encrypted in the vault and not shown. Enter new values below to replace them, or{' '}
                <button
                  onClick={() => { setCredConfigured(true); if (manifest.oauth) setOauthConnected(true); }}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  keep existing
                </button>.
              </div>
            )}
            {manifest.oauth && !credsOnFile && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
                Step 1 of 2 — enter credentials, then connect your account.
              </p>
            )}
            {manifest.setupHint && !credsOnFile && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.75rem' }}>
                {manifest.setupHint}
              </p>
            )}
            {manifest.credentials.fields.map(field => (
              <div className="form-group" key={field.key} style={{ marginBottom: '0.75rem' }}>
                <label className="form-label">{field.label}</label>
                {field.type === 'password' ? (
                  <div className="cred-field">
                    <input
                      className="form-input"
                      type={showSecrets[field.key] ? 'text' : 'password'}
                      placeholder={field.placeholder}
                      value={credValues[field.key] || ''}
                      onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
                    />
                    <button
                      className="cred-toggle"
                      onClick={() => setShowSecrets(s => ({ ...s, [field.key]: !s[field.key] }))}
                    >
                      {showSecrets[field.key] ? 'hide' : 'show'}
                    </button>
                  </div>
                ) : (
                  <input
                    className="form-input"
                    type="text"
                    placeholder={field.placeholder}
                    value={credValues[field.key] || ''}
                    onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {hasValues && (
                <button
                  className="btn btn-primary"
                  onClick={saveCredentials}
                  disabled={saving || (hasRequiredFields && !manifest.credentials.fields.filter(f => !f.optional).every(f => credValues[f.key]?.trim()))}
                >
                  {saving ? 'Saving...' : 'Save & Encrypt'}
                </button>
              )}
              {allOptional && !hasValues && (
                <button
                  className="btn btn-primary"
                  onClick={activate}
                  disabled={activating}
                >
                  {activating ? 'Starting...' : `Activate ${manifest.name}`}
                </button>
              )}
            </div>
          </>
        );
      })()}

      {/* Needs OAuth */}
      {cardState === 'needs-oauth' && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--success)', marginBottom: '0.25rem' }}>
            {'\u2713'} Step 1 done — credentials saved
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
            Step 2: connect your {manifest.name} account to authorize access.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={startOAuth}>
              Connect {manifest.name} Account
            </button>
            <button className="btn btn-ghost" onClick={() => setCredConfigured(false)}>
              Change Credentials
            </button>
          </div>
        </>
      )}

      {/* Ready to start */}
      {cardState === 'ready' && !integration && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--success)', marginBottom: '0.75rem' }}>
            {'\u2713'} {manifest.oauth ? `${manifest.name} account connected` : 'Credentials configured'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={activate}
              disabled={activating}
            >
              {activating ? 'Starting...' : `Start ${manifest.name} Integration`}
            </button>
            {!manifest.oauth && (
              <button className="btn btn-ghost" onClick={() => setCredConfigured(false)}>
                Update Credentials
              </button>
            )}
            {manifest.oauth && (
              <button className="btn btn-ghost" onClick={() => { setCredConfigured(false); setOauthConnected(false); }}>
                Change Credentials
              </button>
            )}
          </div>
        </>
      )}

      {/* Stopped but registered — offer retry */}
      {cardState === 'ready' && integration && !integration.running && (
        <>
          <div className="service-status service-status-error" style={{ marginBottom: '0.75rem' }}>
            <span className="service-status-dot" />
            Not running
          </div>
          {integration.error && (
            <div style={{ fontSize: '0.8rem', color: 'var(--danger)', marginBottom: '0.75rem' }}>
              {integration.error}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" onClick={activate} disabled={activating}>
              {activating ? 'Starting...' : 'Start'}
            </button>
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove}>
              Disable
            </button>
          </div>
        </>
      )}
    </div>
  );
}
