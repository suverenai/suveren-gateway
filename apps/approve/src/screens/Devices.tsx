import { CodeBlock } from '@suveren/approval-card/components/DeviceFrame';
import { TileList, TileRow } from '@suveren/approval-card/components/TileRows';
import type { DeviceRow } from '../lib/chain-view';
import { P } from '../texts';
import { Notice, Screen, TouchWait, whenText } from './Frame';
import type { RemoveState } from '../lib/remove-driver';

/** The list of devices, from a chain this phone verified itself: the gateway's member rows (TileList), one per device. Labels are plain text. */
export function DeviceList({ rows, nowSeconds, onRemove }: { rows: Array<DeviceRow & { adding?: boolean }>; nowSeconds: number; onRemove?: (keyId: string) => void }) {
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
          action={onRemove && !r.adding ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(r.keyId)} data-testid="device-remove">{P.devRemove}</button>
          ) : undefined}
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
  /** Remove a device (stage D3): every device, this phone included (DEC-85). */
  onRemove?: (keyId: string) => void;
  /** What the other devices did (mockup F1, F3), newest first. */
  notices?: string[];
  /** Replacing the recovery code is offered until done (DEC-85, mockup D1): the label of the device the code was made on. */
  rotateOffer?: string | null;
  onRotate?: () => void;
  busy?: boolean;
  error?: string;
}

export function DevicesScreen(p: DevicesScreenProps) {
  return (
    <div className="device-screen">
      <h1>{P.devicesTitle}</h1>
      {p.updated && <Notice kind="info">{P.appUpdated}</Notice>}
      {p.error && <Notice kind="error">{p.error}</Notice>}
      {(p.notices ?? []).map((n, i) => <div key={i} data-testid="chain-notice"><Notice kind="info">{n}</Notice></div>)}
      {p.rotateOffer && p.onRotate && (
        <div data-testid="rotate-offer">
          <h2 style={{ fontSize: 'var(--text-lead)' }}>{P.rotateOfferTitle}</h2>
          <p>{P.rotateOfferBody(p.rotateOffer)}</p>
          <p>{P.rotateNeedPaper}</p>
          <button type="button" className="btn btn-primary btn-full" onClick={p.onRotate} disabled={p.busy}>{P.rotateStart}</button>
        </div>
      )}
      <DeviceList rows={p.rows} nowSeconds={p.nowSeconds} onRemove={p.onRemove} />
      {p.identityCode && <CodeBlock label={P.devIdentity} code={p.identityCode} testid="identity-code" />}
      <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onAddComputer} disabled={p.busy}>{P.devAddComputer}</button>
      <button type="button" className="btn btn-ghost btn-full" onClick={p.onRefresh} disabled={p.busy}>{P.devRefresh}</button>
      <p className="form-hint" data-testid="second-icon">{P.secondIcon}</p>
      {p.persistent !== null && <p className="form-hint">{p.persistent ? P.storagePersistent : P.storageNotPersistent}</p>}
      <p className="form-hint" data-testid="app-version">{P.appVersion(p.version, p.build)}</p>
    </div>
  );
}

export interface RemoveScreenProps {
  state: RemoveState;
  nowSeconds: number;
  onConfirm: () => void;
  onCancel: () => void;
  /** Cancel while the touch is asked or after it failed: back to the confirm screen. */
  onCancelTouch: () => void;
  onAdd: () => void;
  onDone: () => void;
}

/** Remove a device (mockup C2–C4): what it does, the list after the change, then the touch. */
export function RemoveScreen({ state: st, nowSeconds, onConfirm, onCancel, onCancelTouch, onAdd, onDone }: RemoveScreenProps) {
  switch (st.step) {
    case 'idle':
      return null;
    case 'confirm':
    case 'checking':
    case 'sending': {
      const t = st.target;
      return (
        <Screen title={st.self ? P.removeSelfTitle : P.removeTitle(t.label)}>
          {st.self ? <p>{P.removeSelfEffect}</p> : (
            <>
              <p>{t.kind === 'gateway' ? P.removeComputerEffect(t.label) : P.removePhoneEffect(t.label)}</p>
              {t.kind === 'gateway' && <p>{P.removeLogins(t.label)}</p>}
            </>
          )}
          {st.step === 'confirm' && (
            <>
              <p>{P.removeListAfter}</p>
              <DeviceList rows={st.after} nowSeconds={nowSeconds} />
              <button type="button" className="btn btn-primary btn-full btn-lg" onClick={onConfirm} data-testid="remove-confirm">{P.removeButton}</button>
              <button type="button" className="btn btn-ghost btn-full" onClick={onCancel}>{P.cancel}</button>
            </>
          )}
          {st.step === 'checking' && (
            <TouchWait text={P.touchWait} error={st.error} onRetry={onConfirm} onCancel={onCancelTouch} retryLabel={P.tryAgain} cancelLabel={P.cancel} />
          )}
          {/* The touch was given: the request may be on its way. No Cancel. */}
          {st.step === 'sending' && <TouchWait text={P.doSend} />}
        </Screen>
      );
    }
    case 'refused':
      return (
        <Screen title={st.self ? P.removeSelfTitle : P.removeTitle(st.target.label)}>
          <div data-testid="remove-refused"><Notice kind="error">{st.error}</Notice></div>
          <button type="button" className="btn btn-primary btn-full" onClick={onAdd}>{P.devAddComputer}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={onCancel}>{P.cancel}</button>
        </Screen>
      );
    case 'done':
      return (
        <Screen title={P.devicesTitle}>
          <Notice kind="success">{P.removeDone(st.label)}</Notice>
          {st.listError && <div data-testid="list-not-refreshed"><Notice kind="info">{st.listError}</Notice></div>}
          <p>{P.removeListNow}</p>
          <DeviceList rows={st.rows} nowSeconds={nowSeconds} />
          <button type="button" className="btn btn-primary btn-full" onClick={onDone}>{P.continue}</button>
        </Screen>
      );
    case 'failed':
      return (
        <Screen title={st.target ? P.removeTitle(st.target.label) : P.devicesTitle}>
          <Notice kind="error">{st.error}</Notice>
          <button type="button" className="btn btn-primary btn-full" onClick={onDone}>{P.back}</button>
        </Screen>
      );
  }
}
