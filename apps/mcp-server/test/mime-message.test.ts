/**
 * mime-message.ts — the "mime-raw" transport's MIME builder (Gmail's `raw`).
 * Round-trips the built message through a small test-only multipart parser
 * (no production dependency — this builds exactly one shape, see the
 * module's own header comment) to prove headers, boundary, and each part's
 * decoded bytes match what was given.
 */
import { describe, it, expect } from 'vitest';
import { buildMimeMessage, toBase64Url, rfc2047Encode } from '../src/lib/mime-message';

/** Minimal multipart/mixed parser — enough to round-trip what buildMimeMessage emits. */
function parseMime(raw: string): {
  headers: Record<string, string>;
  parts: Array<{ headers: Record<string, string>; bodyBase64: string }>;
} {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerBlock = raw.slice(0, headerEnd);
  const rest = raw.slice(headerEnd + 4);
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(': ');
    if (idx === -1) continue;
    headers[line.slice(0, idx)] = line.slice(idx + 2);
  }
  const boundaryMatch = headers['Content-Type'].match(/boundary="([^"]+)"/);
  if (!boundaryMatch) throw new Error('no boundary found');
  const boundary = boundaryMatch[1];
  const rawParts = rest.split(`--${boundary}`).slice(1, -1); // drop preamble and the closing `--`
  const parts = rawParts.map(block => {
    const trimmed = block.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const hEnd = trimmed.indexOf('\r\n\r\n');
    const hBlock = trimmed.slice(0, hEnd);
    const body = trimmed.slice(hEnd + 4);
    const h: Record<string, string> = {};
    for (const line of hBlock.split('\r\n')) {
      const idx = line.indexOf(': ');
      if (idx === -1) continue;
      h[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return { headers: h, bodyBase64: body.replace(/\r\n/g, '') };
  });
  return { headers, parts };
}

describe('rfc2047Encode', () => {
  it('leaves ASCII text unchanged', () => {
    expect(rfc2047Encode('Rechnung 2026-0003')).toBe('Rechnung 2026-0003');
  });

  it('encodes non-ASCII text as a UTF-8 base64 encoded-word', () => {
    const encoded = rfc2047Encode('Rechnung für Müller');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const b64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Rechnung für Müller');
  });
});

describe('buildMimeMessage / toBase64Url', () => {
  const attachment = {
    filename: 'invoice-2026-0003.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from('%PDF-1.4 fake invoice bytes').toString('base64'),
  };

  it('produces a multipart/mixed message whose parts round-trip exactly', () => {
    const mime = buildMimeMessage({
      to: ['buchhaltung@drautal.at'],
      cc: ['andreas@sublin.app'],
      subject: 'Rechnung 2026-0003',
      bodyText: 'Sehr geehrte Damen und Herren,\n\nanbei die Rechnung.',
      attachments: [attachment],
    });

    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('To: buchhaltung@drautal.at');
    expect(mime).toContain('Cc: andreas@sublin.app');

    const parsed = parseMime(mime);
    expect(parsed.parts).toHaveLength(2);

    const [textPart, attachmentPart] = parsed.parts;
    expect(textPart.headers['Content-Type']).toContain('text/plain');
    expect(Buffer.from(textPart.bodyBase64, 'base64').toString('utf8')).toBe(
      'Sehr geehrte Damen und Herren,\n\nanbei die Rechnung.',
    );

    expect(attachmentPart.headers['Content-Type']).toContain('application/pdf');
    expect(attachmentPart.headers['Content-Disposition']).toContain('attachment');
    expect(attachmentPart.headers['Content-Disposition']).toContain('invoice-2026-0003.pdf');
    expect(Buffer.from(attachmentPart.bodyBase64, 'base64').toString('utf8')).toBe('%PDF-1.4 fake invoice bytes');
  });

  it('RFC 2047-encodes a non-ASCII subject and filename', () => {
    const mime = buildMimeMessage({
      to: ['x@y.com'],
      subject: 'Rechnung für März',
      bodyText: 'Hallo',
      attachments: [{ ...attachment, filename: 'Rechnung-März.pdf' }],
    });
    const parsed = parseMime(mime);
    expect(parsed.headers.Subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(parsed.parts[1].headers['Content-Disposition']).toMatch(/filename="=\?UTF-8\?B\?/);
  });

  it('toBase64Url produces padding-free, URL-safe base64 of the exact message', () => {
    const mime = buildMimeMessage({ to: ['x@y.com'], subject: 'S', bodyText: 'B', attachments: [] });
    const encoded = toBase64Url(mime);
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toBe(mime);
  });

  it('supports several attachments, each byte-exact', () => {
    const second = { filename: 'terms.txt', contentType: 'text/plain', contentBase64: Buffer.from('Terms and conditions').toString('base64') };
    const mime = buildMimeMessage({ to: ['x@y.com'], subject: 'S', bodyText: 'B', attachments: [attachment, second] });
    const parsed = parseMime(mime);
    expect(parsed.parts).toHaveLength(3);
    expect(Buffer.from(parsed.parts[1].bodyBase64, 'base64').toString('utf8')).toBe('%PDF-1.4 fake invoice bytes');
    expect(Buffer.from(parsed.parts[2].bodyBase64, 'base64').toString('utf8')).toBe('Terms and conditions');
  });
});
