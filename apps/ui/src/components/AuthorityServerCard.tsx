/**
 * "Authority Server" settings card — read-only.
 *
 * Shows the URL this gateway is currently pointed at and, once paired
 * (signed in at least once against it), the pinned public key's fingerprint
 * — the value an admin compares, over a second channel, against the AS's own
 * admin page to confirm this gateway is talking to the right server (see
 * doc/self-hosted-as.md §9.3).
 *
 * Deliberately no controls here to CHANGE the URL: that is a CLI operation
 * (`suveren-gateway config set as-url <url>` / `--as-url` on start) so it
 * takes effect at a controlled restart, not a live click from the browser.
 */
import { useEffect, useState } from 'react';
import { spClient } from '../lib/sp-client';
import { LockedByItBadge } from './LockedByItBadge';
import { isPolicyLocked } from '../lib/policy-lock';

interface AsPairing {
  asUrl: string;
  paired: boolean;
  fingerprint: string | null;
  pairedAt: string | null;
  pinTlsEnabled: boolean;
  tlsPinFingerprint: string | null;
  // IT policy (see lib/policy.ts via /as-pairing) — omitted entirely by an
  // older control-plane that predates managed settings; `isPolicyLocked`
  // treats that exactly like "not locked".
  asUrlLockedByPolicy?: boolean;
  pinTlsLockedByPolicy?: boolean;
}

export function AuthorityServerCard() {
  const [state, setState] = useState<AsPairing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    spClient.getAsPairing()
      .then(data => { if (!cancelled) setState(data); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read Authority Server info'); });
    return () => { cancelled = true; };
  }, []);

  const asUrlLocked = isPolicyLocked(state?.asUrlLockedByPolicy);
  const pinTlsLocked = isPolicyLocked(state?.pinTlsLockedByPolicy);

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Authority Server</h2>
        {asUrlLocked && <LockedByItBadge />}
      </div>

      {!state && !error && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Checking…</p>
      )}

      {error && (
        <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--danger, #c00)' }}>{error}</p>
      )}

      {state && (
        <>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            <strong>URL:</strong> <code>{state.asUrl}</code>
          </p>
          {state.paired && state.fingerprint ? (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <strong>Key fingerprint:</strong> <code>{state.fingerprint}</code>
              <br />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                Compare this with the fingerprint on the Authority Server's own admin page over a
                second channel (phone, video call) to confirm this gateway is talking to the right
                server.
              </span>
            </p>
          ) : (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
              Not yet paired — sign in once to pin this server's key.
            </p>
          )}
          {/* Shown ALWAYS once captured, not just when pin-tls is on: the
              fingerprint is captured at every sign-in regardless (see
              as-tls-pin.ts), so turning pin-tls on later enforces a pin
              already on file rather than a fresh trust-on-first-use
              moment — this is the out-of-band check for that pin, same as
              the key fingerprint above, and worth comparing before relying
              on it either way. */}
          {(state.tlsPinFingerprint || state.pinTlsEnabled) && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <strong>TLS certificate pin:</strong>{' '}
              {pinTlsLocked && <LockedByItBadge title="TLS pinning is set by your IT policy" />}{' '}
              {state.tlsPinFingerprint ? (
                <code>{state.tlsPinFingerprint}</code>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  not yet captured — this URL has no recorded pairing over TLS
                  {state.pinTlsEnabled ? '; sign in to establish one (re-pairing required)' : ''}
                </span>
              )}
              <br />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                {state.pinTlsEnabled ? (
                  <>
                    TLS pinning is ON{pinTlsLocked ? (
                      <>, set by your organization's IT policy</>
                    ) : (
                      <> (<code>config set pin-tls on</code>)</>
                    )}. Every connection to the Authority Server must present this certificate's
                    public key, or the gateway refuses it and locks.
                  </>
                ) : (
                  <>
                    Captured at sign-in; not currently enforced{pinTlsLocked ? (
                      <> — controlled by your organization's IT policy on this computer</>
                    ) : (
                      <> (<code>config set pin-tls on</code> to require it on every connection)</>
                    )}.
                  </>
                )}{' '}
                A certificate renewal with the SAME key keeps this pin; a NEW key needs re-pairing.
              </span>
            </p>
          )}
          {asUrlLocked ? (
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
              This Authority Server URL is set by your organization's IT policy and cannot be
              changed from this computer. Contact your IT administrator if it needs to change.
            </p>
          ) : (
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
              To point this gateway at a different Authority Server:{' '}
              <code>suveren-gateway config set as-url &lt;url&gt;</code>, then restart. Changing it
              ends the current sign-in and clears cached mandates — you sign in again against the
              new server.
            </p>
          )}
        </>
      )}
    </div>
  );
}
