import { CodeBlock } from '@suveren/approval-card/components/DeviceFrame';
import { TileList, TileRow } from '@suveren/approval-card/components/TileRows';
import type { DeviceRow } from '../lib/chain-view';
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
      <p className="form-hint" data-testid="second-icon">{P.secondIcon}</p>
      {p.persistent !== null && <p className="form-hint">{p.persistent ? P.storagePersistent : P.storageNotPersistent}</p>}
      <p className="form-hint" data-testid="app-version">{P.appVersion(p.version, p.build)}</p>
    </div>
  );
}
