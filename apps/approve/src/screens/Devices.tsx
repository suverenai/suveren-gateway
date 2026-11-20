import { CodeBlock } from '@suveren/approval-card/components/DeviceFrame';
import { TileList, TileRow } from '@suveren/approval-card/components/TileRows';
import type { DeviceRow } from '../lib/chain-view';
import type { PushState } from '../lib/push';
import { P } from '../texts';
import { Notice, whenText } from './Frame';

/** The list of devices, from a chain this phone verified itself: the gateway's member rows (TileList), one per device. Labels are plain text. */
export function DeviceList({ rows, nowSeconds }: { rows: Array<DeviceRow & { adding?: boolean }>; nowSeconds: number }) {
  return (
    <TileList testid="device-list">
      {rows.map((r) => (
        <TileRow
          key={r.keyId}
          testid="device-row"
          mark={(r.label.trim()[0] ?? '?').toUpperCase()}
          name={r.label}
          detail={[
            r.kind === 'gateway' ? P.devKindComputer : P.devKindPhone,
            r.canGrant ? P.devCanConfirm : null,
            r.adding ? null : P.devAdded(whenText(r.addedAt, nowSeconds)),
            r.recent && !r.adding ? P.devRecent : null,
          ].filter(Boolean).join(' · ')}
          tag={r.adding ? P.admitNew : r.thisDevice ? P.devThisPhone : undefined}
          strongTag
        />
      ))}
    </TileList>
  );
}

export interface DevicesScreenProps {
  rows: DeviceRow[];
  /** 24 digits in 6 groups of 4. */
  identityCode: string | null;
  nowSeconds: number;
  persistent: boolean | null;
  updated: boolean;
  version: string;
  build: string;
  onAddComputer: () => void;
  onRefresh: () => void;
  busy?: boolean;
  error?: string;
  /** Notifications on this phone (stage D4); absent while their state is read. */
  push?: PushPanelProps;
}

export interface PushPanelProps {
  state: PushState;
  busy?: boolean;
  error?: string;
  onOn: () => void;
  onOff: () => void;
}

/** Notifications on this phone: the state in one sentence and the one button that changes it. */
export function PushPanel(p: PushPanelProps) {
  const line = { on: P.pushStateOn, off: P.pushStateOff, denied: P.pushStateDenied, unsupported: P.pushStateUnsupported }[p.state];
  return (
    <div data-testid="push-panel" data-state={p.state}>
      <p className="form-hint">{line}</p>
      {p.error && <Notice kind="error">{p.error}</Notice>}
      {p.state === 'off' && <button type="button" className="btn btn-secondary btn-full" onClick={p.onOn} disabled={p.busy}>{P.pushTurnOn}</button>}
      {p.state === 'on' && <button type="button" className="btn btn-ghost btn-full" onClick={p.onOff} disabled={p.busy}>{P.pushTurnOff}</button>}
    </div>
  );
}

export function DevicesScreen(p: DevicesScreenProps) {
  return (
    <div className="device-screen">
      <h1>{P.devicesTitle}</h1>
      {p.updated && <Notice kind="info">{P.appUpdated}</Notice>}
      {p.error && <Notice kind="error">{p.error}</Notice>}
      <DeviceList rows={p.rows} nowSeconds={p.nowSeconds} />
      {p.identityCode && <CodeBlock label={P.devIdentity} code={p.identityCode} testid="identity-code" />}
      <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onAddComputer} disabled={p.busy}>{P.devAddComputer}</button>
      <button type="button" className="btn btn-ghost btn-full" onClick={p.onRefresh} disabled={p.busy}>{P.devRefresh}</button>
      {p.push && <PushPanel {...p.push} />}
      <p className="form-hint" data-testid="second-icon">{P.secondIcon}</p>
      {p.persistent !== null && <p className="form-hint">{p.persistent ? P.storagePersistent : P.storageNotPersistent}</p>}
      <p className="form-hint" data-testid="app-version">{P.appVersion(p.version, p.build)}</p>
    </div>
  );
}
