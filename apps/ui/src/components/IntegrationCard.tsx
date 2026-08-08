import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { spClient, type IntegrationManifest, type McpIntegrationStatus } from '../lib/sp-client';
import type { IntegrationState } from '../contexts/IntegrationStatusContext';

const ICON_MAP: Record<string, string> = {
  card: '\u{1F4B3}',
  mail: '\u2709\uFE0F',
};

/**
 * Does this integration read anything with an age dimension?
 *
 * Generic — derived from the manifest's own read adapters (`read.ageField`),
 * never from an integration id. An integration that declares no age-bounded
 * read tool gets no Read-policy control, because the window would govern
 * nothing.
 */
export function declaresReadAge(toolGating: unknown): boolean {
  const overrides = (toolGating as { overrides?: Record<string, unknown> } | null)?.overrides;
  if (!overrides || typeof overrides !== 'object') return false;
  return Object.values(overrides).some(
    o => typeof (o as { read?: { ageField?: unknown } })?.read?.ageField === 'string',
  );
}

/**
 * Preset windows offered in the UI, in days.
 *
 * There is deliberately no "unlimited": an unbounded window is exactly the
 * hole F11 closed, and supporting it would mean re-adding the "unset means
 * read everything" branch as a feature. 3650 days is the practical
 * "everything" — effectively the whole mailbox, but still a real ceiling the
 * query can carry, needing no special case anywhere in the read path.
 */
export const READ_AGE_PRESETS = [0, 7, 30, 90, 365, 3650] as const;

/**
 * Label for a read-age value. `null` means no local setting — the signed grant
 * bound applies instead. `0` is a real choice ("read nothing"), so it must be
 * tested before any truthiness check.
 */
