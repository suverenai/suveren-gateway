/**
 * A computer's change to a connector login, confirmed on this phone (stage D3; mockup E1–E3 as approved, DEC-86 and the note of
 * 2026-11-20). The gateway's card, classes and result: the middle scrolls (`av3-scroll`), the buttons stay at the bottom
 * (`av3-foot`), after the touch "Confirming…", then the gateway's stamp (check mark, "Confirmed", "Recorded", "Next: …" while
 * the next one opens). "Not allowed" and "Run out" are alerts with ONE full-width pinned button (Next or Close). Old values of a
 * field the manifest declares `text` are crossed out as on the gateway (`mc-old` → `mc-new`); a secret field shows no value.
 */
import { useEffect, useState } from 'react';
import type { ChangeCardState, ChangeItem } from '../lib/change-requests';
import { P } from '../texts';
import { TouchWait } from './Frame';

export function changeTitle(item: ChangeItem): string {
  const r = item.view.request;
  return r.kind === 'remove' ? P.changeRemoveTitle(item.view.connector) : P.changeReplaceTitle(item.view.connector);
}

function mmss(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface ChangeCardProps {
  item: ChangeItem;
  state: ChangeCardState;
  /** Epoch seconds, ticking (the time left). */
  nowSeconds: number;
  onConfirm: () => void;
  onDeny: () => void;
  onCancelTouch: () => void;
  /** The pinned button after "Not allowed", "Run out" or a failure: Next or Close. */
  dismissLabel: string;
  onDismiss: () => void;
  /** The title of the next waiting item, shown under the stamp while it opens. */
  nextTitle?: string | null;
}

export function ChangeCard({ item, state: st, nowSeconds, onConfirm, onDeny, onCancelTouch, dismissLabel, onDismiss, nextTitle }: ChangeCardProps) {
  const v = item.view;
  const busy = st.step === 'sending' || st.step === 'confirmed';
  const left = item.expiresAt - nowSeconds;
  const over = st.step === 'denied' || st.step === 'expired' || st.step === 'failed';
  return (
    <div className={`card av3-card${busy ? ' av3-busy' : ''}`} data-testid="change-card" data-request-id={item.requestId} data-phase={st.step}>
      <div className="av3-scroll">
        <article className="av3-body" aria-hidden={busy || undefined}>
          <h2 className="av3-title" data-testid="change-title">{P.changeConfirmTitle}</h2>
          <p className="av3-quiet" data-testid="change-asked-by">{P.changeAskedBy(item.gatewayLabel)}</p>
          <p data-testid="change-sentence">
            <strong>{changeTitle(item)}.</strong>{' '}
            {v.request.kind === 'remove' ? P.changeRemoveEffect(v.connector) : P.changeReplaceEffect}
          </p>
          {v.request.kind === 'replace' && v.fields.length > 0 && (
            <div data-testid="change-fields">
              {v.fields.map((f) => (
                <div className="mc-row" key={f.key} data-testid="change-row" data-field={f.key}>
                  <span className="mc-name">{f.label ?? f.key}</span>
                  <span className="mc-val">
                    {f.secret || f.new === undefined
                      ? <span className="mc-new">{P.changeFieldSecret}</span>
                      : <>{f.old !== undefined && <><span className="mc-old">{f.old}</span><span className="mc-arrow">→</span></>}<span className="mc-new">{f.new}</span></>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p>{P.changeScope}</p>
          {!over && st.step !== 'confirmed' && <p className="form-hint" data-testid="change-time-left">{P.changeRunsOut(mmss(left))}</p>}
        </article>
      </div>

      {st.step === 'idle' && (
        <footer className="av3-foot">
          <div className="av3-btns av3-btns-two">
            <button type="button" className="av3-btn av3-btn-primary" data-testid="change-confirm" onClick={onConfirm}>{P.changeConfirmButton}</button>
            <button type="button" className="av3-btn" data-testid="change-deny" onClick={onDeny}>{P.changeDeny}</button>
          </div>
        </footer>
      )}
      {st.step === 'touch' && (
        <footer className="av3-foot">
          <TouchWait text={P.touchWait} error={st.error} onRetry={onConfirm} onCancel={onCancelTouch} retryLabel={P.tryAgain} cancelLabel={P.cancel} />
        </footer>
      )}
      {st.step === 'sending' && (
        <div className="av3-stamp av3-stamp-wait" role="status" data-testid="change-sending">
          <span className="av3-spin" aria-hidden="true" />
          {st.decision === 'allow' ? P.changeConfirming : P.doSend}
        </div>
      )}
      {st.step === 'confirmed' && (
        <div className="av3-stamp" role="status" data-testid="change-stamp">
          <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div className="av3-stamp-w">{P.changeConfirmed}</div>
          <div className="av3-stamp-t">{P.changeRecorded}</div>
          {nextTitle && <div className="av3-next" data-testid="change-next">{P.changeNext(nextTitle)}</div>}
        </div>
      )}
      {over && (
        <footer className="av3-foot" data-testid="change-over">
          <div className={`alert ${st.step === 'denied' ? 'alert-info' : 'alert-error'}`} role="alert" data-testid={`change-${st.step}`}>
            {st.step === 'denied' ? P.changeNotAllowed(item.gatewayLabel, v.connector) : st.step === 'expired' ? P.changeExpired : st.error}
          </div>
          <button type="button" className="av3-btn av3-btn-primary btn-full" data-testid="change-dismiss" onClick={onDismiss}>{dismissLabel}</button>
        </footer>
      )}
    </div>
  );
}

/** The seconds clock for the time left, ticking once a second while a card is open. */
export function useNowSeconds(now: () => number): number {
  const [t, setT] = useState(now());
  useEffect(() => {
    const id = window.setInterval(() => setT(now()), 1000);
    return () => window.clearInterval(id);
  }, [now]);
  return t;
}
