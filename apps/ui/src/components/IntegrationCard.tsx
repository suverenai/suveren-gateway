import { useState, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { spClient, type IntegrationManifest, type McpIntegrationStatus } from '../lib/sp-client';
import type { IntegrationState } from '../contexts/IntegrationStatusContext';
import { isSimulated, modeLabel, modeNote } from '../lib/simulation';
import { ObTypeLine, ObFold, ObChev, useFoldAccordion } from './ObjectCard';
import {
  statusWord, authWord, startsOpen, readsPhrase, connectorOneLine,
  type CardState,
} from '../lib/integration-card-view';
import { areasOf as areaProfilesOf } from '../lib/integration-grouping';

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
  if (days === null) return 'From your mandate';
  if (days === 0) return 'Read nothing';
  if (days === 1) return '1 day back';
  if (days === 365) return '1 year back';
  if (days % 365 === 0) return `${days / 365} years back`;
  return `${days} days back`;
}

export interface StoppedIntegrationDisplay {
  chip: { t: string };
  /** False only when paused by simulation mode — a Start click there cannot
   *  succeed, so the button is not offered at all rather than shown disabled. */
  showStart: boolean;
}

/**
 * What a registered-but-not-running integration shows: chip + whether a
 * retry ("Start") makes sense at all.
 *
 * Paused by simulation mode is checked first and wins outright — a connector
 * refused solely because the gateway-wide mode is on will refuse again on
 * every retry, so offering Start would be a dead button, and `integration`
 * never carries both `paused` and `error` for the same reason (see
 * integration-manager's getStatus). Anything else not running shows the
 * pre-existing Crashed/Stopped + Start treatment, unchanged.
 */
export function stoppedIntegrationDisplay(
  integration: Pick<McpIntegrationStatus, 'running' | 'error' | 'paused'> | undefined,
): StoppedIntegrationDisplay {
  if (integration?.paused === 'simulation') {
    return { chip: { t: 'Paused' }, showStart: false };
  }
  if (integration && !integration.running && integration.error) {
    return { chip: { t: 'Crashed' }, showStart: true };
  }
  return { chip: { t: 'Stopped' }, showStart: true };
}

interface Props {
  manifest: IntegrationManifest;
  /** The area this card is listed under (UI spec §20.3): shown, with its icon, in the type line. */
  area?: { shortId: string; name: string };
  integration: McpIntegrationStatus | undefined;
  /**
   * Canonical state derived by IntegrationStatusContext. Drives the status
   * chip so Sidebar/Dashboard/IntegrationsPage agree by construction.
   */
  state: IntegrationState;
  onStatusChange: () => void;
  onSuccess: (msg: string) => void;
}

