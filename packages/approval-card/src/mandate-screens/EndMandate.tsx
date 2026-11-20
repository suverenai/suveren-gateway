/** Screen 4: End a mandate. Device-signed, final, no Touch ID. Shows what the gateway read from the owner's verified grant. */
import type { EndResult } from './interface';
import { S13 } from './texts';
import { WarnIcon } from '../components/WarnIcon';

export type EndState = { phase: 'confirm' } | { phase: 'busy' } | { phase: 'done' } | { phase: 'error'; code: Extract<EndResult, { ok: false }>['code'] };

export interface EndFacts {
  profileName: string;
  /** The verified limits, one row each (label and value text); may be empty. */
  limits: Array<{ label: string; value: string }>;
  /** Already formatted by the host from the grant's end time. */
  activeUntil: string | null;
}

export function endErrorText(code: Extract<EndResult, { ok: false }>['code']): string {
  return code === 'already_ended' ? S13.endAlready : code === 'unknown' ? S13.endUnknown : code === 'offline' ? S13.endOffline : S13.endOther;
}

export function EndMandate({ facts, state, onEnd, onKeep }: { facts: EndFacts; state: EndState; onEnd: () => void; onKeep: () => void }) {
  if (state.phase === 'done') return <p role="status" data-testid="end-done" className="msg-success">{S13.endDone(facts.profileName)}</p>;
  const busy = state.phase === 'busy';
  return (
    <div className="card" data-testid="end-mandate" style={{ maxWidth: 480 }}>
      <h3 className="card-title">{S13.endTitle}</h3>
      <strong>{S13.endNames(facts.profileName)}</strong>
      <dl style={{ margin: '0.75rem 0' }}>
        {facts.limits.map(l => <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}><dt>{l.label}</dt><dd style={{ margin: 0 }}>{l.value}</dd></div>)}
        {facts.activeUntil && <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}><dt>{S13.endActiveUntil}</dt><dd style={{ margin: 0 }}>{facts.activeUntil}</dd></div>}
      </dl>
      {/* UI review (DEC-88): what ending does is in a warning box; the safe option sits above the destructive one, which names what ends. */}
      <div className="warn-box" data-testid="end-warning">
        <WarnIcon />
        <div>
          <p>{S13.endAtOnce}</p>
          <p>{S13.endFinal}</p>
        </div>
      </div>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>{S13.endNoTouch}</p>
      {state.phase === 'error' && <p role="alert" data-testid="end-error" className="msg-error">{endErrorText(state.code)}</p>}
      <div className="btns-stack">
        <button type="button" className="btn btn-secondary" onClick={onKeep} disabled={busy} data-testid="end-keep">{S13.endKeep}</button>
        <button type="button" className="btn btn-outline-strong" onClick={onEnd} disabled={busy} data-testid="end-confirm">{S13.endButtonNamed(facts.profileName)}</button>
      </div>
    </div>
  );
}

