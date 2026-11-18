/**
 * The page's calls to the control plane's device-key routes (/auth/password/*, /auth/unlock*, /auth/device/*,
 * /auth/platform/*, /auth/confirm*). One place, typed; every answer is `{ ok: true, data }` or
 * `{ ok: false, code, status, ... }` so a screen never reads a raw body. The control plane's `message` is a
 * placeholder and is never shown: screens map `code` with lib/device-texts.ts.
 */

import { spClient } from './sp-client';

export type Result<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; code: string; status: number; retryAfterSeconds?: number; asCode?: string; extra: Record<string, unknown> };

/** What the page can send: injected so tests run the screens without a network. */
export type Transport = (path: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });

async function read<T>(res: Response): Promise<Result<T>> {
  let body: Record<string, unknown> | null = null;
  try { body = await res.json() as Record<string, unknown>; } catch { body = null; }
  if (res.ok) return { ok: true, data: (body ?? {}) as T, status: res.status };
  const reason = typeof body?.reason === 'string' ? body.reason : undefined;
  const code = typeof body?.code === 'string' ? body.code : 'bad_request';
  return {
    ok: false,
    // A refused page session names its reason beside the neutral `unauthorized`: the reason is the useful word.
    code: code === 'unauthorized' && reason ? reason : code,
    status: res.status,
    ...(typeof body?.retryAfterSeconds === 'number' ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
    ...(typeof body?.asCode === 'string' ? { asCode: body.asCode } : {}),
    extra: body ?? {},
  };
}

/** A network failure is one more refusal the screens know: nothing reached the gateway. */
function unreachable<T>(): Result<T> {
  return { ok: false, code: 'gateway_unreachable', status: 0, extra: {} };
}

// ─── Answers ──────────────────────────────────────────────────────────────

export interface PasswordStatus { passwordSet: boolean }
export interface UnlockAnswer { ok: true; rekeyPending?: boolean; sessionToken: string }
export interface PlatformStatus { unlockEnabled: boolean }
export interface PlatformUnlockAnswer { unlocked: true; sessionOpened: boolean; sessionToken?: string }
export interface PlatformCapabilities { unlockEnabled: boolean; checkKey: boolean; available?: boolean }

export interface PendingIdentityReset { id: string; effectiveAt: number; raisedAt?: number }
export interface RecoveryStatus { recoveryPending: boolean; kind?: 'reset' | 'rotate'; handoff?: 'waiting' | 'authorised' | 'failed' | 'expired'; confirmCode?: string }
export interface DeviceStatus {
  setUp: boolean;
  setupPending: boolean;
  connect?: 'waiting' | 'ready' | 'failed';
  signedIn: boolean;
  expiresAt?: number;
  pendingIdentityReset?: PendingIdentityReset | null;
  recovery?: RecoveryStatus;
}
export interface ConnectAccount { name: string; email: string }
export interface SetupStarted { setupId: string; recoveryCode: string; rootDid: string; deviceKeyId: string; label: string }
export interface ConnectStarted { authorizeUrl: string; expiresAt: number }
export interface ConnectStatus { state: 'waiting' | 'ready' | 'failed' | 'expired'; code?: string; asCode?: string; account?: ConnectAccount }
export interface SetupFinished { rootDid: string; deviceKeyId: string; signedIn: boolean; signinCode?: string; account?: ConnectAccount }
export interface SignedIn { expiresAt: number }
export interface HandoffStarted {
  recoveryId: string; pageUrl: string; confirmCode: string; expiresAt: number; rootDid?: string;
  removes?: Array<{ label: string; kind: string }>; pendingIdentityReset?: { id: string; effectiveAt: number };
  adopted?: true;
}
export interface HandoffStatus { state: 'waiting' | 'authorised' | 'failed' | 'expired'; code?: string; asCode?: string }
export interface RecoverFinished { rootDid: string; deviceKeyId: string; signedIn: boolean; signinCode?: string }
export interface RotateStarted { rotateId: string; recoveryCode: string; expiresAt: number }
export interface ChangeRequest { request_id: string; kind: 'replace' | 'remove'; name: string; change_hash: string; expires_at: number }

export class DeviceClient {
  constructor(private readonly send: Transport = (p, i) => spClient.request(p, i)) {}

  private async go<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    try { return await read<T>(await this.send(path, init)); } catch { return unreachable<T>(); }
  }

  // Probes that need no session
  passwordStatus() { return this.go<PasswordStatus>('/auth/password/status'); }
  platformStatus() { return this.go<PlatformStatus>('/auth/platform/status'); }

  // Password and unlock
  setPassword(apiKey: string, password: string) {
    return this.go<UnlockAnswer & { rekeyPending?: boolean }>('/auth/password/set', { ...json({ password }), headers: { 'X-API-Key': apiKey } });
  }
  unlock(password: string) { return this.go<UnlockAnswer>('/auth/unlock', json({ password })); }
  unlockPlatform() { return this.go<PlatformUnlockAnswer>('/auth/unlock/platform', json({})); }
  platformCapabilities() { return this.go<PlatformCapabilities>('/auth/platform/capabilities'); }

  // Device status and sign-in
  status() { return this.go<DeviceStatus>('/auth/device/status'); }
  signIn() { return this.go<SignedIn>('/auth/device/signin', json({})); }

  // Set-up
  setupStart(label: string, checkKey?: boolean) { return this.go<SetupStarted>('/auth/device/setup/start', json({ label, ...(checkKey !== undefined ? { checkKey } : {}) })); }
  setupCancel() { return this.go<Record<string, never>>('/auth/device/setup/cancel', json({})); }
  connectStart(setupId: string) { return this.go<ConnectStarted>('/auth/device/setup/connect', json({ setupId })); }
  connectStatus(setupId: string) { return this.go<ConnectStatus>(`/auth/device/setup/connect/status?setupId=${encodeURIComponent(setupId)}`); }
  setupFinish(setupId: string) { return this.go<SetupFinished>('/auth/device/setup/finish', json({ setupId })); }

  // Recovery with the recovery code, replacing it, cancelling a request for a new identity
  recoverStart(code: string, label?: string) { return this.go<HandoffStarted>('/auth/device/recover/start', json({ code, ...(label ? { label } : {}) })); }
  recoverStatus(recoveryId: string) { return this.go<HandoffStatus>(`/auth/device/recover/status?recoveryId=${encodeURIComponent(recoveryId)}`); }
  recoverFinish(recoveryId: string) { return this.go<RecoverFinished>('/auth/device/recover/finish', json({ recoveryId })); }
  recoverCancel() { return this.go<{ cancelled?: true }>('/auth/device/recover/cancel', json({})); }
  rotateStart() { return this.go<RotateStarted>('/auth/device/rotate-root/start', json({})); }
  rotateSubmit(rotateId: string, oldCode: string, newCode: string) { return this.go<HandoffStarted>('/auth/device/rotate-root/submit', json({ rotateId, oldCode, newCode })); }
  rotateStatus(recoveryId: string) { return this.go<HandoffStatus>(`/auth/device/rotate-root/status?recoveryId=${encodeURIComponent(recoveryId)}`); }
  rotateFinish(recoveryId: string) { return this.go<{ rootDid: string }>('/auth/device/rotate-root/finish', json({ recoveryId })); }
  identityResetCancel(requestId: string) { return this.go<{ cancelled: true; requestId: string }>('/auth/device/identity-reset/cancel', json({ requestId })); }

  // Confirming a change to a stored login
  confirmRequest(kind: 'replace' | 'remove', name: string, change: unknown) { return this.go<{ request: ChangeRequest }>('/auth/confirm/request', json({ kind, name, change })); }
  confirmWithPassword(requestId: string, password: string) { return this.go<{ confirmation: string }>('/auth/confirm', json({ request_id: requestId, password })); }
  confirmWithTouch(requestId: string) { return this.go<{ confirmation: string }>('/auth/confirm/check', json({ request_id: requestId })); }
}

export const deviceClient = new DeviceClient();
