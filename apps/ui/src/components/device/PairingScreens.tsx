/**
 * The pairing screens of the gateway page (device-keys plan 4.3, step 11 gateway part; DEC-47, DEC-83, DEC-84): the Devices list,
 * "Add a phone" and "Add this computer". The frame, the notices, the code boxes, the QR and the rows are the SHARED components
 * of packages/approval-card (the phone app draws the same ones): no markup of their own beyond what is gateway-specific here.
 * Pure: a screen is its props, so a test renders every state. Words: lib/pairing-texts.ts (all DRAFT).
 */
import { useState } from 'react';
import { CodeBlock, DeviceFrame, Notice } from '@suveren/approval-card/components/DeviceFrame';
import { CodeChoices } from '@suveren/approval-card/components/CodeChoices';
import { QrCode } from '@suveren/approval-card/components/QrCode';
import { DeviceRows } from '@suveren/approval-card/components/DeviceRows';
import type { DevicesAnswer, PairingDeviceRow } from '../../lib/device-client';
import type { PairingUiState } from '../../lib/pairing-driver';
import { PT, pairingErrorText, whenText } from '../../lib/pairing-texts';

/** The list of devices, from a chain this computer verified itself: the shared device rows (one implementation with the phone app). */
export function DeviceList({ rows, nowSeconds }: { rows: PairingDeviceRow[]; nowSeconds: number }) {
  return <DeviceRows rows={rows} nowSeconds={nowSeconds} thisDeviceTag={PT.devThisComputer} />;
}

// ─── The Devices page ──────────────────────────────────────────────────────────

export interface DevicesScreenProps {
  /** Null while the list is being read. */
  devices: DevicesAnswer | null;
  nowSeconds: number;
  error?: string;
  onAddPhone: () => void;
  onRefresh: () => void;
  onBack: () => void;
}

export function DevicesScreen(p: DevicesScreenProps) {
  const d = p.devices;
  return (
    <DeviceFrame title={PT.devicesTitle}>
      {p.error && <Notice kind="error">{p.error}</Notice>}
      {!d && !p.error && <Notice kind="info">{PT.devLoading}</Notice>}
      {d && (
        <>
          <DeviceList rows={d.rows} nowSeconds={p.nowSeconds} />
          <CodeBlock label={PT.devIdentity} code={d.identityCode} testid="identity-code" />
          {!d.canGrant && <Notice kind="info">{PT.devCannotAdd}</Notice>}
          {d.canGrant && !d.hasRoom && <Notice kind="info">{PT.devFull}</Notice>}
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onAddPhone} disabled={!d.canGrant || !d.hasRoom}>{PT.devAddPhone}</button>
        </>
      )}
      <button type="button" className="btn btn-ghost btn-full" onClick={p.onRefresh}>{PT.devRefresh}</button>
      <button type="button" className="btn btn-ghost btn-full" onClick={p.onBack}>{PT.devicesBack}</button>
    </DeviceFrame>
  );
}

// ─── Add a phone ───────────────────────────────────────────────────────────────

export interface AddPhoneScreenProps {
  state: PairingUiState;
  nowSeconds: number;
  onStart: () => void;
  onChoose: (code: string) => void;
  onCancel: () => void;
  onDone: () => void;
}

/** This computer adds the phone app: the code to scan, the code the phone shows (tapped among three), the touch, the new list. */
export function AddPhoneScreen(p: AddPhoneScreenProps) {
  const { view, busy, error, loading } = p.state;
  const err = error && <Notice kind="error">{error}</Notice>;
  if (view.flow !== 'admit') {
    return (
      <DeviceFrame title={PT.addPhoneTitle}>
        {err}
        <p>{PT.addPhoneIntro}</p>
        <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onStart} disabled={busy || loading}>{PT.addPhoneShow}</button>
        <button type="button" className="btn btn-ghost btn-full" onClick={p.onDone}>{PT.back}</button>
      </DeviceFrame>
    );
  }
  switch (view.step) {
    case 'qr':
      return (
        <DeviceFrame title={PT.addPhoneTitle}>
          {err}
          <p>{PT.addPhoneScan}</p>
          <QrCode text={view.qr} label={PT.addPhoneQrLabel} testid="pairing-qr" />
          <p className="form-hint">{PT.addPhoneQrTime}</p>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'connected':
      return (
        <DeviceFrame title={PT.addPhoneTitle}>
          {err}
          <Notice kind="info">{PT.addPhoneConnected}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'choose':
      return (
        <DeviceFrame title={PT.addPhoneChooseTitle(view.label)}>
          {err}
          <div data-testid="other-ready"><Notice kind="success">{PT.otherReady}</Notice></div>
          <p>{PT.addPhoneChooseBody}</p>
          <CodeChoices codes={view.codes} onChoose={p.onChoose} disabled={busy} />
          <p>{PT.addPhoneListTitle}</p>
          <DeviceList rows={view.rows} nowSeconds={p.nowSeconds} />
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'checking':
      return (
        <DeviceFrame title={PT.addPhoneTitle}>
          <Notice kind="info">{PT.addPhoneChecking}</Notice>
        </DeviceFrame>
      );
    case 'failed':
      return (
        <DeviceFrame title={PT.addPhoneTitle}>
          <Notice kind="error">{pairingErrorText(view.code)}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCancel}>{PT.startAgain}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onDone}>{PT.back}</button>
        </DeviceFrame>
      );
    case 'done':
      return (
        <DeviceFrame title={PT.addPhoneDoneTitle(view.label)}>
          <Notice kind="success">{PT.addPhoneDone}</Notice>
          <p>{PT.addPhoneDoneList}</p>
          <DeviceList rows={view.rows} nowSeconds={p.nowSeconds} />
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{PT.continue}</button>
        </DeviceFrame>
      );
  }
}

