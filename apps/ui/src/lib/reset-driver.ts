/**
 * The alarm for a pending request for a new identity (device-keys plan 10, DEC-21/33). The control plane says it at
 * `/auth/device/status` (`pendingIdentityReset`) and rings the doorbell on the event stream
 * (`identity-reset-pending` / `identity-reset-cleared`, type only). The page reads the status, never the event.
 * It is a banner with a way to cancel, never a lock: the cancel is signed with this computer's key.
 */

import { Driver } from './driver';
import type { DeviceClient } from './device-client';
import { textForCode } from './device-texts';

export interface ResetState {
  pending: { id: string; effectiveAt: number } | null;
  busy: boolean;
  error?: string;
  /** Shown after a cancel went through (item 100). */
  cancelled: boolean;
}

export class ResetDriver extends Driver<ResetState> {
  constructor(private readonly client: DeviceClient) {
    super({ pending: null, busy: false, cancelled: false });
  }

  async refresh(): Promise<void> {
    const r = await this.client.status();
    // A status that cannot be read says nothing: keep what is shown rather than clearing a real alarm.
    if (!r.ok) return;
    const p = r.data.pendingIdentityReset;
    this.set({ ...this.state, pending: p ? { id: p.id, effectiveAt: p.effectiveAt } : null, ...(p ? { cancelled: false } : {}) });
  }

  async cancel(): Promise<void> {
    const p = this.state.pending;
    if (!p || this.state.busy) return;
    this.set({ ...this.state, busy: true, error: undefined });
    const r = await this.client.identityResetCancel(p.id);
    if (!r.ok) {
      this.set({ ...this.state, busy: false, error: textForCode(r.code, { screen: 'general', retryAfterSeconds: r.retryAfterSeconds }) });
      return;
    }
    this.set({ pending: null, busy: false, cancelled: true });
  }
}
