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
  /** Which way this computer confirms. */
  mode: 'password' | 'touch';
  error?: string;
}

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
    this.set({ ...this.state, phase: 'asking', mode: caps.ok && caps.data.checkKey === true ? 'touch' : 'password' });
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
    this.end(null);
  }
}
