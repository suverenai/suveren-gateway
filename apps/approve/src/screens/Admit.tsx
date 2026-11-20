import type { AdmitState } from '../lib/admit-driver';
import { P } from '../texts';
import { DeviceList } from './Devices';
import { CodeChoices } from '@suveren/approval-card/components/CodeChoices';
import { Notice, Screen } from './Frame';
import { ScanView } from './ScanView';
import { useState } from 'react';

export interface AdmitScreenProps {
  state: AdmitState;
  nowSeconds: number;
  onScanned: (text: string) => void;
  onChoose: (code: string) => void;
  onCancel: () => void;
  onDone: () => void;
  scanning?: boolean;
}

/** This phone adds a computer: scan its code, tap the code it shows, the phone's touch, the new list. */
export function AdmitScreen(p: AdmitScreenProps) {
  const [scan, setScan] = useState(p.scanning === true);
  const st = p.state;
  switch (st.step) {
    case 'scan':
      return (
        <Screen title={P.admitTitle}>
          <p>{P.admitScanWhy}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          {st.busy && <Notice kind="info">{P.setupChecking}</Notice>}
          {scan && !st.busy
            ? <ScanView onText={(t) => { setScan(false); p.onScanned(t); }} onCancel={() => setScan(false)} />
            : <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => setScan(true)} disabled={st.busy}>{P.scanStart}</button>}
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onDone}>{P.back}</button>
        </Screen>
      );
    case 'opening':
      return (
        <Screen title={P.admitTitle}>
          <Notice kind="info">{P.admitOpening}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'choose':
      return (
        <Screen title={P.admitChooseTitle(st.choice.label)}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div data-testid="other-ready"><Notice kind="success">{P.otherReady}</Notice></div>
          <p>{P.admitChooseBody}</p>
          <CodeChoices codes={st.choice.codes} onChoose={p.onChoose} />
          <p>{P.admitListTitle}</p>
          <DeviceList rows={st.choice.rows} nowSeconds={p.nowSeconds} />
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'checking':
      return (
        <Screen title={P.admitTitle}>
          <Notice kind="info">{P.admitChecking}</Notice>
        </Screen>
      );
    case 'failed':
      return (
        <Screen title={P.admitTitle}>
          <Notice kind="error">{st.error}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCancel}>{P.startAgain}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onDone}>{P.back}</button>
        </Screen>
      );
    case 'done':
      return (
        <Screen title={P.admitDoneTitle(st.label)}>
          <Notice kind="success">{P.admitAfter}</Notice>
          <p>{P.admitDoneList}</p>
          <DeviceList rows={st.rows} nowSeconds={p.nowSeconds} />
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{P.continue}</button>
        </Screen>
      );
  }
}
