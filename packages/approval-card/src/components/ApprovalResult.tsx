/**
 * The results of a decision that stay on the card (UI review, DEC-88; mockup phone-d3-live.html v6): one implementation for the
 * gateway page and the phone. A refusal, or an outcome that is not known, is not a stamp over the card: it sits on TOP of the card,
 * the card stays readable below it, and one full-width button is pinned at the bottom ("Next" / "Close"); for "not known",
 * "Check again" is the primary button and shows "Checking…" while it reads. The stamp of a result that times away names what
 * opens next. Pure: a piece is its props.
 */
import type { ReactNode } from 'react';
import type { IntegrationManifest, Proposal } from '../types';
import { RefusalResult } from './RefusalResult';
import { WarnIcon } from './WarnIcon';

// DRAFT texts (UI review, DEC-88).
export const RESULT_TEXT = {
  checkAgain: 'Check again',
  checking: 'Checking…',
  checkedStillUnknown: 'Still not known. Checked just now.',
  nextPrefix: 'Next: ',
};

export function RefusedTop({ proposal, manifests }: { proposal: Proposal; manifests?: IntegrationManifest[] }) {
  return (
    <div className="res-top" style={{ order: -1 }} data-testid="decision-refused">
      <RefusalResult proposal={proposal} manifests={manifests} />
    </div>
  );
}

export function UnknownTop({ word, line }: { word: string; line: string }) {
  return (
    <div className="res-top" style={{ order: -1 }} role="status" data-testid="decision-unknown">
      <div className="refusal-result">
        <WarnIcon />
        <div>
          <div className="refusal-result-w">{word}</div>
          <div className="refusal-result-m">{line}</div>
        </div>
      </div>
    </div>
  );
}

/** A give that did not go through (refused, stopped, a touch that failed): the reason at the top of the card, the mandate stays readable below (DEC-88). */
export function GiveProblemTop({ text }: { text: string }) {
  return (
    <div className="res-top" style={{ order: -1 }} role="alert" data-testid="card-give-refused">
      <div className="refusal-result">
        <WarnIcon />
        <div><div className="refusal-result-w">{text}</div></div>
      </div>
    </div>
  );
}

/** The pinned footer of a result that stays. `dismiss` is the host's "Next" / "Close" (absent where the host has none). */
export function ResultFoot({ check, dismiss }: {
  /** Only for an outcome that is not known: read it again. */
  check?: { busy: boolean; checkedOnce: boolean; onCheck: () => void } | null;
  dismiss?: { label: string; onDismiss: () => void } | null;
}) {
  if (!check && !dismiss) return null;
  return (
    <footer className="av3-foot" data-testid="result-foot">
      {check?.checkedOnce && !check.busy && <p className="res-check" role="status" data-testid="check-result">{RESULT_TEXT.checkedStillUnknown}</p>}
      <div className="av3-btns-stack">
        {check && (
          <button type="button" className="av3-btn av3-btn-primary" data-testid="result-check" onClick={check.onCheck} disabled={check.busy}>
            {check.busy ? <><span className="av3-spin av3-spin-inline" aria-hidden="true" />{RESULT_TEXT.checking}</> : RESULT_TEXT.checkAgain}
          </button>
        )}
        {dismiss && (
          <button type="button" className={`av3-btn${check ? '' : ' av3-btn-primary'}`} data-testid="result-dismiss" onClick={dismiss.onDismiss} disabled={check?.busy}>
            {dismiss.label}
          </button>
        )}
      </div>
    </footer>
  );
}

/** Under the stamp of a result that times away: what opens next. */
export function StampNext({ children }: { children: ReactNode }) {
  return <div className="stamp-next" data-testid="stamp-next">{RESULT_TEXT.nextPrefix}{children}</div>;
}
