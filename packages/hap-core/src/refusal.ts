/**
 * Reading an Authority Server refusal — one reader for the web page, the control
 * plane and the MCP server. Protocol refusals answer the spec envelope
 * `{ approved: false, errors: [{ code, message, ...facts }] }`; older local routes
 * answer `{ error }`, `{ message }` or `{ detail }`. Every caller used to re-derive
 * this, and each new envelope field was re-missed once per copy.
 *
 * Pure and without node imports: the browser bundle imports this file directly
 * (`@hap/core/refusal`), not the package index.
 */
export interface Refusal {
  /** The canonical code, when the server sent one. Match on this, never on the sentence. */
  code?: string;
  /** The server's reason, or the caller's fallback. */
  message: string;
  /** The rest of the refusal's first error: `approvers`, `field`, `cap`, ... */
  facts: Record<string, unknown>;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function readRefusal(body: unknown, fallback = 'The Authority Server refused.'): Refusal {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const first = Array.isArray(b.errors) && b.errors[0] && typeof b.errors[0] === 'object'
    ? (b.errors[0] as Record<string, unknown>)
    : undefined;
  const { code: rawCode, message: rawMessage, ...facts } = first ?? {};
  const code = text(rawCode);
  const message = text(rawMessage) ?? text(rawCode) ?? text(b.message) ?? text(b.detail) ?? text(b.error) ?? fallback;
  return { ...(code ? { code } : {}), message, facts };
}
