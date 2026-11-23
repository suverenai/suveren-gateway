/**
 * The give page's footer for a give with Touch ID on this computer (DEC-80; result as DEC-86/88): never a silent wait.
 *   offered  → "Give this mandate with Touch ID" (and Back)
 *   touch    → one line with the spinner: "Waiting for your touch…" (the system's own window has the Cancel)
 *   working  → one line with the spinner, the step the gateway reports: signing, sending to suveren.ai, getting it ready here
 *   given    → the gateway's result stamp (check mark, "Signed", "Recorded") and one full-width "Close"
 * A refusal stays on the page as today's error above the footer and brings the offer back. Presentational: the host drives it.
 */
import { S13 } from './texts';
import { ResultStamp } from '../components/ResultStamp';

export type GiveStage = 'touched' | 'requesting' | 'delivering';
export type GiveTouchView =
  | { s: 'offered' }
  | { s: 'touch' }
  | { s: 'working'; stage: GiveStage }
  | { s: 'given' };

export function giveStageText(stage: GiveStage): string {
  return stage === 'touched' ? S13.giveWorkingSigning : stage === 'requesting' ? S13.giveWorkingSending : S13.giveWorkingDelivering;
}

/** A progress word from the gateway moves the view forward only (a late or repeated signal never moves it back). */
export function afterProgress(view: GiveTouchView, stage: unknown): GiveTouchView {
  if (stage !== 'touched' && stage !== 'requesting' && stage !== 'delivering') return view;
  const order: GiveStage[] = ['touched', 'requesting', 'delivering'];
  if (view.s === 'touch') return { s: 'working', stage };
  if (view.s === 'working' && order.indexOf(stage) > order.indexOf(view.stage)) return { s: 'working', stage };
  return view;
}

export function GiveTouchFooter({ view, onGive, onBack, onClose, disabled }: {
  view: GiveTouchView;
  onGive: () => void;
  onBack: () => void;
  onClose: () => void;
  /** The give is not possible yet (no title, a block, …). */
  disabled?: boolean;
}) {
  if (view.s === 'given') {
    // The stamp fills the card's free area above the pinned Close and sits in its middle (UI spec §17: the stamp over
    // the faded card). It was in the normal flow under the hidden card body, so on a tall card it sat at the bottom.
    return (
      <ResultStamp word={S13.giveSigned} line={S13.giveRecorded} testId="give-touch-given" stampTestId="give-touch-stamp"
        close={{ label: S13.giveResultClose, onClose, testId: 'give-touch-close' }} />
    );
  }
  if (view.s === 'touch' || view.s === 'working') {
    const line = view.s === 'touch' ? S13.giveBusy : giveStageText(view.stage);
    return (
      <footer className="av3-foot" data-testid="give-touch-busy">
        <div className="av3-stamp-wait" role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44 }}>
          <span className="av3-spin" aria-hidden="true" />{line}
        </div>
      </footer>
    );
  }
  return (
    <footer className="av3-foot" data-testid="give-touch">
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={onGive} disabled={disabled} data-testid="give-touch-button">{S13.giveButton}</button>
      </div>
    </footer>
  );
}
