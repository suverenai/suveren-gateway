/**
 * "Add a phone" (`flow: 'admit'`) and "Add this computer" (`flow: 'join'`) on the gateway page (device-keys plan 4.3, step 11).
 * The control plane holds the ceremony (keys, secrets, the mailbox, the touch); this driver only asks it, polls it, and keeps
 * what the page draws. UI reflects backend truth: the view is always what the control plane last said, never a guess; an error
 * keeps the view where it was.
 *
 * The page calls {@link poll} every couple of seconds while a step waits on the other device ({@link isWaiting}).
 */

import { Driver } from './driver';
import { DeviceClient, type PairingView, type Result } from './device-client';
import { pairingErrorText } from './pairing-texts';
import { textForCode } from './device-texts';

export type PairingFlow = 'admit' | 'join';

export interface PairingUiState {
  view: PairingView;
  busy: boolean;
  /** A refusal of the last call, in words; the view stays as it was. */
  error?: string;
  /** The first look at what the control plane holds is not done yet. */
  loading: boolean;
}

export interface PairingDeps {
  client: DeviceClient;
  flow: PairingFlow;
}

/** The steps that wait on the other device or on its mailbox. */
export function isWaiting(v: PairingView): boolean {
  if (v.flow === 'admit') return v.step === 'qr' || v.step === 'connected';
  if (v.flow === 'join') return v.step === 'qr' || v.step === 'waiting' || v.step === 'compare';
  return false;
}

export class PairingDriver extends Driver<PairingUiState> {
  private polling = false;

  constructor(private readonly d: PairingDeps, initial: PairingUiState = { view: { flow: 'none' }, busy: false, loading: true }) {
    super(initial);
  }

  private words(code: string, retryAfterSeconds?: number): string {
    // Pairing codes have their own words; the rest are the device-key texts' (locked, session closed, Touch ID, suveren.ai).
    const own = pairingErrorText(code);
    return own === textForCode(undefined) ? textForCode(code, { screen: 'general', retryAfterSeconds }) : own;
  }

  private take(r: Result<{ view: PairingView }>): void {
    if (r.ok) this.set({ view: r.data.view, busy: false, loading: false });
    else this.set({ ...this.state, busy: false, loading: false, error: this.words(r.code, r.retryAfterSeconds) });
  }

  /** On mount: what the control plane holds. A pairing of the OTHER flow is not this page's: it is shown as nothing and not touched. */
  async resume(): Promise<void> {
    const r = await this.d.client.pairingStatus();
    if (!r.ok) { this.set({ view: { flow: 'none' }, busy: false, loading: false, error: this.words(r.code) }); return; }
    const v = r.data.view;
    this.set({ view: v.flow === this.d.flow ? v : { flow: 'none' }, busy: false, loading: false });
  }

  async start(): Promise<void> {
    if (this.state.busy) return;
    this.set({ ...this.state, busy: true, error: undefined });
    const r = await (this.d.flow === 'admit' ? this.d.client.admitStart() : this.d.client.joinStart());
    this.take(r);
  }

  /** One look at the mailbox, only while a step waits. */
  async poll(): Promise<void> {
    if (this.polling || this.state.busy || !isWaiting(this.state.view)) return;
    this.polling = true;
    try {
      const before = this.state.view;
      const r = await this.d.client.pairingStatus();
      // The person moved on (cancelled, chose) while the answer was on its way: the later action wins.
      if (this.state.view !== before || this.state.busy) return;
      if (r.ok) this.set({ view: r.data.view, busy: false, loading: false });
      else this.set({ ...this.state, error: this.words(r.code, r.retryAfterSeconds) });
    } finally {
      this.polling = false;
    }
  }

  /** "Add a phone": the person tapped a code. The control plane asks for the touch before it answers. */
  async choose(code: string): Promise<void> {
    if (this.state.busy) return;
    this.set({ ...this.state, busy: true, error: undefined });
    this.take(await this.d.client.admitChoose(code));
  }

  /** "Add this computer": the person read the account and named this computer. */
  async confirm(label: string): Promise<void> {
    if (this.state.busy) return;
    this.set({ ...this.state, busy: true, error: undefined });
    this.take(await this.d.client.joinConfirm(label));
  }

  /** Cancelled only once the control plane says so: it forgets the pairing and, for an admitter, tells the phone. */
  async cancel(): Promise<void> {
    this.set({ ...this.state, busy: true, error: undefined });
    this.take(await this.d.client.pairingCancel());
  }

  /** The computer was added but its sign-in did not work. */
  async retrySignIn(): Promise<void> {
    const st = this.state;
    if (st.busy || st.view.flow !== 'join' || st.view.step !== 'done') return;
    this.set({ ...st, busy: true, error: undefined });
    const r = await this.d.client.signIn();
    if (r.ok) this.set({ view: { flow: 'join', step: 'done', signedIn: true }, busy: false, loading: false });
    else this.set({ ...st, busy: false, error: this.words(r.code, r.retryAfterSeconds) });
  }
}
