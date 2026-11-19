/** Three comparison codes to tap, one of them the real one (plan 20.11). Shared by the phone (it admits a computer) and the gateway page (a computer admits a phone). */
export function CodeChoices({ codes, onChoose, disabled }: { codes: string[]; onChoose: (code: string) => void; disabled?: boolean }) {
  return (
    <div className="device-choices" data-testid="code-choices">
      {codes.map(c => (
        <button key={c} type="button" className="btn btn-secondary" data-testid="code-choice" onClick={() => onChoose(c)} disabled={disabled}>{c}</button>
      ))}
    </div>
  );
}