// ─── Add this computer ─────────────────────────────────────────────────────────

export interface AddComputerScreenProps {
  state: PairingUiState;
  nowSeconds: number;
  onStart: () => void;
  onConfirm: (label: string) => void;
  onCancel: () => void;
  onDone: () => void;
  onRetrySignIn: () => void;
  /** Leave without starting (the screen of a computer that is not set up has other ways in). */
  onBack?: () => void;
}

/** A computer without the account is admitted by the phone: the code to scan, who it would join, the name, the code to tap on the phone. */
export function AddComputerScreen(p: AddComputerScreenProps) {
  const { view, busy, error, loading } = p.state;
  const [label, setLabel] = useState('');
  const err = error && <Notice kind="error">{error}</Notice>;
  if (view.flow !== 'join') {
    return (
      <DeviceFrame title={PT.addComputerTitle}>
        {err}
        <p>{PT.addComputerIntro}</p>
        <p>{PT.addComputerNeedsPhone}</p>
        <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onStart} disabled={busy || loading}>{PT.addComputerShow}</button>
        {p.onBack && <button type="button" className="btn btn-ghost btn-full" onClick={p.onBack}>{PT.back}</button>}
      </DeviceFrame>
    );
  }
  switch (view.step) {
    case 'qr':
      return (
        <DeviceFrame title={PT.addComputerTitle}>
          {err}
          <p>{PT.addComputerScan}</p>
          <QrCode text={view.qr} label={PT.addComputerQrLabel} testid="pairing-qr" />
          <p className="form-hint">{PT.addComputerQrTime}</p>
          {!view.canGrant && <Notice kind="info">{PT.addComputerNoTouch}</Notice>}
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'review': {
      const name = label === '' ? view.suggestedLabel : label;
      const reviewError = view.error ? pairingErrorText(view.error) : undefined;
      return (
        <DeviceFrame title={PT.reviewTitle}>
          {err}
          {reviewError && <Notice kind="error">{reviewError}</Notice>}
          <CodeBlock label={PT.reviewIdentity} code={view.identityCode} testid="review-identity" />
          <p>{PT.reviewIdentityNote}</p>
          {view.origin && <p data-testid="review-made">{PT.reviewMade(view.origin.label, whenText(view.origin.at, p.nowSeconds))}</p>}
          <p>{PT.reviewDevices}</p>
          <DeviceList rows={view.devices} nowSeconds={p.nowSeconds} />
          <div className="form-group" style={{ marginBottom: 'var(--space-6)' }}>
            <label className="form-label" htmlFor="join-name">{PT.reviewNameLabel}</label>
            <input id="join-name" className="form-input" value={name} maxLength={64} onChange={e => setLabel(e.target.value)} disabled={busy}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) p.onConfirm(name); }} />
            <div className="form-hint">{PT.reviewNameHint}</div>
          </div>
          {!view.canGrant && <Notice kind="info">{PT.addComputerNoTouch}</Notice>}
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={() => p.onConfirm(name)} disabled={busy || !name.trim()}>{PT.reviewButton}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.reviewNotMine}</button>
        </DeviceFrame>
      );
    }
    case 'working':
      return (
        <DeviceFrame title={PT.addComputerTitle}>
          <Notice kind="info">{view.doing === 'check' ? PT.workCheck : PT.workSend}</Notice>
        </DeviceFrame>
      );
    case 'waiting':
      return (
        <DeviceFrame title={PT.compareTitle}>
          {err}
          <Notice kind="info">{PT.waitingFor(view.admitterLabel)}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'compare':
      return (
        <DeviceFrame title={PT.showTitle}>
          {err}
          <p data-testid="compare-next"><strong>{PT.tapThis(view.admitterLabel)}</strong></p>
          <CodeBlock code={view.code} testid="compare-code" grouped={false} big />
          <p>{PT.compareBody(view.admitterLabel)}</p>
          <Notice kind="info">{PT.waitingFor(view.admitterLabel)}</Notice>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={busy}>{PT.cancel}</button>
        </DeviceFrame>
      );
    case 'failed':
      return (
        <DeviceFrame title={PT.addComputerTitle}>
          <Notice kind="error">{pairingErrorText(view.code)}</Notice>
          <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onCancel}>{PT.startAgain}</button>
          {p.onBack && <button type="button" className="btn btn-ghost btn-full" onClick={p.onBack}>{PT.back}</button>}
        </DeviceFrame>
      );
    case 'done':
      return (
        <DeviceFrame title={PT.addedComputerTitle}>
          {err}
          {view.signedIn ? <Notice kind="success">{PT.addedComputerBody}</Notice> : <Notice kind="error">{PT.addedComputerNoSignin}</Notice>}
          {view.signedIn
            ? <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{PT.continue}</button>
            : <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onRetrySignIn} disabled={busy}>{PT.tryAgain}</button>}
        </DeviceFrame>
      );
  }
}
