/**
 * Recovery with the recovery code, and replacing the recovery code (device-keys plan 10 / 3.2, gateway side of
 * step 7). Both hand the person to suveren.ai in the SAME browser: the page opens the address, the person opens
 * the link we email, the control plane's callback ends the hand-off, and the page finishes with its own session.
 * The codes the person types are sent once and never kept here: the driver holds no code after the call.
 */

import { Driver } from './driver';
import type { DeviceClient, HandoffStarted, Result } from './device-client';
import { DRAFT, textForCode } from './device-texts';

export type RecoverState =
  | { kind: 'reset'; step: 'form'; busy: boolean; error?: string }
  | { kind: 'reset'; step: 'waiting'; recoveryId: string; confirmCode: string; removes: Array<{ label: string; kind: string }>; hadPendingReset: boolean; error?: string }
  | { kind: 'reset'; step: 'finishing' }
  | { kind: 'reset'; step: 'done'; signedIn: boolean; error?: string }
  | { kind: 'rotate'; step: 'intro'; busy: boolean; error?: string }
  | { kind: 'rotate'; step: 'show'; rotateId: string; checked: boolean; error?: string }
  | { kind: 'rotate'; step: 'enter'; rotateId: string; busy: boolean; error?: string }
  | { kind: 'rotate'; step: 'waiting'; recoveryId: string; confirmCode: string; error?: string }
  | { kind: 'rotate'; step: 'finishing' }
  | { kind: 'rotate'; step: 'done' };

export interface RecoverDeps {
  client: DeviceClient;
  open: (url: string) => void;
  /** After a recovery that signed in: read the person and enter the app. */
  onSignedIn?: () => Promise<boolean>;
}

export class RecoverDriver extends Driver<RecoverState> {
  /** The NEW code of a replacement: kept only for the screen that shows it. */
  private newCode: string | null = null;
  private polling = false;

  constructor(private readonly d: RecoverDeps, kind: 'reset' | 'rotate') {
    super(kind === 'reset' ? { kind: 'reset', step: 'form', busy: false } : { kind: 'rotate', step: 'intro', busy: false });
  }

  /** The new code, only while the screen that shows it is up: it is hidden before the person is asked to type it again. */
  newRecoveryCode(): string | null { return this.state.kind === 'rotate' && this.state.step === 'show' ? this.newCode : null; }
  dispose(): void { this.newCode = null; }

  private text(r: Result<unknown>): string {
    return r.ok ? '' : textForCode(r.code, { screen: 'recover', retryAfterSeconds: r.retryAfterSeconds });
  }

  // ─── Recovery with the code ───────────────────────────────────────────────

  async start(code: string, label?: string): Promise<void> {
    const st = this.state;
    if (st.kind !== 'reset' || st.step !== 'form' || st.busy || !code.trim()) return;
    this.set({ kind: 'reset', step: 'form', busy: true });
    const r = await this.d.client.recoverStart(code.trim(), label?.trim() || undefined);
    if (!r.ok) { this.set({ kind: 'reset', step: 'form', busy: false, error: this.text(r) }); return; }
    if (r.data.adopted) { await this.finishReset(r.data.recoveryId); return; }
    this.handedOff(r.data);
  }

  private handedOff(h: HandoffStarted): void {
    this.d.open(h.pageUrl);
    if (this.state.kind === 'reset') {
      this.set({ kind: 'reset', step: 'waiting', recoveryId: h.recoveryId, confirmCode: h.confirmCode, removes: h.removes ?? [], hadPendingReset: Boolean(h.pendingIdentityReset) });
    } else {
      this.set({ kind: 'rotate', step: 'waiting', recoveryId: h.recoveryId, confirmCode: h.confirmCode });
    }
  }

  async cancel(): Promise<void> {
    // The one cancel route drops a started recovery and a prepared replacement alike. Cancelled only once the gateway says so.
    const r = await this.d.client.recoverCancel();
    const st = this.state;
    if (!r.ok) {
      if ('error' in st || st.step === 'waiting' || st.step === 'show' || st.step === 'enter') this.set({ ...st, error: this.text(r) } as RecoverState);
      return;
    }
    const completed = (r.data as { completed?: { signedIn?: boolean } }).completed;
    if (completed && st.kind === 'reset') {
      // The Authority Server already held the entry: the recovery is completed instead of dropped.
      let signedIn = completed.signedIn === true;
      if (signedIn && this.d.onSignedIn) signedIn = await this.d.onSignedIn();
      this.set({ kind: 'reset', step: 'done', signedIn, ...(signedIn ? {} : { error: DRAFT.recoverDoneNoSignin }) });
      return;
    }
    this.newCode = null;
    this.set(st.kind === 'reset' ? { kind: 'reset', step: 'form', busy: false } : { kind: 'rotate', step: 'intro', busy: false });
  }

