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

  const title = <h3 className="card-title" style={{ margin: 0 }}>Your name on mandates and tickets</h3>;

  if (!state) {
    return (
      <div className="card" style={{ padding: '1.5rem', marginTop: '1rem' }}>
        {title}
        <p role={error ? 'alert' : undefined} style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {error ? `Could not read the setting: ${error}` : 'Checking…'}
        </p>
      </div>
    );
  }

  const who = state.verified && state.name
    ? `${state.name} — ${state.method === 'as_vouched' ? `${METHOD_LABEL.as_vouched} ${state.verifier}` : METHOD_LABEL[state.method ?? ''] ?? state.method}`
    : null;

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          {title}
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
            {state.always
              ? 'On: your verified name is attached to every mandate you give — including ones the setup AI proposes and you approve — and to the tickets under them.'
              : 'Off: each mandate asks whether to show your name. Mandates the setup AI proposes carry no name.'}
            {' '}Mandates already given stay as they are.
          </p>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
            {who ? `Your identity: ${who}.` : 'Your identity is not verified yet — no name can be shown until it is.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={state.always}
          className={state.always ? 'btn btn-secondary' : 'btn btn-primary'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {busy ? 'Saving…' : state.always ? 'Turn off' : 'Always show my name'}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--danger)' }}>{error}</p>
      )}
    </div>
  );
}
