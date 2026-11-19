import { S13 } from '@suveren/approval-card/mandate-screens';
import { P } from '../texts';
import { Notice, Screen } from './Frame';

export interface OpenSessionProps {
  busy: boolean;
  /** A sentence from texts.ts (errorText), or null. */
  error: string | null;
  /** The session ended after it was open (a break, the background): said once. */
  ended: boolean;
  onOpen: () => void;
  /** Offered only where opening can never work again (this phone was removed, its keys are gone). */
  onForget?: () => void;
}

/** The phone's check (Face ID, fingerprint or PIN) opens a session; reading needs nothing more (DEC-47). */
export function OpenSessionScreen(p: OpenSessionProps) {
  return (
    <Screen title={P.openTitle}>
      <p>{p.ended ? P.openEnded : P.openBody}</p>
      {p.error && <Notice kind="error">{p.error}</Notice>}
      <button type="button" className="btn btn-primary btn-full btn-lg" onClick={p.onOpen} disabled={p.busy}>{p.busy ? S13.giveBusy : P.openButton}</button>
      {p.onForget && (
        <>
          <p style={{ fontSize: 'var(--text-body-sm)' }}>{P.forgetNote}</p>
          <button type="button" className="btn btn-secondary btn-full" onClick={p.onForget}>{P.forgetButton}</button>
        </>
      )}
    </Screen>
  );
}
