/**
 * MIME message builder — for connectors whose `attachments` transport is
 * `"mime-raw"` (tool-gating-types.ts `AttachmentTransportConfig`): no
 * attachments argument exists, so the gateway builds a complete RFC 5322
 * message itself from the ALREADY-CHECKED to/cc/bcc/subject/body and the
 * resolved attachment bytes, then passes it base64url-encoded in the
 * connector's own `raw` argument (suveren-invoicing-plan.md §6 — Gmail).
 *
 * Deliberately small and dependency-free (justification for not pulling in
 * a MIME library: this builds exactly one shape — multipart/mixed, one
 * text/plain body part plus N attachment parts, each base64 — not a general
 * email parser/builder). No external MIME parsing library exists in this
 * monorepo; adding one for ~120 lines of well-understood wire format was
 * judged not worth the dependency.
 */

export interface MimeAttachment {
  filename: string;
  contentType: string;
  /** Already base64-encoded bytes (as returned by document-source.ts). */
  contentBase64: string;
}

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  attachments: MimeAttachment[];
}

const CRLF = '\r\n';

/** True iff every character is printable US-ASCII (no encoding needed). */
function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * RFC 2047 encoded-word for a header value or a filename, UTF-8 + base64
 * (`=?UTF-8?B?...?=`). ASCII-only input is returned unchanged — encoding an
 * already-safe value would just make it harder to read for no reason.
 */
export function rfc2047Encode(value: string): string {
  if (isAscii(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** Base64, wrapped at 76 characters per line (RFC 2045 § 6.8). */
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/** A reasonably unique boundary — never appears in base64 or ASCII headers. */
function makeBoundary(): string {
  const random = Buffer.from(
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
  ).toString('hex');
  return `----=_SuverenPart_${random}`;
}

function addressHeader(name: string, addresses: string[] | undefined): string {
  if (!addresses?.length) return '';
  return `${name}: ${addresses.join(', ')}${CRLF}`;
}

/**
 * Builds a complete RFC 5322 multipart/mixed message as a CRLF-joined
 * string (not yet base64url-encoded — see {@link toBase64Url}). `bcc` is
 * included on the ENVELOPE only in the sense that most transports read it
 * from a header and strip it before delivery; since this builder has no
 * transport of its own, `bcc` is intentionally OMITTED from the built
 * headers (an email's `bcc` is never bound/shown either — content-
 * binding.ts) and must be passed to the connector by its own separate
 * mechanism if it has one. (None of today's manifests declare one.)
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const boundary = makeBoundary();
  const headers =
    `MIME-Version: 1.0${CRLF}` +
    addressHeader('To', input.to) +
    addressHeader('Cc', input.cc) +
    `Subject: ${rfc2047Encode(input.subject)}${CRLF}` +
    `Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}`;

  const textPart =
    `--${boundary}${CRLF}` +
    `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrapBase64(Buffer.from(input.bodyText, 'utf8').toString('base64')) +
    CRLF;

  const attachmentParts = input.attachments.map(att => {
    const name = rfc2047Encode(att.filename);
    return (
      `--${boundary}${CRLF}` +
      `Content-Type: ${att.contentType}; name="${name}"${CRLF}` +
      `Content-Disposition: attachment; filename="${name}"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
      wrapBase64(att.contentBase64) +
      CRLF
    );
  });

  return headers + CRLF + [textPart, ...attachmentParts].join('') + `--${boundary}--${CRLF}`;
}

/** Base64url (no padding) — the encoding Gmail's `raw` argument expects. */
export function toBase64Url(mime: string): string {
  return Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
