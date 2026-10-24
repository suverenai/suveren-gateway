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
import { ObTypeLine, ObFold } from './ObjectCard';

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
    <article className="ob-card su-card">
      <ObTypeLine tag="SERVER" parts={['Connection', asUrlLocked && <LockedByItBadge />]} />
      <h3 className="ob-title">Your Authority Server</h3>

      {!state && !error && (
        <p className="ob-one">Checking…</p>
      )}

      {error && (
        <p role="alert" className="ob-one ob-bold msg-error">{error}</p>
      )}

      {state && (
        <>
          <section className="ob-tile">
            <dl className="ob-kv">
              <dt>URL</dt>
              <dd className="ob-mono is-strong">{state.asUrl}</dd>
              {state.paired && state.fingerprint && (
                <>
                  <dt>Key fingerprint</dt>
                  <dd className="ob-mono is-strong">{state.fingerprint}</dd>
                </>
              )}
              {/* Shown ALWAYS once captured, not just when pin-tls is on: the
                  fingerprint is captured at every sign-in regardless (see
                  as-tls-pin.ts), so turning pin-tls on later enforces a pin
                  already on file rather than a fresh trust-on-first-use
                  moment — this is the out-of-band check for that pin, same as
                  the key fingerprint above, and worth comparing before relying
                  on it either way. */}
              {(state.tlsPinFingerprint || state.pinTlsEnabled) && (
                <>
                  <dt>TLS certificate pin {pinTlsLocked && <LockedByItBadge title="TLS pinning is set by your IT policy" />}</dt>
                  <dd className={state.tlsPinFingerprint ? 'ob-mono is-strong' : 'ob-plain'}>
                    {state.tlsPinFingerprint ?? (
                      <>
                        not yet captured — this URL has no recorded pairing over TLS
                        {state.pinTlsEnabled ? '; sign in to establish one (re-pairing required)' : ''}
                      </>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </section>

          {state.paired && state.fingerprint ? (
            <p className="ob-one">
              Compare this with the fingerprint on the Authority Server's own admin page over a
              second channel (phone, video call) to confirm this gateway is talking to the right
              server.
            </p>
          ) : (
            <p className="ob-one">
              Not yet paired — sign in once to pin this server's key.
            </p>
          )}
          {(state.tlsPinFingerprint || state.pinTlsEnabled) && (
            <p className="ob-one">
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
            </p>
          )}
          {asUrlLocked ? (
            <p className="ob-one">
              This Authority Server URL is set by your organization's IT policy and cannot be
              changed from this computer. Contact your IT administrator if it needs to change.
            </p>
          ) : (
            <ObFold title="Point this gateway at a different server" summary="command, then restart">
              <p>
                <code>suveren-gateway config set as-url &lt;url&gt;</code>, then restart.
              </p>
              <p>
                Changing it ends the current sign-in and clears cached mandates — you sign in again
                against the new server.
              </p>
            </ObFold>
          )}
        </>
      )}
    </article>
  );
}
