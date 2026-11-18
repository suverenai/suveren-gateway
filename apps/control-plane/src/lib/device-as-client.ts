/**
 * The gateway's calls to the Authority Server's device-key routes
 * (`/api/devices/*`, `/api/connect/token`; device-keys plan 6.2). One place for:
 * the TLS pin (as-tls-pin.ts), a bound on every call, no redirects (a redirect
 * must never carry a token or a code to another host), and the AS refusal
 * envelope `{ approved: false, errors: [{ code, message }] }` read into a code.
 *
 * Never logs a request or response body: bodies carry tokens, nonces and codes.
 */

import { fetchAs, AsTlsMismatchError, type AsFetchPinning } from './as-tls-pin';
import { clientVersionHeaders } from './client-version';

export class AsUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsUnreachableError';
  }
}

export interface AsReply {
  status: number;
  /** Parsed JSON, or null when the body was not JSON. */
  body: unknown;
}

export interface DeviceAsClientOptions {
  asUrl: string;
  pinning: () => AsFetchPinning;
  /** A TLS pin mismatch on a call: the caller locks the gateway (session-lock.ts). */
  onTlsMismatch?: () => void;
  timeoutMs?: number;
}

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The AS's refusal code from `{ approved:false, errors:[{ code }] }`, only when it looks like a code. */
export function asErrorCode(body: unknown): string | undefined {
  const first = (body as { errors?: unknown })?.errors;
  const code = Array.isArray(first) ? (first[0] as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' && CODE_SHAPE.test(code) ? code : undefined;
}

export class DeviceAsClient {
  constructor(private readonly o: DeviceAsClientOptions) {}

  get asUrl(): string {
    return this.o.asUrl;
  }

  /**
   * @param bearer the whole `Authorization` value (`Bearer <token>`), when the call is made as a signed-in device.
   * @throws AsUnreachableError on a network failure, a timeout or a redirect; a TLS pin mismatch calls `onTlsMismatch` and throws {@link AsTlsMismatchError}.
   */
  async call(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<AsReply> {
    const headers: Record<string, string> = { ...clientVersionHeaders() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.bearer) headers.Authorization = opts.bearer;
    let res: Response;
    try {
      ({ res } = await fetchAs(`${this.o.asUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      }, this.o.pinning()));
    } catch (err) {
      if (err instanceof AsTlsMismatchError) {
        this.o.onTlsMismatch?.();
        throw err;
      }
      throw new AsUnreachableError(err instanceof Error ? err.message : 'request failed');
    }
    if (res.status >= 300 && res.status < 400) throw new AsUnreachableError('the Authority Server answered with a redirect');
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }
}
