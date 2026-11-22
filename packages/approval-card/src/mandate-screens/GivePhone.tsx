/**
 * "Give on your phone" (DEC-90; mockup phone-d3-live.html v7, Gateway view): the give page's footer on a computer without Touch ID.
 * The page and the card stay as they are; only this footer changes. Five states: offered, waiting, given (the gateway's own result
 * stamp), stopped, refused. Presentational: the host drives the state (apps/ui/src/lib/give-on-phone-flow.ts).
 */
import { S13 } from './texts';
import { ResultStamp } from '../components/ResultStamp';

export type GivePhoneView =
  | { s: 'offered' }
  | { s: 'sending' }
  | { s: 'waiting' }
  | { s: 'given' }
  | { s: 'stopped' }
  | { s: 'refused'; message: string };

export function GivePhoneFooter({ view, onGive, onStop, onClose, disabled }: {
  view: GivePhoneView;
  onGive: () => void;
  onStop: () => void;
  onClose: () => void;
  /** The give itself is not possible yet (no title, no duration, …): the offer is shown but cannot be sent. */
  disabled?: boolean;
}) {
  if (view.s === 'given') {
    // The shared result stamp over the whole card, centred above the pinned Close (UI spec §17), as after a give with Touch ID.
    return (
      <ResultStamp word={S13.givePhoneGiven} line={S13.givePhoneGivenOn} testId="give-phone-given" stampTestId="give-phone-stamp"
        close={{ label: S13.endClose, onClose, testId: 'give-phone-done' }} />
    );
  }
  return (
    <footer className="av3-foot" data-testid="give-phone">
      {(view.s === 'offered' || view.s === 'sending') && (
        <>
          <p className="form-hint" style={{ margin: '0 0 var(--space-2)' }}>{S13.givePhoneOffer}</p>
          <div className="av3-btns av3-btns-give">
            <button type="button" className="av3-btn av3-btn-primary" onClick={onGive} disabled={disabled || view.s === 'sending'} data-testid="give-phone-send">{S13.givePhoneButton}</button>
            <button type="button" className="av3-btn" onClick={onClose} disabled={view.s === 'sending'} data-testid="give-phone-cancel">{S13.givePhoneCancel}</button>
          </div>
        </>
      )}
      {view.s === 'waiting' && (
        <>
          <div className="av3-stamp-wait" role="status" data-testid="give-phone-waiting" style={{ display: 'flex', alignItems: 'center' }}><span className="av3-spin" aria-hidden="true" />{S13.givePhoneWaiting}</div>
          <p className="form-hint" style={{ margin: 'var(--space-2) 0' }}>{S13.givePhoneWaitingNote}</p>
          <div className="av3-btns">
            <button type="button" className="av3-btn" onClick={onStop} data-testid="give-phone-stop">{S13.givePhoneStop}</button>
          </div>
        </>
      )}
      {view.s === 'stopped' && (
        <>
          <div className="alert alert-info" role="status" style={{ margin: '0 0 var(--space-2)' }} data-testid="give-phone-stopped">{S13.givePhoneStopped}</div>
          <div className="av3-btns av3-btns-two">
            <button type="button" className="av3-btn av3-btn-primary" onClick={onGive} disabled={disabled} data-testid="give-phone-again">{S13.givePhoneAgain}</button>
            <button type="button" className="av3-btn" onClick={onClose} data-testid="give-phone-close">{S13.givePhoneClose}</button>
          </div>
        </>
      )}
      {view.s === 'refused' && (
        <>
          <div className="alert alert-error" role="alert" style={{ margin: '0 0 var(--space-2)' }} data-testid="give-phone-refused">{view.message}</div>
          <div className="av3-btns">
            <button type="button" className="av3-btn av3-btn-primary" onClick={onClose} data-testid="give-phone-close">{S13.givePhoneClose}</button>
          </div>
        </>
      )}
    </footer>
  );
}

/** The refusal text for the footer: a grant that does not match what this page prepared has its own sentence; anything else the give's own. */
export function givePhoneRefusalText(code: string | undefined, fallback: string): string {
  return code === 'grant_invalid' || code === 'changed_since_prepare' ? S13.givePhoneMismatch : fallback;
}
