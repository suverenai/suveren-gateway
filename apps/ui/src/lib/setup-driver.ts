/**
 * Set up this computer (device-keys plan step 6, screens 2 and 3): name it, Connect to the account in the system
 * browser, see the recovery code ONCE, then finish. The recovery code comes from `setup/start` (the one place the
 * control plane ever sends it), so it is made at Continue but kept unseen in memory until Connect worked (open note
 * on item 31); it is dropped the moment the set-up finishes, is cancelled or the page is left.
 *
 * Order on the wire: start (name) → connect → poll until ready → [code, kept, condition on the page] → finish.
 * `finish` is last so "Cancel set-up. This code stops working." (item 45) is true: until then nothing is stored.
 */

import { Driver } from './driver';
import { DeviceClient, type ConnectAccount, type Result } from './device-client';
import { T, textForCode } from './device-texts';

export type SetupState =
  | { step: 'name'; busy: boolean; error?: string }
  /** A set-up was started earlier and its recovery code is gone (shown once): it can only be cancelled. */
  | { step: 'stuck'; busy: boolean; error?: string }
  | { step: 'connect'; busy: boolean; error?: string; setupId: string }
  | { step: 'waiting'; setupId: string; error?: string }
  | { step: 'code'; setupId: string; account?: ConnectAccount; error?: string }
  | { step: 'kept'; setupId: string; account?: ConnectAccount; checked: boolean; error?: string }
  | { step: 'condition'; setupId: string; account?: ConnectAccount; busy: boolean; error?: string }
  | { step: 'connected'; account?: ConnectAccount; signedIn: boolean; error?: string; busy: boolean };

export interface SetupDeps {
  client: DeviceClient;
  /** Opens suveren.ai in the person's browser. */
  open: (url: string) => void;
  /** Whether this computer can make a check key (Touch ID). Asked of the gateway, never guessed; read when Continue is pressed. */
  wantCheckKey?: () => boolean;
}

export class SetupDriver extends Driver<SetupState> {
  /** The recovery code of the started set-up. Never in the state, never in a log. */
  private code: string | null = null;
  private polling = false;

  constructor(private readonly d: SetupDeps, initial: SetupState = { step: 'name', busy: false }) {
    super(initial);
  }

  /** The code for the one screen that shows it. */
  recoveryCode(): string | null { return this.code; }

  /** Drop the code (the flow ended or the page is left). */
  dispose(): void { this.code = null; }

  private fail<T>(r: Result<T>, screen: 'setup' | 'connect'): string {
    if (r.ok) return '';
    return textForCode(r.code, { screen, retryAfterSeconds: r.retryAfterSeconds });
  }

  /** Mount: a set-up the gateway still holds from before (its code is not recoverable). */
  async resume(): Promise<void> {
    const s = await this.d.client.status();
    if (s.ok && s.data.setupPending) this.set({ step: 'stuck', busy: false, error: T.setupUnfinished });
  }

  // Screen 2a
  async continueWithName(label: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'name' || st.busy) return;
    this.set({ step: 'name', busy: true });
    const r = await this.d.client.setupStart(label.trim(), this.d.wantCheckKey?.() ? true : undefined);
    if (!r.ok) {
      this.set({ step: 'name', busy: false, error: this.fail(r, 'setup') });
      return;
    }
    this.code = r.data.recoveryCode;
    this.set({ step: 'connect', busy: false, setupId: r.data.setupId });
  }

  // Screen 2b: Connect
  async connect(): Promise<void> {
    const st = this.state;
    if (st.step !== 'connect' || st.busy) return;
    this.set({ ...st, busy: true, error: undefined });
    const r = await this.d.client.connectStart(st.setupId);
    if (!r.ok) {
      this.set({ ...st, busy: false, error: this.fail(r, 'connect') });
      return;
    }
    this.d.open(r.data.authorizeUrl);
    this.set({ step: 'waiting', setupId: st.setupId });
  }

  /** One look at the browser step (the component calls this every couple of seconds while waiting). */
  async poll(): Promise<void> {
    const st = this.state;
    if (st.step !== 'waiting' || this.polling) return;
    this.polling = true;
    try {
      const r = await this.d.client.connectStatus(st.setupId);
      if (this.state !== st) return; // the person moved on meanwhile
      if (!r.ok) {
        this.set({ step: 'connect', busy: false, setupId: st.setupId, error: this.fail(r, 'connect') });
        return;
      }
      if (r.data.state === 'waiting') return;
      if (r.data.state === 'ready') {
        this.set({ step: 'code', setupId: st.setupId, account: r.data.account });
        return;
      }
      const code = r.data.state === 'expired' ? 'connect_timeout' : (r.data.code ?? 'connect_failed');
      this.set({ step: 'connect', busy: false, setupId: st.setupId, error: textForCode(code, { screen: 'connect' }) });
    } finally {
      this.polling = false;
    }
  }

  /** Cancel while waiting or at the code screen (items 58, 45): the started set-up is dropped, the code with it. */
  async cancel(): Promise<void> {
    const r = await this.d.client.setupCancel();
    if (!r.ok) {
      // Cancelled only once the gateway says so: otherwise the person stays where they are, with the reason.
      const st = this.state;
      if (st.step === 'connected') return;
      this.set({ ...st, error: this.fail(r, 'setup') } as SetupState);
      return;
    }
    this.code = null;
    this.set({ step: 'name', busy: false });
  }

  // Screen 3
  codeSeen(): void {
    const st = this.state;
    if (st.step === 'code') this.set({ step: 'kept', setupId: st.setupId, account: st.account, checked: false });
  }
  /** Back to the code from "Did you keep it?" is not offered: the code is shown once. */
  toggleKept(checked: boolean): void {
    const st = this.state;
    if (st.step === 'kept') this.set({ ...st, checked });
  }
  kept(): void {
    const st = this.state;
    if (st.step === 'kept' && st.checked) this.set({ step: 'condition', setupId: st.setupId, account: st.account, busy: false });
  }

  /** "I understand": the set-up is finished on the gateway (chain stored, signed in). */
  async understand(): Promise<void> {
    const st = this.state;
    if (st.step !== 'condition' || st.busy) return;
    this.set({ ...st, busy: true, error: undefined });
    const r = await this.d.client.setupFinish(st.setupId);
    if (!r.ok) {
      this.set({ ...st, busy: false, error: this.fail(r, 'connect') });
      return;
    }
    this.code = null;
    this.set({
      step: 'connected',
      account: r.data.account ?? st.account,
      signedIn: r.data.signedIn,
      busy: false,
      ...(r.data.signedIn ? {} : { error: T.connectedSigninFailed }),
    });
  }

  /** Connected, but signing in did not work: try the sign-in again (item 65). */
  async retrySignIn(): Promise<void> {
    const st = this.state;
    if (st.step !== 'connected' || st.busy) return;
    this.set({ ...st, busy: true, error: undefined });
    const r = await this.d.client.signIn();
    if (r.ok) this.set({ ...st, busy: false, signedIn: true, error: undefined });
    else this.set({ ...st, busy: false, error: textForCode(r.code, { screen: 'signin', retryAfterSeconds: r.retryAfterSeconds }) });
  }
}
