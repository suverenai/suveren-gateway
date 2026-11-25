/**
 * The ONE network module (plan 8, "One network interface"). Every call to the server goes through a {@link Transport}.
 * The first version has one implementation, {@link DirectTransport} (the Authority Server itself); a relay (plan
 * section 16) would be a second one behind the same interface. No other file calls `fetch`.
 *
 * Rules: no cookies and no credentials are ever sent (a bearer token travels in the `Authorization` header and nowhere
 * else); a redirect is an error (it must never carry a token or a code to another host); every call is bounded in time;
 * a body is never logged. The CSP's `connect-src` allows only the Authority Server's origin, so a call anywhere else
 * would be blocked by the browser as well.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Reply {
  status: number;
  /** Parsed JSON, or null when the body was not JSON. */
  body: unknown;
}

export interface Transport {
  call(method: Method, path: string, opts?: { body?: unknown; bearer?: string }): Promise<Reply>;
}

/** Nothing could be asked: no network, a timeout, a redirect. Never carries the request. */
export class UnreachableError extends Error {
  constructor(message = 'unreachable') {
    super(message);
    this.name = 'UnreachableError';
  }
}

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The Authority Server's refusal code from `{ approved: false, errors: [{ code }] }`, only when it looks like a code. */
export function asErrorCode(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | null)?.errors;
  const code = Array.isArray(errors) ? (errors[0] as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' && CODE_SHAPE.test(code) ? code : undefined;
}

export class DirectTransport implements Transport {
  constructor(
    private readonly asUrl: string,
    private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a),
    private readonly timeoutMs = 10_000,
  ) {}

  async call(method: Method, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Reply> {
    if (!path.startsWith('/')) throw new Error('a path starts with /');
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.asUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new UnreachableError();
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new UnreachableError('redirect');
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }
}
