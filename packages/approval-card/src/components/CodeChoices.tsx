/** Three comparison codes to tap, one of them the real one (plan 20.11). Shared by the phone (it admits a computer) and the gateway page (a computer admits a phone). */
export function CodeChoices({ codes, onChoose, disabled }: { codes: string[]; onChoose: (code: string) => void; disabled?: boolean }) {
  // The choices appear when the other device is ready (DEC-96): the first one takes the focus so the page visibly asks for the tap.
  return (
    <div className="device-choices pair-attention" data-testid="code-choices">
      {codes.map((c, i) => (
        <button key={c} type="button" className="btn btn-secondary" data-testid="code-choice" onClick={() => onChoose(c)} disabled={disabled} autoFocus={i === 0}>{c}</button>
      ))}
    </div>
  );
}
