import type { DeviceRow } from '../lib/chain-view';
import { P } from '../texts';
import { whenText } from './Frame';

/** The list of devices, from a chain this phone verified itself. Labels are plain text. */
export function DeviceList({ rows, nowSeconds }: { rows: Array<DeviceRow & { adding?: boolean }>; nowSeconds: number }) {
  return (
    <ul className="ap-devices" data-testid="device-list">
      {rows.map((r) => (
        <li key={r.keyId} className="ap-device" data-testid="device-row" data-new={r.adding ? 'true' : undefined}>
          <div className="ap-device-name">{r.label}</div>
          <div className="ap-device-meta">
            {r.thisDevice && <b>{P.devThisPhone}</b>}
            {r.adding && <b>{P.admitNew}</b>}
            <span>{r.kind === 'gateway' ? P.devKindComputer : P.devKindPhone}</span>
            {r.canGrant && <span>{P.devCanConfirm}</span>}
            {!r.adding && <span>{P.devAdded(whenText(r.addedAt, nowSeconds))}</span>}
            {r.recent && !r.adding && <span>{P.devRecent}</span>}
          </div>
        </li>
      ))}
    </ul>
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
}

export function DevicesScreen(p: DevicesScreenProps) {
  return (
    <div className="device-screen">
      <h1>{P.devicesTitle}</h1>
      {p.updated && <div className="alert alert-info" role="status">{P.appUpdated}</div>}
      {p.error && <div className="alert alert-error" role="alert">{p.error}</div>}
      <DeviceList rows={p.rows} nowSeconds={p.nowSeconds} />
      {p.identityCode && (
        <>
          <div style={{ color: 'var(--text-secondary)' }}>{P.devIdentity}</div>
          <div className="ap-code" data-testid="identity-code">{p.identityCode}</div>
        </>
      )}
      <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onAddComputer} disabled={p.busy}>{P.devAddComputer}</button>
      <button type="button" className="btn btn-ghost btn-full" onClick={p.onRefresh} disabled={p.busy}>{P.devRefresh}</button>
      <p className="ap-foot" data-testid="second-icon">{P.secondIcon}</p>
      {p.persistent !== null && <p className="ap-foot">{p.persistent ? P.storagePersistent : P.storageNotPersistent}</p>}
      <p className="ap-foot" data-testid="app-version">{P.appVersion(p.version, p.build)}</p>
    </div>
  );
}

