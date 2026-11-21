/**
 * Turn on Touch ID for approvals on a computer that was set up without it (device-keys plan 3.2, DEC-15, DEC-92, DEC-94).
 * The recovery code signs a root-signed `set` that names this computer and a NEW Touch ID key; touch 1 makes that key and
 * checks the entry; the person confirms by the email link in the same browser (like replacing the recovery code); then
 * touch 2 turns on unlocking with Touch ID with the unlock password. The codes are sent once and never kept here.
 */
import { Driver } from './driver';
import type { DeviceClient, HandoffStarted, Result } from './device-client';
import { textForCode } from './device-texts';

export type CheckKeyState =
  | { step: 'form'; busy: boolean; error?: string }
  | { step: 'touch-key' }
  | { step: 'waiting'; recoveryId: string; confirmCode: string; error?: string }
  | { step: 'finishing' }
  | { step: 'touch-unlock' }
  | { step: 'done'; unlockOn: boolean };

export interface CheckKeyDeps {
  client: Pick<DeviceClient, 'checkKeySubmit' | 'checkKeyStatus' | 'checkKeyFinish' | 'recoverCancel' | 'platformCapabilities' | 'enablePlatform'>;
  open: (url: string) => void;
}

export class CheckKeyDriver extends Driver<CheckKeyState> {
  /** The unlock password, held only from the form to the second touch, then dropped. */
  private password: string | null = null;
  private polling = false;

  constructor(private readonly d: CheckKeyDeps) {
    super({ step: 'form', busy: false });
  }

  dispose(): void { this.password = null; }

  private text(r: Result<unknown>): string {
    return r.ok ? '' : textForCode(r.code, { screen: 'recover', retryAfterSeconds: r.retryAfterSeconds });
  }

  async submit(code: string, password: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'form' || st.busy || !code.trim() || !password) return;
    this.password = password;
    this.set({ step: 'touch-key' });
    const r = await this.d.client.checkKeySubmit(code.trim());
    if (!r.ok) { this.password = null; this.set({ step: 'form', busy: false, error: this.text(r) }); return; }
    this.handedOff(r.data);
  }

  private handedOff(h: HandoffStarted): void {
    this.d.open(h.pageUrl);
    this.set({ step: 'waiting', recoveryId: h.recoveryId, confirmCode: h.confirmCode });
  }

  async cancel(): Promise<void> {
    const st = this.state;
    const r = await this.d.client.recoverCancel();
    if (!r.ok && st.step === 'waiting') { this.set({ ...st, error: this.text(r) }); return; }
    this.password = null;
    this.set({ step: 'form', busy: false });
  }

  async poll(): Promise<void> {
    const st = this.state;
    if (st.step !== 'waiting' || this.polling) return;
    this.polling = true;
    try {
      const r = await this.d.client.checkKeyStatus(st.recoveryId);
      if (this.state !== st) return;
      if (!r.ok) { this.set({ ...st, error: this.text(r) }); return; }
      if (r.data.state === 'waiting') return;
      if (r.data.state === 'authorised') { await this.finish(st.recoveryId); return; }
      const code = r.data.state === 'expired' ? 'handoff_timeout' : (r.data.code ?? 'handoff_failed');
      await this.d.client.recoverCancel();
      this.password = null;
      this.set({ step: 'form', busy: false, error: textForCode(code, { screen: 'recover' }) });
    } finally {
      this.polling = false;
    }
  }

  private async finish(recoveryId: string): Promise<void> {
    this.set({ step: 'finishing' });
    const r = await this.d.client.checkKeyFinish(recoveryId);
    if (!r.ok) { this.password = null; this.set({ step: 'form', busy: false, error: this.text(r) }); return; }
    // Touch 2: unlocking with Touch ID, with the unlock password typed at the start (DEC-92). Never blocks: approvals are on.
    const password = this.password;
    this.password = null;
    let unlockOn = false;
    if (password) {
      const caps = await this.d.client.platformCapabilities();
      if (caps.ok && caps.data.unlockEnabled) unlockOn = true;
      else if (caps.ok && caps.data.available === true) {
        this.set({ step: 'touch-unlock' });
        const e = await this.d.client.enablePlatform(password);
        unlockOn = e.ok;
      }
    }
    this.set({ step: 'done', unlockOn });
  }
}
