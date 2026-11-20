/**
 * Replace the recovery code on this phone (DEC-85, mockup D1–D5). The logic is lib/rotate-driver.ts; this file draws its states
 * with the gateway's components (frames, alerts, code box, form fields). The touch step is only "Waiting for your touch…" with
 * the gateway's spinner (Andreas, 2026-11-20).
 */
import { useState } from 'react';
import { CodeBlock } from '@suveren/approval-card/components/DeviceFrame';
import type { RotateState } from '../lib/rotate-driver';
import { P } from '../texts';
import { Notice, Screen, TouchWait } from './Frame';
import { ScanView } from './ScanView';

export interface RotateScreenProps {
  state: RotateState;
  onOld: (code: string) => void;
  onNew: (typed: string) => void;
  onCancel: () => void;
  /** Cancel while the touch is asked or after it failed: back to the new code. */
  onCancelTouch: () => void;
  onRetryTouch: () => void;
  onDone: () => void;
  /** Drawn with the scan view open (tests and screenshots). */
  scanning?: boolean;
}

export function RotateScreen(p: RotateScreenProps) {
  // Each step has its own fields: the old code typed on one step is never in the next step's field.
  return <Step key={p.state.step} {...p} />;
}

function Step({ state: st, onOld, onNew, onCancel, onCancelTouch, onRetryTouch, onDone, scanning }: RotateScreenProps) {
  const [scan, setScan] = useState(scanning === true);
  const [typed, setTyped] = useState('');
  switch (st.step) {
    case 'idle':
      return null;
    case 'old':
      return (
        <Screen title={P.rotateTitle}>
          <p>{P.rotateOldScan}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          {scan && !st.busy
            ? <ScanView onText={(t) => { setScan(false); onOld(t); }} onCancel={() => setScan(false)} />
            : <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => setScan(true)} disabled={st.busy}>{P.scanStart}</button>}
          <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onOld(typed.trim()); }}>
            <div className="form-group">
              <label className="form-label" htmlFor="old-code">{P.rotateOldLabel}</label>
              <input id="old-code" className="form-input" type="password" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                value={typed} onChange={(e) => setTyped(e.target.value)} disabled={st.busy} data-testid="old-code" />
            </div>
            <button type="submit" className="btn btn-secondary btn-full" disabled={st.busy || !typed.trim()}>{P.continue}</button>
          </form>
          <button type="button" className="btn btn-ghost btn-full" onClick={onCancel} disabled={st.busy}>{P.cancel}</button>
        </Screen>
      );
    case 'new':
      return (
        <Screen title={P.rotateNewTitle}>
          <CodeBlock code={st.code} testid="new-code" grouped={false} />
          <p>{P.rotateNewPaper}</p>
          <p>{P.codeNever}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <form onSubmit={(e) => { e.preventDefault(); onNew(typed); }}>
            <div className="form-group">
              <label className="form-label" htmlFor="new-code-again">{P.rotateNewAgain}</label>
              <input id="new-code-again" className="form-input" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="new-code-again" />
            </div>
            <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={!typed.trim()} data-testid="rotate-confirm">{P.rotateButton}</button>
          </form>
          <button type="button" className="btn btn-ghost btn-full" onClick={onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'checking':
      return (
        <Screen title={P.rotateNewTitle}>
          <TouchWait text={P.touchWait} error={st.error} onRetry={onRetryTouch} onCancel={onCancelTouch} retryLabel={P.tryAgain} cancelLabel={P.cancel} />
        </Screen>
      );
    case 'waiting':
      return (
        <Screen title={P.rotateTitle}>
          <p>{P.rotateEmail(st.email)}</p>
          <p>{P.rotateCompare}</p>
          <CodeBlock code={st.confirmCode} testid="rotate-confirm-code" grouped={false} />
          <Notice kind="info">{P.rotateWaiting}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'done':
      return (
        <Screen title={P.rotateTitle}>
          <Notice kind="success">{P.rotateDone}</Notice>
          <p>{P.rotateThrowAway}</p>
          <button type="button" className="btn btn-primary btn-full" onClick={onDone}>{P.rotateGoDevices}</button>
        </Screen>
      );
    case 'failed':
      return (
        <Screen title={P.rotateTitle}>
          <Notice kind="error">{st.error}</Notice>
          <button type="button" className="btn btn-primary btn-full" onClick={onDone}>{P.back}</button>
        </Screen>
      );
  }
}
