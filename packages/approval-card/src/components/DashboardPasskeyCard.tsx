/**
 * A passkey for the suveren.ai dashboard, approved on one of the person's devices (AS step 17, the device side; plan 6.4 point 3).
 * One implementation for the gateway page and the phone app (DEC-84), in the approval look (DEC-86/88): the whole request on one
 * screen, the decision button pinned at the bottom, "… with your touch", one line with the spinner while the touch is asked and
 * while it is sent, then the result stamp. Presentational: the host drives it.
 *
 * What is shown is only what the Authority Server listed for this account: the six-digit code the dashboard shows beside the
 * request (the person compares the two), when the passkey was made, until when it can be approved, and the account. Nothing the
 * dashboard or an AI writes reaches this screen.
 */
export const PASSKEY_TEXT = {
  // DRAFT
  title: 'Add a passkey for your dashboard',
  // DRAFT
  lead: 'Your dashboard on suveren.ai made a passkey. Approve it only if you did that just now and the dashboard shows this code:',
  // DRAFT
  account: 'Account',
  // DRAFT
  made: 'Made',
  // DRAFT
  before: 'Approve before',
  // DRAFT
  what: 'With this passkey you sign in to your dashboard without your API key. It works as long as this device stays one of your devices.',
  // DRAFT
  button: 'Approve with your touch',
  // DRAFT
  waiting: 'Waiting for your touch…',
  // DRAFT
  sending: 'Sending to suveren.ai…',
  // DRAFT
  cancel: 'Cancel',
  // DRAFT
  added: 'Added',
  // DRAFT
  addedLine: 'You can sign in to your dashboard with it now.',
  // DRAFT
  close: 'Close',
  // DRAFT
  noCheck: 'This computer has no Touch ID key. Approve this passkey on your phone.',
  // DRAFT — the banner/row that leads to the card
  waitingRow: 'A passkey for your dashboard waits for your approval',
  // DRAFT
  open: 'Look at it',
  // DRAFT — refusals
  gone: 'This passkey request is no longer waiting. Make the passkey again on the dashboard.',
  touchFailed: 'Your touch did not work. Nothing changed. Try again.',
  failed: 'suveren.ai did not add the passkey. Nothing changed. Try again.',
} as const;

export interface PasskeyRequestView {
  code: string;
  email: string;
  /** Epoch seconds. */
  credentialAt: number;
  expiresAt: number;
}

export type PasskeyCardView =
  | { s: 'offered'; error?: string }
  | { s: 'touch' }
  | { s: 'sending' }
  | { s: 'added' };

const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function DashboardPasskeyCard({ request, view, canApprove, onApprove, onCancel, onClose }: {
  request: PasskeyRequestView;
  view: PasskeyCardView;
  /** False on a device that cannot approve (a computer without a Touch ID key): the button is replaced by the hint. */
  canApprove: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  if (view.s === 'added') {
    return (
      <div className="av3-card" data-testid="passkey-card-added">
        <div className="av3-stamp" role="status" style={{ position: 'static' }}>
          <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div className="av3-stamp-w">{PASSKEY_TEXT.added}</div>
          <div className="av3-stamp-t">{PASSKEY_TEXT.addedLine}</div>
        </div>
        <footer className="av3-foot">
          <button type="button" className="av3-btn av3-btn-primary" style={{ width: '100%' }} onClick={onClose} data-testid="passkey-close">{PASSKEY_TEXT.close}</button>
        </footer>
      </div>
    );
  }
  const busy = view.s === 'touch' || view.s === 'sending';
  return (
    <div className="av3-card" data-testid="passkey-card">
      <div className="av3-scroll">
        <article className="av3-body">
          <h2 className="av3-title">{PASSKEY_TEXT.title}</h2>
          <p>{PASSKEY_TEXT.lead}</p>
          <p data-testid="passkey-card-code" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '2rem', letterSpacing: '0.12em', margin: '0.5rem 0 1rem' }}>
            {request.code.slice(0, 3)} {request.code.slice(3)}
          </p>
          <dl className="info-kv">
            <dt>{PASSKEY_TEXT.account}</dt><dd data-testid="passkey-card-account">{request.email}</dd>
            <dt>{PASSKEY_TEXT.made}</dt><dd>{time(request.credentialAt)}</dd>
            <dt>{PASSKEY_TEXT.before}</dt><dd>{time(request.expiresAt)}</dd>
          </dl>
          <p className="form-hint">{PASSKEY_TEXT.what}</p>
        </article>
      </div>
      {view.s === 'offered' && view.error && <p className="av3-error" role="alert" data-testid="passkey-card-error">{view.error}</p>}
      <footer className="av3-foot" data-testid={busy ? 'passkey-card-busy' : 'passkey-card-foot'}>
        {busy ? (
          <>
            <div className="av3-stamp-wait" role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44 }}>
              <span className="av3-spin" aria-hidden="true" />{view.s === 'touch' ? PASSKEY_TEXT.waiting : PASSKEY_TEXT.sending}
            </div>
            {view.s === 'touch' && (
              <button type="button" className="btn btn-ghost btn-full" style={{ minHeight: 44 }} onClick={onCancel} data-testid="passkey-cancel">{PASSKEY_TEXT.cancel}</button>
            )}
          </>
        ) : canApprove ? (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-ghost" style={{ minHeight: 44 }} onClick={onClose}>{PASSKEY_TEXT.close}</button>
            <button type="button" className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={onApprove} data-testid="passkey-approve">{PASSKEY_TEXT.button}</button>
          </div>
        ) : (
          <>
            <p className="form-hint" data-testid="passkey-no-check">{PASSKEY_TEXT.noCheck}</p>
            <button type="button" className="btn btn-ghost btn-full" style={{ minHeight: 44 }} onClick={onClose}>{PASSKEY_TEXT.close}</button>
          </>
        )}
      </footer>
    </div>
  );
}

/** The refusal codes of either device, in words. */
export function passkeyRefusalText(code: string): string {
  if (code === 'passkey_request_gone' || code === 'PASSKEY_REQUEST_EXPIRED' || code === 'PASSKEY_REQUEST_USED' || code === 'NOT_FOUND') return PASSKEY_TEXT.gone;
  if (code === 'check_failed' || code === 'failed' || code === 'cancelled') return PASSKEY_TEXT.touchFailed;
  return PASSKEY_TEXT.failed;
}
