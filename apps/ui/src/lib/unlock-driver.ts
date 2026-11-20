/**
 * Unlock the gateway (screen 4) and what follows: the page session, then the sign-in to the account.
 *
 * DEC-66 and DEC-92: Touch ID opens the gateway AND the page (PLATFORM_UNLOCK_OPENS_PAGE_SESSION is true since
 * 2026-11-20); the password stays below it as the fallback, and is the way in where Touch ID is missing. The driver
 * still handles a control plane that answers `sessionOpened: false` (the constant off): then it asks for the password.
 */

import { Driver } from './driver';
import type { DeviceClient } from './device-client';
import { afterUnlock } from './access';
import { T, textForCode, isSilentCode } from './device-texts';

export type UnlockPhase = 'form' | 'signing-in' | 'sign-in-failed' | 'account-key' | 'done';

export interface UnlockState {
  phase: UnlockPhase;
  busy: boolean;
  touchBusy: boolean;
  /** Touch ID unlock is on for this gateway (no session needed to ask). */
  touchAvailable: boolean;
  /** The vault is open (a touch worked) but the page has no session: only the password opens it. */
  passwordOnly: boolean;
  error?: string;
  /** The reason the last page session ended, shown above the form (items 89 to 91, 88). */
  notice?: string;
}

export interface UnlockDeps {
  client: DeviceClient;
  /** The page has its session token: keep it in memory. */
  onSession: (token: string) => void;
  /** Signed in by the device key: read the person, enter the app. Resolves false when the person could not be read. */
  onIn: () => Promise<boolean>;
  /** No device key on this computer: the account-key sign-in follows inside the page session. */
  onAccountKey: () => void;
}

export class UnlockDriver extends Driver<UnlockState> {
  constructor(private readonly d: UnlockDeps, notice?: string) {
    super({ phase: 'form', busy: false, touchBusy: false, touchAvailable: false, passwordOnly: false, ...(notice ? { notice } : {}) });
  }

  async init(): Promise<void> {
    const [r, v] = await Promise.all([this.d.client.platformStatus(), this.d.client.vaultState()]);
    // DEC-95: say the real reason. A session-end notice (idle, 12 h, lock, sleep, user switch) stays as it is. Without
    // one, an OPEN vault means only this page lost its session (a reload, a new tab), never "the computer restarted";
    // a locked vault (or no answer) keeps the restart text.
    const pageOnly = !this.state.notice && v.ok && v.data?.vaultUnlocked === true;
    this.set({ ...this.state, touchAvailable: r.ok && r.data.unlockEnabled === true, ...(pageOnly ? { notice: T.pageNeedsUnlock } : {}) });
  }

  async withPassword(password: string): Promise<void> {
    if (this.state.busy || !password) return;
    this.set({ ...this.state, busy: true, error: undefined });
    const r = await this.d.client.unlock(password);
    if (!r.ok) {
      this.set({ ...this.state, busy: false, error: textForCode(r.code, { screen: 'unlock', retryAfterSeconds: r.retryAfterSeconds }) });
      return;
    }
    this.d.onSession(r.data.sessionToken);
    this.set({ ...this.state, busy: false, notice: undefined, passwordOnly: false });
    await this.afterSession();
  }

  async withTouch(): Promise<void> {
    if (this.state.touchBusy || this.state.busy) return;
    this.set({ ...this.state, touchBusy: true, error: undefined });
    const r = await this.d.client.unlockPlatform();
    if (!r.ok) {
      if (isSilentCode(r.code)) {
        // No message: the person's way on is the password (the vault may already be open).
        this.set({ ...this.state, touchBusy: false, touchAvailable: r.code === 'already_unlocked' ? false : this.state.touchAvailable, passwordOnly: r.code === 'already_unlocked' ? true : this.state.passwordOnly, notice: r.code === 'already_unlocked' ? T.sessionClosed : this.state.notice });
        return;
      }
      this.set({ ...this.state, touchBusy: false, error: textForCode(r.code, { screen: 'unlock', retryAfterSeconds: r.retryAfterSeconds }) });
      return;
    }
    if (r.data.sessionOpened && r.data.sessionToken) {
      this.d.onSession(r.data.sessionToken);
      this.set({ ...this.state, touchBusy: false, notice: undefined, passwordOnly: false });
      await this.afterSession();
      return;
    }
    // The vault is open, the page has no session (PLATFORM_UNLOCK_OPENS_PAGE_SESSION is off): the password opens the page.
    this.set({ ...this.state, touchBusy: false, passwordOnly: true, notice: T.sessionClosed });
  }

  /** After a session exists: sign in to the account by the device key, or hand over to the account-key sign-in. */
  async afterSession(): Promise<void> {
    this.set({ ...this.state, phase: 'signing-in', error: undefined });
    const s = await this.d.client.status();
    if (!s.ok) {
      this.set({ ...this.state, phase: 'sign-in-failed', error: textForCode(s.code, { screen: 'signin' }) });
      return;
    }
    const next = afterUnlock(s.data);
    if (next === 'account-key') { this.set({ ...this.state, phase: 'account-key' }); this.d.onAccountKey(); return; }
    if (next === 'sign-in') {
      const r = await this.d.client.signIn();
      if (!r.ok) {
        this.set({ ...this.state, phase: 'sign-in-failed', error: textForCode(r.code, { screen: 'signin', retryAfterSeconds: r.retryAfterSeconds }) });
        return;
      }
    }
    if (!(await this.d.onIn())) {
      this.set({ ...this.state, phase: 'sign-in-failed', error: T.generic });
      return;
    }
    this.set({ ...this.state, phase: 'done' });
  }

  /** "Try again" after a sign-in that did not work. */
  retry(): Promise<void> {
    return this.afterSession();
  }
}