  async poll(): Promise<void> {
    const st = this.state;
    if (st.step !== 'waiting' || this.polling) return;
    this.polling = true;
    try {
      const r = st.kind === 'reset' ? await this.d.client.recoverStatus(st.recoveryId) : await this.d.client.rotateStatus(st.recoveryId);
      if (this.state !== st) return;
      if (!r.ok) { this.set({ ...st, error: this.text(r) }); return; }
      if (r.data.state === 'waiting') return;
      if (r.data.state === 'authorised') {
        if (st.kind === 'reset') await this.finishReset(st.recoveryId); else await this.finishRotate(st.recoveryId);
        return;
      }
      const code = r.data.state === 'expired' ? 'handoff_timeout' : (r.data.code ?? 'handoff_failed');
      await this.d.client.recoverCancel();
      this.set(st.kind === 'reset'
        ? { kind: 'reset', step: 'form', busy: false, error: textForCode(code, { screen: 'recover' }) }
        : { kind: 'rotate', step: 'intro', busy: false, error: textForCode(code, { screen: 'recover' }) });
    } finally {
      this.polling = false;
    }
  }

  private async finishReset(recoveryId: string): Promise<void> {
    this.set({ kind: 'reset', step: 'finishing' });
    const r = await this.d.client.recoverFinish(recoveryId);
    if (!r.ok) { this.set({ kind: 'reset', step: 'form', busy: false, error: this.text(r) }); return; }
    let signedIn = r.data.signedIn;
    if (signedIn && this.d.onSignedIn) signedIn = await this.d.onSignedIn();
    this.set({ kind: 'reset', step: 'done', signedIn, ...(signedIn ? {} : { error: DRAFT.recoverDoneNoSignin }) });
  }

  // ─── Replacing the recovery code ──────────────────────────────────────────

  async rotateStart(): Promise<void> {
    const st = this.state;
    if (st.kind !== 'rotate' || st.step !== 'intro' || st.busy) return;
    this.set({ kind: 'rotate', step: 'intro', busy: true });
    const r = await this.d.client.rotateStart();
    if (!r.ok) { this.set({ kind: 'rotate', step: 'intro', busy: false, error: this.text(r) }); return; }
    this.newCode = r.data.recoveryCode;
    this.set({ kind: 'rotate', step: 'show', rotateId: r.data.rotateId, checked: false });
  }

  toggleWritten(checked: boolean): void {
    const st = this.state;
    if (st.kind === 'rotate' && st.step === 'show') this.set({ ...st, checked });
  }

  /** "I wrote it down": the code is hidden, then the person is asked to type it again. */
  writtenDown(): void {
    const st = this.state;
    if (st.kind !== 'rotate' || st.step !== 'show' || !st.checked) return;
    this.newCode = null;
    this.set({ kind: 'rotate', step: 'enter', rotateId: st.rotateId, busy: false });
  }

  async rotateSubmit(oldCode: string, newCodeTyped: string): Promise<void> {
    const st = this.state;
    if (st.kind !== 'rotate' || st.step !== 'enter' || st.busy || !oldCode.trim() || !newCodeTyped.trim()) return;
    this.set({ ...st, busy: true, error: undefined });
    const r = await this.d.client.rotateSubmit(st.rotateId, oldCode.trim(), newCodeTyped.trim());
    if (!r.ok) {
      // A prepared code that ran out or is unknown cannot be tried again: back to the start.
      if (r.code === 'rotate_expired' || r.code === 'rotate_unknown') { this.newCode = null; this.set({ kind: 'rotate', step: 'intro', busy: false, error: this.text(r) }); return; }
      this.set({ ...st, busy: false, error: this.text(r) });
      return;
    }
    this.newCode = null;
    this.handedOff(r.data);
  }

  private async finishRotate(recoveryId: string): Promise<void> {
    this.set({ kind: 'rotate', step: 'finishing' });
    const r = await this.d.client.rotateFinish(recoveryId);
    if (!r.ok) { this.set({ kind: 'rotate', step: 'intro', busy: false, error: this.text(r) }); return; }
    this.set({ kind: 'rotate', step: 'done' });
  }
}
