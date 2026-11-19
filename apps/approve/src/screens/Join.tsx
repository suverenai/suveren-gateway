import { useState } from 'react';
import type { JoinState } from '../lib/join-driver';
import { P } from '../texts';
import { DeviceList } from './Devices';
import { Notice, Screen, whenText } from './Frame';
import { ScanView } from './ScanView';

export interface JoinScreenProps {
  state: JoinState;
  nowSeconds: number;
  onScanned: (text: string) => void;
  onReviewConfirm: () => void;
  onName: (label: string) => void;
  onCancel: () => void;
  onDone: () => void;
  /** Drawn with the scan view open (tests and screenshots). */
  scanning?: boolean;
  /** A way back to a start screen with another choice (only while phone-first setup is on, DEC-83). */
  canGoBack?: boolean;
}

const DOING: Record<'keys' | 'passkey' | 'sign' | 'check' | 'send', string> = {
  keys: P.doKeys, passkey: P.doPasskey, sign: P.doSign, check: P.doCheck, send: P.doSend,
};

/** This phone joins an account that exists: scan, review who it joins, name, compare the code, done. */
export function JoinScreen(p: JoinScreenProps) {
  const [label, setLabel] = useState('');
  const [scan, setScan] = useState(p.scanning === true);
  const st = p.state;
  switch (st.step) {
    case 'scan':
      return (
        <Screen title={P.joinTitle}>
          <p>{P.joinIntro}</p>
          <p>{P.joinScanWhy}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          {st.busy && <Notice kind="info">{P.setupChecking}</Notice>}
          {scan && !st.busy
            ? <ScanView onText={(t) => { setScan(false); p.onScanned(t); }} onCancel={() => setScan(false)} />
            : <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => setScan(true)} disabled={st.busy}>{P.scanStart}</button>}
          {p.canGoBack && <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.back}</button>}
        </Screen>
      );
    case 'review':
      return (
        <Screen title={P.reviewTitle}>
          <div style={{ color: 'var(--text-secondary)' }}>{P.reviewIdentity}</div>
          <div className="ap-code" data-testid="review-identity">{st.facts.identityCode}</div>
          <p>{P.reviewIdentityNote}</p>
          {st.facts.origin && <p data-testid="review-made">{P.reviewMade(st.facts.origin.label, whenText(st.facts.origin.at, p.nowSeconds))}</p>}
          <p>{P.reviewDevices}</p>
          <DeviceList rows={st.facts.devices} nowSeconds={p.nowSeconds} />
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onReviewConfirm}>{P.reviewButton}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.reviewNotMine}</button>
        </Screen>
      );
    case 'name':
      return (
        <Screen title={P.nameTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div className="form-group" style={{ marginBottom: 'var(--space-6)' }}>
            <label className="form-label" htmlFor="join-name">{P.nameLabel}</label>
            <input id="join-name" className="form-input" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} disabled={st.busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) p.onName(label); }} />
            <div className="form-hint">{P.nameHint}</div>
          </div>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => p.onName(label)} disabled={st.busy || !label.trim()}>{P.nameButton}</button>
        </Screen>
      );
    case 'working':
      return (
        <Screen title={P.joinTitle}>
          <Notice kind="info">{DOING[st.doing]}</Notice>
        </Screen>
      );
    case 'waiting':
      return (
        <Screen title={P.compareTitle}>
          <Notice kind="info">{P.compareWaiting(st.admitterLabel)}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'compare':
      return (
        <Screen title={P.compareTitle}>
          <div className="ap-code" data-testid="compare-code">{st.code}</div>
          <p>{P.compareBody(st.admitterLabel)}</p>
          <Notice kind="info">{P.compareWaiting(st.admitterLabel)}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'failed':
      return (
        <Screen title={P.joinTitle}>
          <Notice kind="error">{st.error}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCancel}>{P.startAgain}</button>
        </Screen>
      );
    case 'done':
      return (
        <Screen title={P.joinDoneTitle}>
          <Notice kind="success">{P.setupDoneBody}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{P.continue}</button>
        </Screen>
      );
  }
}
