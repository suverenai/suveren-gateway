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

interface AsPairing {
  asUrl: string;
  paired: boolean;
  fingerprint: string | null;
  pairedAt: string | null;
  pinTlsEnabled: boolean;
  tlsPinFingerprint: string | null;
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

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Authority Server</h2>

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
          {state.pinTlsEnabled && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <strong>TLS certificate pin:</strong>{' '}
              {state.tlsPinFingerprint ? (
                <code>{state.tlsPinFingerprint}</code>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>not yet captured — sign in once more</span>
              )}
              <br />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                TLS pinning is ON (<code>config set pin-tls on</code>). Every connection to the
                Authority Server must present this certificate's public key, or the gateway
                refuses it and locks. A certificate renewal with the SAME key keeps this pin; a
                NEW key needs re-pairing.
              </span>
            </p>
          )}
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
            To point this gateway at a different Authority Server:{' '}
            <code>suveren-gateway config set as-url &lt;url&gt;</code>, then restart. Changing it
            ends the current sign-in and clears cached mandates — you sign in again against the
            new server.
          </p>
        </>
      )}
    </div>
  );
}