export function readAgeLabel(days: number | null): string {
  if (days === null) return 'From your authorization';
  if (days === 0) return 'Read nothing';
  if (days === 1) return '1 day back';
  if (days === 365) return '1 year back';
  if (days % 365 === 0) return `${days / 365} years back`;
  return `${days} days back`;
}

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
  const [existingCreds, setExistingCreds] = useState<Record<string, string>>({}); // current TEXT-field values, for the edit panel
  // Recognition hints for secret fields ("GOCSPX-…a3f9" / null) and the last
  // write time — all the browser ever learns about a stored secret.
  const [secretHints, setSecretHints] = useState<Record<string, { preview: string | null }>>({});
  const [credUpdatedAt, setCredUpdatedAt] = useState<string | undefined>(undefined);
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
  // Read-age window. Deliberately NOT mirrored into state: the integration
  // status is the source of truth, so the control renders straight from it and
  // a failed save can never leave a value on screen the gateway doesn't hold.
  // `pending` is shown only while a save is in flight — wrapped in an object
  // because `null` ("no local setting") is itself a legal value.
  const [pending, setPending] = useState<{ value: number | null } | null>(null);
  const [savingReadAge, setSavingReadAge] = useState(false);
  const [readAgeError, setReadAgeError] = useState<string | null>(null);
  // Collapsed by default: the seven preset pills were permanent clutter for a
  // setting most people touch once. Collapsed shows the choice; Edit shows the
  // choices. Pills still apply on click (backend truth, no fake Save).
  const [editingReadAge, setEditingReadAge] = useState(false);

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
      setSecretHints(status.secrets ?? {});
      setCredUpdatedAt(status.updatedAt);
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

  const hasReadAge = declaresReadAge(manifest.toolGating);
  // `undefined` = status not loaded yet (don't render the control at all);
  // `null` = loaded, no local setting → the signed grant bound applies.
  const storedReadAge = integration ? integration.readAgeDays ?? null : undefined;
  // While saving, show the value being written; otherwise always backend truth.
  const readAge = savingReadAge && pending ? pending.value : storedReadAge;

  const saveReadAge = async (days: number | null) => {
    setPending({ value: days });
    setSavingReadAge(true);
    setReadAgeError(null);
    try {
      await spClient.setReadPolicy(manifest.id, days);
      onSuccess(
        days === null
          ? `${manifest.name} read window now follows your authorization`
          : `${manifest.name} read window set to ${readAgeLabel(days).toLowerCase()}`,
      );
      // Refetch: the panel goes back to rendering whatever the gateway reports.
      onStatusChange();
    } catch (err) {
      setReadAgeError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSavingReadAge(false);
      setPending(null);
    }
  };

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

  /**
   * Only what actually changed. Untouched text fields are omitted (the server
   * merge keeps them), and an untyped password field is NOT sent as "" — an
   * empty string means "clear this" to the server, and an edit that only
   * changed the client ID must never wipe the secret.
   */
  const changedCredFields = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of manifest.credentials.fields) {
      const typed = credValues[f.key];
      if (f.type === 'password') {
        if (typed?.trim()) out[f.key] = typed;
      } else if (typed != null && typed !== (existingCreds[f.key] ?? '')) {
        out[f.key] = typed;
      }
    }
    return out;
  };
  const credsDirty = Object.keys(changedCredFields()).length > 0;

  // Save new credentials from the "Change credentials" edit panel (running
  // integration). For OAuth we stay in edit mode so the user can Connect with
  // the new client; for non-OAuth we restart with the new creds and exit.
  const saveCredsEdit = async () => {
    const changed = changedCredFields();
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    try {
      await spClient.setCredential(manifest.id, changed);
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

      {/* Auth actually broken (e.g. Google invalid_grant). The refusal is the
          product, so this box works harder than the success path: what failed,
          why, what it blocks, and the one action that fixes it. */}
      {authFailed && !editingCreds && (
        <div style={{
          marginTop: '0.7rem',
          border: '1px solid var(--danger)',
          borderRadius: '10px',
          padding: '0.8rem 0.95rem',
          background: 'color-mix(in srgb, var(--danger) 5%, var(--bg-elevated))',
        }}>
          <div style={{ fontSize: '0.86rem', fontWeight: 700 }}>
            {manifest.name} stopped accepting the stored credentials
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0.3rem 0 0', lineHeight: 1.55 }}>
            {authHealth?.error === 'invalid_grant'
              ? <>The refresh token was revoked (<code>invalid_grant</code>) — this usually follows a password change or a security checkup on the provider's side.</>
              : authHealth?.error
                ? <>The provider reported <code>{authHealth.error}</code>.</>
                : <>The provider rejected the stored authentication.</>}{' '}
            Your agent's {manifest.name} actions are <b>blocked</b>, not failing silently.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            <button className="btn btn-primary btn-sm" onClick={startOAuth}>
              Reconnect {manifest.name}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setCredValues({ ...existingCreds }); setEditingCreds(true); }}
            >
              Edit credentials
            </button>
          </div>
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
              Leaving a secret blank keeps the stored one — editing other fields can never
              silently wipe it.{manifest.oauth ? ' Save, then Connect to re-link the account.' : ''}
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
                    // Service credential, not a login: block the browser's
                    // password manager from autofilling the Suveren API key
                    // saved for this origin. "new-password" is the only value
                    // Chrome honors on password inputs; the neutral name
                    // avoids heuristic matching.
                    name={`${manifest.id}-${field.key}-credential`}
                    autoComplete="new-password"
                    placeholder={secretHints[field.key]?.preview
                      ? `Unchanged — ends in ${secretHints[field.key].preview}`
                      : credsOnFile ? 'Unchanged — paste a new value to replace' : field.placeholder}
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
                  name={`${manifest.id}-${field.key}-credential`}
                  autoComplete="off"
                  placeholder={field.placeholder}
                  value={credValues[field.key] || ''}
                  onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
            <button className="btn btn-primary btn-sm" onClick={saveCredsEdit} disabled={saving || !credsDirty}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {!credsDirty && !saving && (
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                No changes yet
              </span>
            )}
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
          {/* What is stored, without storing it in the browser: text fields as
              values, secrets as recognition hints. Enough to tell WHICH key is
              in the vault; whether it works is what the health probe answers. */}
          {(Object.keys(existingCreds).length > 0 || Object.keys(secretHints).length > 0) && (
            <div style={{ display: 'grid', gap: '0.3rem', margin: '0.15rem 0 0.7rem', fontSize: '0.82rem' }}>
              {manifest.credentials.fields.map(f => {
                const isSecret = f.type === 'password';
                const hint = secretHints[f.key];
                if (!isSecret && existingCreds[f.key] == null) return null;
                if (isSecret && hint == null) return null;
                return (
                  <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{f.label}</span>
                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem', textAlign: 'right', wordBreak: 'break-all' }}>
                      {isSecret ? (hint.preview ?? 'set') : existingCreds[f.key]}
                      {isSecret && credUpdatedAt && (
                        <span style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}>
                          {' '}· added {new Date(credUpdatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
                Edit credentials
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

          {/* Read policy — local, live, one place. Read enforcement never
              reaches the Authority Server, so this needs no re-authorization
              and applies to the next read. Only shown for integrations whose
              manifest actually declares an age-bounded read. */}
          {hasReadAge && readAge !== undefined && !editingReadAge && (
            <div style={{ marginTop: '0.9rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', minWidth: 0 }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Reads</span>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    {readAge === null ? 'window from your authorization' : readAgeLabel(readAge).toLowerCase()}
                  </span>
                  {savingReadAge && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>saving…</span>}
                  {readAgeError && <span style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>{readAgeError}</span>}
                </div>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditingReadAge(true)}>
                  Edit
                </button>
              </div>
            </div>
          )}
          {hasReadAge && readAge !== undefined && editingReadAge && (
            <div style={{ marginTop: '0.9rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '0.35rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>How far back may your agent read?</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditingReadAge(false)}>
                  Done
                </button>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', margin: '0 0 0.55rem' }}>
                Applies immediately — no Save, no new authorization.
              </p>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {READ_AGE_PRESETS.map(days => {
                  const active = readAge === days;
                  return (
                    <button
                      key={days}
                      className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
                      aria-pressed={active}
                      disabled={savingReadAge}
                      onClick={() => saveReadAge(days)}
                    >
                      {readAgeLabel(days)}
                    </button>
                  );
                })}
                <button
                  className={`btn btn-sm ${readAge === null ? 'btn-primary' : 'btn-ghost'}`}
                  aria-pressed={readAge === null}
                  disabled={savingReadAge}
                  onClick={() => saveReadAge(null)}
                  title="Clear the local setting and use the read window from your signed authorization instead."
                >
                  {readAgeLabel(null)}
                </button>
              </div>
              <div style={{ fontSize: '0.78rem', marginTop: '0.5rem' }}>
                {readAgeError ? (
                  <span style={{ color: 'var(--danger)' }}>{readAgeError}</span>
                ) : savingReadAge ? (
                  <span style={{ color: 'var(--text-muted)' }}>Saving…</span>
                ) : readAge === null ? (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Using the window from your authorization. If none is set there, reads are blocked.
                  </span>
                ) : readAge === 0 ? (
                  <span style={{ color: 'var(--text-muted)' }}>Your agent cannot read any mail.</span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Anything older than {readAge} days is blocked, whoever it is from.
                  </span>
                )}
              </div>
            </div>
          )}

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
                      // Block password-manager autofill (Suveren API key) —
                      // see the identical guard on the edit form above.
                      name={`${manifest.id}-${field.key}-credential`}
                      autoComplete="new-password"
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
                    name={`${manifest.id}-${field.key}-credential`}
                    autoComplete="off"
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
