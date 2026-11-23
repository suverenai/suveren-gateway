/**
 * The one result stamp after a decision or a give (UI spec §17, DEC-86/88): it covers the whole card, the check mark, the word
 * and its line sit in the middle of the card's free area, and an optional full-width Close is pinned at the bottom. The card
 * around it must be positioned (`.av3-card`); a card that shows nothing but this result adds `.av3-given-alone` for a height.
 * Used by the give footers, the mandate change given on the phone and the dashboard passkey card, so every stamp sits the same.
 */
export function ResultStamp({ word, line, testId, stampTestId, close }: {
  word: string;
  line: string;
  testId?: string;
  stampTestId?: string;
  close?: { label: string; onClose: () => void; testId?: string };
}) {
  return (
    <div className="av3-given" data-testid={testId}>
      <div className="av3-stamp" role="status" data-testid={stampTestId}>
        <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
        <div className="av3-stamp-w">{word}</div>
        <div className="av3-stamp-t">{line}</div>
      </div>
      {close && (
        <footer className="av3-foot">
          <button type="button" className="av3-btn av3-btn-primary" style={{ width: '100%' }} onClick={close.onClose} data-testid={close.testId}>{close.label}</button>
        </footer>
      )}
    </div>
  );
}
