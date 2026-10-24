/**
 * "Always show my verified name" — the owner's standing disclosure choice,
 * held by the Authority Server (GET/PUT /api/users/me/identity-disclosure).
 *
 * While on, the AS attaches the verified name to EVERY mandate this person
 * gives — the mandate screen, a team mandate, or one the setup AI proposed and
 * they approved — whatever the request says. Mandates already signed stay as
 * they were. Renders backend truth, re-reading after every change.
 */
import { useCallback, useEffect, useState } from 'react';
import { spClient, type IdentityDisclosure } from '../lib/sp-client';
import { ObTypeLine } from './ObjectCard';

const METHOD_LABEL: Record<string, string> = {
  as_vouched: 'verified by',
  eudi: 'verified with an EU digital identity (EUDI)',
};

export function IdentityDisclosureToggle() {
  const [state, setState] = useState<IdentityDisclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await spClient.getIdentityDisclosure());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the setting');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      setState(await spClient.setIdentityDisclosure(!state.always));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      await load();
    } finally {
      setBusy(false);
    }
  }, [state, busy, load]);

  const title = <h3 className="ob-title">Your name on mandates and tickets</h3>;

  if (!state) {
    return (
      <article className="ob-card su-card">
        <ObTypeLine parts={['Mandates and tickets']} />
        {title}
        <p role={error ? 'alert' : undefined} className="ob-one">
          {error ? `Could not read the setting: ${error}` : 'Checking…'}
        </p>
      </article>
    );
  }

  const who = state.verified && state.name
    ? `${state.name} — ${state.method === 'as_vouched' ? `${METHOD_LABEL.as_vouched} ${state.verifier}` : METHOD_LABEL[state.method ?? ''] ?? state.method}`
    : null;

  return (
    <article className="ob-card su-card">
      <div className="su-row">
        <div>
          <ObTypeLine parts={['Mandates and tickets', <span className={`ob-st${state.always ? '' : ' is-off'}`}>{state.always ? 'On' : 'Off'}</span>]} />
          {title}
          <p className="ob-one">
            {state.always
              ? 'On: your verified name is attached to every mandate you give — including ones the setup AI proposes and you approve — and to the tickets under them.'
              : 'Off: each mandate asks whether to show your name. Mandates the setup AI proposes carry no name.'}
            {' '}Mandates already given stay as they are.
          </p>
          <p className="ob-one">
            {who ? `Your identity: ${who}.` : 'Your identity is not verified yet — no name can be shown until it is.'}
          </p>
        </div>
        <div className="ob-btns">
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            aria-pressed={state.always}
            className="ob-btn"
          >
            {busy ? 'Saving…' : state.always ? 'Turn off' : 'Always show my name'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="ob-one ob-bold msg-error">{error}</p>
      )}
    </article>
  );
}