export function IntegrationCard({ manifest, area, integration, state, onStatusChange, onSuccess }: Props) {
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
  // Whether the vault lookup has answered — a card opens or stays closed only once we know what it needs.
  const [credsLoaded, setCredsLoaded] = useState(false);
  // The person's own open/close choice; until they make one the card follows what it needs (see startsOpen).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const accordion = useFoldAccordion<HTMLDivElement>();
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
      if (cancelled) return;
      setCredsLoaded(true);
      if (!status.configured) return;
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
    }).catch(() => { if (!cancelled) setCredsLoaded(true); });
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
          ? `${manifest.name} read window now follows your mandate`
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

  const stoppedDisplay = stoppedIntegrationDisplay(integration);
  // needsAuth / authConnected computed above (needed by cardState).
  const authFailed = manifest.oauth && oauthConnected && authHealth?.status === 'failed';

  // Setup guides hardcode a redirect URI (e.g. the Docker :7400). Rewrite it to
  // THIS gateway's actual origin so npm/dev users register the correct URI.
  const withRedirectUri = (text: string) =>
    text.replace(
      /https?:\/\/[^\s)]+\/auth\/oauth\/[a-z-]+\/callback/gi,
      `${window.location.origin}/auth/oauth/${manifest.id}/callback`,
    );

  const stoppedKind: 'paused' | 'crashed' | 'stopped' =
    stoppedDisplay.chip.t === 'Paused' ? 'paused' : stoppedDisplay.chip.t === 'Crashed' ? 'crashed' : 'stopped';
  const status = statusWord(cardState, stoppedDisplay.chip);
  const auth = authWord({ needsAuth, authFailed: !!authFailed, authConnected });
  const mode = modeLabel(manifest, existingCreds);
  const note = modeNote(manifest, existingCreds);
  const simulated = isSimulated(manifest, existingCreds);
  const oneLine = connectorOneLine({
    cardState,
    authFailed: !!authFailed,
    modeNote: note,
    requiredLabels: manifest.credentials.fields.filter(f => !f.optional).map(f => f.label),
    oauth: !!manifest.oauth,
    noFields: manifest.credentials.fields.length === 0 && !manifest.oauth,
    setupHint: manifest.setupHint,
    reads: hasReadAge ? readsPhrase(readAge, readAgeLabel) : null,
    stopped: stoppedKind,
  });
  // Closed by default only when it is healthy; a card that needs something opens (until the person chooses).
  const open = userOpen ?? (credsLoaded && startsOpen(cardState, !!authFailed));

  const isPath = (v: string) => v.includes('/') || v.includes('\\');
  const canEditCreds = manifest.credentials.fields.length > 0 || !!manifest.oauth;
  const guide = manifest.setupGuide && manifest.setupGuide.length > 0 && (cardState !== 'running' || authFailed)
    ? manifest.setupGuide : null;
  const needsSetup = cardState === 'unconfigured' || cardState === 'needs-oauth';

  // One credential field (light input; secrets get a show/hide). `edit` = the "Change credentials" panel,
  // where a stored secret is shown as a recognition hint and left blank keeps it.
  const renderField = (field: IntegrationManifest['credentials']['fields'][number], edit: boolean) => (
    <div className="form-group" key={field.key}>
      <label className="form-label">{field.label}</label>
      {field.type === 'password' ? (
        <div className="cred-field">
          <input
            className="form-input"
            type={showSecrets[field.key] ? 'text' : 'password'}
            // Service credential, not a login: block the browser's password manager from autofilling
            // the Suveren API key saved for this origin. "new-password" is the only value Chrome
            // honors on password inputs; the neutral name avoids heuristic matching.
            name={`${manifest.id}-${field.key}-credential`}
            autoComplete="new-password"
            placeholder={edit
              ? (secretHints[field.key]?.preview
                ? `Unchanged — ends in ${secretHints[field.key].preview}`
                : credsOnFile ? 'Unchanged — paste a new value to replace' : field.placeholder)
              : field.placeholder}
            value={credValues[field.key] || ''}
            onChange={e => setCredValues(v => ({ ...v, [field.key]: e.target.value }))}
          />
          <button type="button" className="cred-toggle" onClick={() => setShowSecrets(s => ({ ...s, [field.key]: !s[field.key] }))}>
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
  );

  return (
    <details
      className="card ob-card su-cn"
      open={open}
      onToggle={e => setUserOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <div className="su-cn-head">
          <ObTypeLine
            tag="CONNECTOR"
            profileId={area?.shortId}
            parts={[
              area?.name,
              <span className={`ob-st${status.tone === 'muted' ? ' is-off' : ''}`}>{status.text}</span>,
              simulated && (
                <span className="ob-st is-sim" title="This connector answers from a simulated system with test data. Nothing reaches your real systems.">Simulation</span>
              ),
              auth && (auth.tone === 'bold' ? <span className="ob-st">{auth.text}</span> : auth.text),
            ]}
          />
          <h3 className="card-title ob-title">
            {manifest.name}
            {mode && <span className="ob-quiet-inline"> · {mode}</span>}
          </h3>
          <p className="ob-one" data-testid={note ? 'integration-mode-note' : undefined}>{oneLine}</p>
        </div>
        <ObChev />
      </summary>

      <div className="su-cn-body" ref={accordion}>
        {/* What is true about it, as rows in a grey tile. Secrets only ever as recognition hints. */}
        <section className="ob-tile">
          <dl className="ob-kv">
            {cardState === 'running' && integration ? (
              <>
                {note && (<><dt>Runs on</dt><dd className="ob-plain">{note}</dd></>)}
                <dt>Access</dt>
                <dd>
                  {!needsAuth ? 'No auth'
                    : authFailed ? 'Auth failed'
                    : manifest.oauth && oauthConnected && authHealth?.account ? <>Connected as <b>{authHealth.account}</b></>
                    : 'Auth OK'}
                </dd>
                {manifest.credentials.fields.map(f => {
                  const isSecret = f.type === 'password';
                  const hint = secretHints[f.key];
                  if (!isSecret && existingCreds[f.key] == null) return null;
                  if (isSecret && hint == null) return null;
                  const value = isSecret ? (hint.preview ?? 'set') : existingCreds[f.key];
                  return (
                    <Fragment key={f.key}>
                      <dt>{f.label}</dt>
                      <dd className={isSecret || isPath(value) ? 'ob-mono is-strong' : undefined}>
                        {value}
                        {isSecret && credUpdatedAt && (
                          <span className="ob-quiet-inline">
                            {' '}· added {new Date(credUpdatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </dd>
                    </Fragment>
                  );
                })}
                {hasReadAge && readAge !== undefined && (
                  <>
                    <dt>Reads</dt>
                    <dd>
                      {readAge === null ? 'window from your mandate' : readAgeLabel(readAge).toLowerCase()}
                      {savingReadAge && <span className="ob-quiet-inline"> saving…</span>}
                      {readAgeError && <span className="ob-bold"> {readAgeError}</span>}
                    </dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt>Status</dt>
                <dd>{cardState === 'starting' ? 'Starting…' : status.text}</dd>
                {manifest.oauth && cardState === 'unconfigured' && !credsOnFile && (
                  <><dt>Step</dt><dd className="ob-plain">1 of 2 — enter credentials, then connect your account</dd></>
                )}
                {cardState === 'needs-oauth' && (
                  <><dt>Step</dt><dd className="ob-plain">{'✓'} Step 1 done — credentials saved. Step 2: connect your {manifest.name} account to authorize access.</dd></>
                )}
                {cardState === 'ready' && !integration && (
                  <><dt>Credentials</dt><dd className="ob-plain">{'✓'} {manifest.oauth ? `${manifest.name} account connected` : 'Credentials configured'}</dd></>
                )}
                {cardState === 'ready' && integration && !integration.running && integration.error && (
                  <><dt>Error</dt><dd className="ob-plain">{integration.error}</dd></>
                )}
              </>
            )}
          </dl>
        </section>

        {/* Connected account. Captured at OAuth connect; unknown for connections made before account capture. */}
        {manifest.oauth && oauthConnected && !authHealth?.account && (
          <p className="ob-lbl ob-gap">Account not recorded — reconnect to capture which account is used</p>
        )}

        {/* Auth actually broken (e.g. Google invalid_grant). The refusal is the product, so this works harder
            than the success path: what failed, why, what it blocks, and the one action that fixes it. */}
        {authFailed && !editingCreds && (
          <section className="ob-tile">
            <div className="ob-sent-h">{manifest.name} stopped accepting the stored credentials</div>
            <p className="ob-lbl">
              {authHealth?.error === 'invalid_grant'
                ? <>The refresh token was revoked (<code>invalid_grant</code>) — this usually follows a password change or a security checkup on the provider's side.</>
                : authHealth?.error
                  ? <>The provider reported <code>{authHealth.error}</code>.</>
                  : <>The provider rejected the stored authentication.</>}{' '}
              Your agent's {manifest.name} actions are <b>blocked</b>, not failing silently.
            </p>
          </section>
        )}

        {/* How to set up — opens by default while the connector is not set up */}
        {guide && (
          <ObFold title={`How to set up ${manifest.name}`} summary={guide[0].title} open={needsSetup}>
            {manifest.setupHint && !credsOnFile && <p>{manifest.setupHint}</p>}
            <ol className="su-list">
              {guide.map((step: { title: string; description: string; link?: string }, i: number) => (
                <li key={i}>
                  <b>{step.title}</b>
                  <div className="ob-lbl">
                    {withRedirectUri(step.description)}
                    {step.link && (
                      <>
                        {' '}
                        <a href={step.link} target="_blank" rel="noopener noreferrer">Open {'↗'}</a>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </ObFold>
        )}
        {!guide && manifest.setupHint && !credsOnFile && needsSetup && (
          <p className="ob-lbl ob-gap">{manifest.setupHint}</p>
        )}

        {/* Starting state — the subprocess is coming up after login; shown deliberately instead of "Not running". */}
        {cardState === 'starting' && <p className="ob-lbl ob-gap">Starting…</p>}

        {/* Change-credentials edit panel — renders regardless of cardState so it works while the connector
            is running or auth-failed. */}
        {editingCreds && (
          <div className="su-edit">
            <div className="ob-sent-h">Change credentials</div>
            {credsOnFile && (
              <p className="ob-lbl">
                Leaving a secret blank keeps the stored one — editing other fields can never
                silently wipe it.{manifest.oauth ? ' Save, then Connect to re-link the account.' : ''}
              </p>
            )}
            {manifest.credentials.fields.map(field => renderField(field, true))}
            <div className="ob-btns is-inline is-tight">
              <button className="ob-btn is-solid" onClick={saveCredsEdit} disabled={saving || !credsDirty}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {manifest.oauth && (
                <button className="ob-btn" onClick={startOAuth}>
                  Connect {manifest.name}
                </button>
              )}
              <button className="ob-btn" onClick={() => { setEditingCreds(false); setCredValues({}); }}>
                Cancel
              </button>
            </div>
            {!credsDirty && !saving && <p className="ob-lbl ob-gap">No changes yet</p>}
          </div>
        )}

        {/* Read window — local, live, one place. Read enforcement never reaches the Authority Server, so this
            needs no re-authorization and applies to the next read. Only for connectors whose manifest declares
            an age-bounded read. */}
        {cardState === 'running' && hasReadAge && readAge !== undefined && editingReadAge && (
          <div className="su-edit">
            <div className="ob-sent-h">How far back may your agent read?</div>
            <p className="ob-lbl">Applies immediately — no Save, no new mandate.</p>
            <div className="ob-btns is-tight">
              {READ_AGE_PRESETS.map(days => {
                const active = readAge === days;
                return (
                  <button
                    key={days}
                    className={`ob-btn${active ? ' is-solid' : ''}`}
                    aria-pressed={active}
                    disabled={savingReadAge}
                    onClick={() => saveReadAge(days)}
                  >
                    {readAgeLabel(days)}
                  </button>
                );
              })}
              <button
                className={`ob-btn${readAge === null ? ' is-solid' : ''}`}
                aria-pressed={readAge === null}
                disabled={savingReadAge}
                onClick={() => saveReadAge(null)}
                title="Clear the local setting and use the read window from your signed mandate instead."
              >
                {readAgeLabel(null)}
              </button>
            </div>
            <p className="ob-lbl ob-gap">
              {readAgeError ? <span className="ob-bold">{readAgeError}</span>
                : savingReadAge ? 'Saving…'
                : readAge === null ? 'Using the window from your mandate. If none is set there, reads are blocked.'
                : readAge === 0 ? 'Your agent cannot read any mail.'
                : `Anything older than ${readAge} days is blocked, whoever it is from.`}
            </p>
            <div className="ob-btns is-inline is-tight">
              <button className="ob-btn" onClick={() => setEditingReadAge(false)}>Done</button>
            </div>
          </div>
        )}

        {/* Running — the actions */}
        {!editingCreds && cardState === 'running' && integration && (
          <div className="ob-btns">
            {authFailed && (
              <button className="ob-btn is-solid" onClick={startOAuth}>Reconnect {manifest.name}</button>
            )}
            <Link to="/mandates?new=1" className="ob-btn">Give a mandate</Link>
            {canEditCreds && (
              <button
                className="ob-btn"
                onClick={() => { setCredValues({ ...existingCreds }); setEditingCreds(true); }}
                title="Re-enter client ID / secret (e.g. a new OAuth client)."
              >
                Edit credentials
              </button>
            )}
            {hasReadAge && readAge !== undefined && !editingReadAge && (
              <button className="ob-btn" onClick={() => setEditingReadAge(true)}>Edit reads window</button>
            )}
            <button
              className="ob-btn"
              onClick={remove}
              title="Stops the subprocess and removes the integration from the registry. It will NOT auto-start on next gateway restart. Re-enable with Install."
            >
              Disable
            </button>
          </div>
        )}

        {/* Not set up — credential form */}
        {cardState === 'unconfigured' && (() => {
          const allOptional = manifest.credentials.fields.every(f => f.optional);
          const hasRequiredFields = manifest.credentials.fields.some(f => !f.optional);
          const hasValues = manifest.credentials.fields.some(f => credValues[f.key]?.trim());
          return (
            <>
              {credsOnFile && (
                <p className="ob-lbl ob-gap">
                  <b className="ob-bold">Credentials on file.</b>{' '}
                  Existing values are encrypted in the vault and not shown. Enter new values below to replace them, or{' '}
                  <button
                    className="ob-link"
                    onClick={() => { setCredConfigured(true); if (manifest.oauth) setOauthConnected(true); }}
                  >
                    keep existing
                  </button>.
                </p>
              )}
              <div className="su-fields">
                {manifest.credentials.fields.map(field => renderField(field, false))}
              </div>
              <div className="ob-btns is-inline">
                {(hasValues || hasRequiredFields) && (
                  <button
                    className="ob-btn is-solid"
                    onClick={saveCredentials}
                    disabled={saving || !hasValues || (hasRequiredFields && !manifest.credentials.fields.filter(f => !f.optional).every(f => credValues[f.key]?.trim()))}
                  >
                    {saving ? 'Saving...' : 'Save & Encrypt'}
                  </button>
                )}
                {allOptional && !hasValues && (
                  <button className="ob-btn is-solid" onClick={activate} disabled={activating}>
                    {activating ? 'Starting...' : `Activate ${manifest.name}`}
                  </button>
                )}
              </div>
            </>
          );
        })()}

        {/* Needs OAuth — step 2 */}
        {cardState === 'needs-oauth' && (
          <div className="ob-btns is-inline">
            <button className="ob-btn is-solid" onClick={startOAuth}>
              Connect {manifest.name} Account
            </button>
            <button className="ob-btn" onClick={() => setCredConfigured(false)}>
              Change Credentials
            </button>
          </div>
        )}

        {/* Ready to start */}
        {cardState === 'ready' && !integration && (
          <div className="ob-btns is-inline">
            <button className="ob-btn is-solid" onClick={activate} disabled={activating}>
              {activating ? 'Starting...' : `Start ${manifest.name} Integration`}
            </button>
            {!manifest.oauth && (
              <button className="ob-btn" onClick={() => setCredConfigured(false)}>
                Update Credentials
              </button>
            )}
            {manifest.oauth && (
              <button className="ob-btn" onClick={() => { setCredConfigured(false); setOauthConnected(false); }}>
                Change Credentials
              </button>
            )}
          </div>
        )}

        {/* Stopped but registered — paused by simulation mode gets a neutral, honest state (no Start button — it
            cannot succeed while the mode is on); any other stop offers retry. Both driven by the same
            `stoppedIntegrationDisplay` decision as the status word above. */}
        {cardState === 'ready' && integration && !integration.running && (
          !stoppedDisplay.showStart ? (
            <>
              <p className="ob-lbl ob-gap">Real systems are off while simulation mode is on.</p>
              <div className="ob-btns is-inline">
                <button className="ob-btn" onClick={remove}>Disable</button>
              </div>
            </>
          ) : (
            <div className="ob-btns is-inline">
              <button className="ob-btn is-solid" onClick={activate} disabled={activating}>
                {activating ? 'Starting...' : 'Start'}
              </button>
              <button className="ob-btn" onClick={remove}>Disable</button>
            </div>
          )
        )}

        {/* Lean by default — what / profile / scopes / tools tucked behind Details */}
        <ObFold title="Details" summary="what it does">
          <dl className="ob-kv">
            <dt>What</dt><dd className="ob-plain">{manifest.description}</dd>
            {manifest.profile && (<><dt>Profile</dt><dd className="ob-plain">{areaProfilesOf(manifest).join(', ')}</dd></>)}
            {manifest.oauth && (<><dt>Scopes</dt><dd className="ob-plain">{manifest.oauth.scopes?.join(', ') || '—'}</dd></>)}
            {integration && (<><dt>Tools</dt><dd className="ob-plain">{integration.toolCount} gated</dd></>)}
          </dl>
        </ObFold>
      </div>
    </details>
  );
}
