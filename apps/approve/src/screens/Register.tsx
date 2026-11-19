import { useEffect, useMemo, useState } from 'react';
import type { RegisterState } from '../lib/register-driver';
import { qrMatrix } from '../lib/qr-matrix';
import { P } from '../texts';
import { Notice, Screen } from './Frame';
import { ScanView } from './ScanView';

export interface RegisterScreenProps {
  state: RegisterState;
  /** The recovery code, for the one screen that shows it. */
  code: string | null;
  onCode: (text: string) => void;
  onName: (label: string) => void;
  onCodeSeen: () => void;
  onKept: (checked: boolean) => void;
  onFinish: () => void;
  onCancel: () => void;
  onDone: () => void;
  /** Drawn with the scan view already open (tests and screenshots). */
  scanning?: boolean;
}

/** While a recovery code is on screen, printing prints only the code (same rule as the gateway page). */
function PrintScope() {
  useEffect(() => {
    document.body.classList.add('print-recovery-code');
    return () => document.body.classList.remove('print-recovery-code');
  }, []);
  return null;
}

/** The recovery code as a QR code: SVG rects, so no image and no inline style. */
export function RecoveryQr({ text }: { text: string }) {
  const rows = useMemo(() => qrMatrix(text), [text]);
  const quiet = 4;
  const size = rows.length + quiet * 2;
  return (
    <svg className="ap-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={P.codeTitle} data-testid="recovery-qr" shapeRendering="crispEdges">
      {rows.flatMap((row, r) => row.map((dark, c) => (dark ? <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} /> : null)))}
    </svg>
  );
}

const DOING: Record<'keys' | 'passkey' | 'sign' | 'check' | 'send', string> = {
  keys: P.doKeys, passkey: P.doPasskey, sign: P.doSign, check: P.doCheck, send: P.doSend,
};

/** Register this phone as the first device of a new identity: code, name, recovery code, kept, working, done. */
export function RegisterScreen(p: RegisterScreenProps) {
  const [typed, setTyped] = useState('');
  const [label, setLabel] = useState('');
  const [scan, setScan] = useState(p.scanning === true);
  const st = p.state;

  switch (st.step) {
    case 'code':
      return (
        <Screen title={P.setupTitle}>
          <p>{P.setupCodeWhy}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          {st.busy && <Notice kind="info">{P.setupChecking}</Notice>}
          {scan ? (
            <ScanView onText={(t) => { setScan(false); p.onCode(t); }} onCancel={() => setScan(false)} />
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => setScan(true)} disabled={st.busy}>{P.scanStart}</button>
              <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) p.onCode(typed); }}>
                <div className="form-group" style={{ marginTop: 'var(--space-6)' }}>
                  <label className="form-label" htmlFor="setup-code">{P.setupCodeLabel}</label>
                  <input id="setup-code" className="form-input" type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
                    data-1p-ignore="true" data-lpignore="true" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={st.busy} />
                </div>
                <button type="submit" className="btn btn-secondary btn-full" disabled={st.busy || !typed.trim()}>{P.setupCodeButton}</button>
              </form>
            </>
          )}
        </Screen>
      );
    case 'name':
      return (
        <Screen title={P.nameTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div className="form-group" style={{ marginBottom: 'var(--space-6)' }}>
            <label className="form-label" htmlFor="phone-name">{P.nameLabel}</label>
            <input id="phone-name" className="form-input" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} disabled={st.busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) p.onName(label); }} />
            <div className="form-hint">{P.nameHint}</div>
          </div>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => p.onName(label)} disabled={st.busy || !label.trim()}>{P.nameButton}</button>
        </Screen>
      );
    case 'sheet':
      return (
        <Screen title={P.codeTitle}>
          <PrintScope />
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <p>{P.codeWhy}</p>
          <div className="recovery-code-print">
            <div className="recovery-code" data-testid="recovery-code">{p.code ?? ''}</div>
            {p.code && <RecoveryQr text={p.code} />}
          </div>
          <p><strong>{P.codeOnce}</strong></p>
          <p>{P.codePaper}</p>
          <p style={{ fontSize: 'var(--text-body-sm)' }}>{P.codeNever}</p>
          <button type="button" className="btn btn-secondary btn-full" onClick={() => window.print()}>{P.codePrint}</button>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCodeSeen}>{P.codeContinue}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.codeCancel}</button>
        </Screen>
      );
    case 'kept':
      return (
        <Screen title={P.keptTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <label className="device-check">
            <input type="checkbox" checked={st.checked} onChange={(e) => p.onKept(e.target.checked)} />
            <span>{P.keptBox}</span>
          </label>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onFinish} disabled={!st.checked}>{P.keptButton}</button>
        </Screen>
      );
    case 'working':
      return (
        <Screen title={P.setupTitle}>
          <Notice kind="info">{DOING[st.doing]}</Notice>
        </Screen>
      );
    case 'failed':
      return (
        <Screen title={P.setupTitle}>
          <Notice kind="error">{st.error}</Notice>
          {st.canRetry
            ? <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onFinish}>{P.tryAgain}</button>
            : <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCancel}>{P.startAgain}</button>}
        </Screen>
      );
    case 'done':
      return (
        <Screen title={P.setupDoneTitle}>
          <Notice kind="success">{P.setupDoneBody}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{P.continue}</button>
        </Screen>
      );
  }
}

