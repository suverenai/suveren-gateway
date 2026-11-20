/**
 * Confirm a change to a stored connector login (screen 5, DEC-47). The gateway builds a request for ONE exact change
 * (`/auth/confirm/request`); the person confirms it with Touch ID on a computer that has a check key, with the
 * unlock password where it has none. The confirmed request id then rides on the change itself (spClient).
 */

import { Driver } from './driver';
import type { DeviceClient, ChangeRequest } from './device-client';
import { T, textForCode } from './device-texts';

export interface ConfirmAsk { kind: 'replace' | 'remove'; name: string; change: unknown }

export interface ConfirmState {
  phase: 'starting' | 'asking' | 'busy' | 'closed';
  kind: 'replace' | 'remove';
  name: string;
  /**
   * Which way this computer confirms: Touch ID where it has a check key; otherwise the person's phone first (plan 7 phone path,
   * when a phone is in the chain) and the unlock password after it.
   */
  mode: 'password' | 'touch' | 'phone';
  /** Phone mode: the request is waiting on the phone (epoch ms when it runs out). */
  phoneUntil?: number;
  error?: string;
}

/**
 * Codes of `/auth/confirm/phone` that mean "no phone path here": the password is offered without a word. `bad_request` is also the
 * answer of a control plane without the route.
 */
const NO_PHONE = new Set(['no_phone', 'not_set_up', 'change_not_describable', 'check_key_required', 'password_required', 'bad_request']);

export class ConfirmDriver extends Driver<ConfirmState> {
  private request: ChangeRequest | null = null;
  private settled = false;

  constructor(private readonly d: { client: DeviceClient; ask: ConfirmAsk; settle: (id: string | null) => void }) {
    super({ phase: 'starting', kind: d.ask.kind, name: d.ask.name, mode: 'password' });
  }

  private end(id: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.set({ ...this.state, phase: 'closed' });
    this.d.settle(id);
  }

  async begin(): Promise<void> {
    const [caps, req] = await Promise.all([
      this.d.client.platformCapabilities(),
      this.d.client.confirmRequest(this.d.ask.kind, this.d.ask.name, this.d.ask.change),
    ]);
    if (!req.ok) {
      this.set({ ...this.state, phase: 'asking', error: textForCode(req.code, { screen: 'confirm' }) });
      return;
    }
    this.request = req.data.request;
    if (caps.ok && caps.data.checkKey === true) { this.set({ ...this.state, phase: 'asking', mode: 'touch' }); return; }
    // No check key: the phone first, where there is one (plan 7, DEC-47).
    const sent = await this.d.client.confirmViaPhone(this.request.request_id);
    if (sent.ok) { this.set({ ...this.state, phase: 'asking', mode: 'phone', phoneUntil: sent.data.expiresAt }); return; }
    this.set({ ...this.state, phase: 'asking', mode: 'password', ...(NO_PHONE.has(sent.code) ? {} : { error: textForCode(sent.code, { screen: 'confirm' }) }) });
  }

  /** Phone mode: what became of the request. The page calls it every few seconds. */
  async poll(): Promise<void> {
    if (!this.request || this.state.mode !== 'phone' || this.state.phase !== 'asking' || this.settled) return;
    const r = await this.d.client.confirmPhoneStatus(this.request.request_id);
    if (this.state.mode !== 'phone' || this.settled) return;
    if (!r.ok) {
      if (r.code === 'request_unknown') this.set({ ...this.state, error: T.confirmExpired });
      return;   // anything else: try again on the next poll
    }
    const st = r.data.status;
    if (st === 'confirmed') { this.end(this.request.request_id); return; }
    if (st === 'denied') { this.set({ ...this.state, error: T.confirmPhoneDenied, phoneUntil: undefined }); return; }
    if (st === 'expired') { this.set({ ...this.state, error: T.confirmExpired, phoneUntil: undefined }); return; }
    if (st === 'invalid') { this.set({ ...this.state, error: T.confirmPhoneInvalid, phoneUntil: undefined }); }
  }

  /** Phone mode: "Use the password instead". The phone's request is withdrawn first. */
  async usePassword(): Promise<void> {
    if (!this.request || this.state.mode !== 'phone') return;
    const id = this.request.request_id;
    this.set({ ...this.state, mode: 'password', phoneUntil: undefined, error: undefined });
    await this.d.client.confirmPhoneCancel(id);
    // The withdrawal forgets the request on the computer too: a fresh one for the password.
    const req = await this.d.client.confirmRequest(this.d.ask.kind, this.d.ask.name, this.d.ask.change);
    if (!req.ok) { this.set({ ...this.state, error: textForCode(req.code, { screen: 'confirm' }) }); return; }
    this.request = req.data.request;
  }

  private refused(code: string, retryAfterSeconds?: number): void {
    if (code === 'request_unknown') {
      // The request ran out (300 seconds) or is not this page's: the change has to be made again.
      this.set({ ...this.state, phase: 'asking', error: T.confirmExpired });
      return;
    }
    if (code === 'check_key_required') {
      this.set({ ...this.state, phase: 'asking', mode: 'touch', error: T.confirmUseTouch });
      return;
    }
    this.set({ ...this.state, phase: 'asking', error: textForCode(code, { screen: 'confirm', retryAfterSeconds }) });
  }

  async withPassword(password: string): Promise<void> {
    if (!this.request || this.state.phase === 'busy' || !password) return;
    this.set({ ...this.state, phase: 'busy', error: undefined });
    const r = await this.d.client.confirmWithPassword(this.request.request_id, password);
    if (!r.ok) { this.refused(r.code, r.retryAfterSeconds); return; }
    this.end(this.request.request_id);
  }

  async withTouch(): Promise<void> {
    if (!this.request || this.state.phase === 'busy') return;
    this.set({ ...this.state, phase: 'busy', error: undefined });
    const r = await this.d.client.confirmWithTouch(this.request.request_id);
    if (!r.ok) { this.refused(r.code); return; }
    this.end(this.request.request_id);
  }

  cancel(): void {
    // A request still waiting on the phone is withdrawn, so the phone stops showing it.
    if (this.request && this.state.mode === 'phone') void this.d.client.confirmPhoneCancel(this.request.request_id);
    this.end(null);
  }
}
