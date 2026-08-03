/**
 * Outgoing argument encoding — keeping a BOUND value intact in transit.
 *
 * Found by a live send, not by reasoning: a subject containing an em-dash was
 * hashed correctly and delivered as `Content binding test Ã¢Â€Â” email@0.5`,
 * because RFC 5322 headers are ASCII-only and the connector wrote raw UTF-8.
 * The receipt verified against the approved bytes while the recipient — holding
 * the mangled copy — could not reproduce it.
 *
 * That is the dangerous shape: a FALSE mismatch on honest mail teaches people
 * that mismatches are noise. These tests pin the fix and, just as importantly,
 * pin that mail which already works is left alone.
 */
import { describe, it, expect } from 'vitest';
import { rfc2047Encode, encodeOutgoingArgs } from '../src/lib/arg-encoding';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const toolWith = (argEncoding?: Record<string, string>) =>
  ({ namespacedName: 'gmail__send_message', gating: { profile: 'email', argEncoding } }) as unknown as DiscoveredTool;

/** Decode an RFC 2047 Q encoded-word run, as a receiving mail client would. */
function decodeRfc2047(input: string): string {
  return input
    .split(/\s+/)
    .map((word) => {
      const m = word.match(/^=\?UTF-8\?Q\?([\s\S]*)\?=$/);
      if (!m) return word;
      const bytes: number[] = [];
      const payload = m[1];
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] === '=') { bytes.push(parseInt(payload.slice(i + 1, i + 3), 16)); i += 2; }
        else if (payload[i] === '_') bytes.push(0x20);
        else bytes.push(payload.charCodeAt(i));
      }
      return Buffer.from(bytes).toString('utf8');
    })
    .join('');
}

describe('rfc2047Encode — leaves working mail alone', () => {
  it('returns pure ASCII unchanged', () => {
    expect(rfc2047Encode('Quarterly report Q3')).toBe('Quarterly report Q3');
    expect(rfc2047Encode('')).toBe('');
  });
});

describe('rfc2047Encode — round-trips what the transport would mangle', () => {
  it.each([
    ['the live failure', 'Content binding test — email@0.5'],
    ['German', 'Grüße aus Österreich'],
    ['sharp s and umlauts', 'Übermäßig große Anfrage'],
    ['emoji (4-byte UTF-8)', 'Deploy ✅ done 🚀'],
    ['CJK', '第3四半期の報告'],
    ['mixed with punctuation', 'Re: Angebot — 50 % Rabatt (gültig?)'],
  ])('%s survives encode → decode', (_label, subject) => {
    const encoded = rfc2047Encode(subject);
    expect(encoded).not.toBe(subject);
    expect(decodeRfc2047(encoded)).toBe(subject);
  });

  it('emits only ASCII — the whole point, since headers cannot carry more', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(rfc2047Encode('Grüße — Österreich ✅'))).toBe(false);
  });

  it('keeps every encoded word within the RFC 2047 75-char limit', () => {
    const long = 'Über die außerordentliche Größe der Anfrage — Quartalsbericht für Österreich und die Schweiz';
    for (const word of rfc2047Encode(long).split(' ')) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeRfc2047(rfc2047Encode(long))).toBe(long);
  });

  it('never splits a multi-byte character across encoded words', () => {
    // 'ü' is two bytes; a naive byte-wise split would corrupt one of them.
    const many = 'ü'.repeat(120);
    expect(decodeRfc2047(rfc2047Encode(many))).toBe(many);
  });

  it('short subjects stay in ONE word, so the connector cannot fold the header', () => {
    // The Gmail connector breaks any line >76 chars with `=\n`, which is a
    // body-level soft break and invalid in a header. A single encoded word plus
    // the "Subject: " prefix must therefore stay inside that budget.
    const encoded = rfc2047Encode('Content binding test — email@0.5');
    expect(encoded.split(' ').length).toBe(1);
    expect('Subject: '.length + encoded.length).toBeLessThanOrEqual(76);
  });
});

describe('encodeOutgoingArgs — declared per connector, applied by the engine', () => {
  it('encodes only the declared field, leaving the body untouched', () => {
    const args = { to: ['a@x.com'], subject: 'Grüße', body: 'Grüße im Text — unverändert' };
    const out = encodeOutgoingArgs(toolWith({ subject: 'rfc2047' }), args);
    expect(decodeRfc2047(out.subject as string)).toBe('Grüße');
    expect(out.body).toBe('Grüße im Text — unverändert'); // body declares its own charset
    expect(out.to).toEqual(['a@x.com']);
  });

  it('returns the SAME object when the tool declares nothing', () => {
    const args = { subject: 'Grüße' };
    expect(encodeOutgoingArgs(toolWith(undefined), args)).toBe(args);
  });

  it('returns the SAME object when nothing needed encoding', () => {
    const args = { subject: 'Plain ASCII' };
    expect(encodeOutgoingArgs(toolWith({ subject: 'rfc2047' }), args)).toBe(args);
  });

  it('does not mutate the caller\'s args', () => {
    const args = { subject: 'Grüße' };
    encodeOutgoingArgs(toolWith({ subject: 'rfc2047' }), args);
    expect(args.subject).toBe('Grüße');
  });

  it('ignores a declared field that is absent or not a string', () => {
    expect(encodeOutgoingArgs(toolWith({ subject: 'rfc2047' }), { body: 'x' })).toEqual({ body: 'x' });
    expect(encodeOutgoingArgs(toolWith({ subject: 'rfc2047' }), { subject: 42 })).toEqual({ subject: 42 });
  });

  it('sends the value unencoded rather than guessing at an unknown encoding', () => {
    const args = { subject: 'Grüße' };
    expect(encodeOutgoingArgs(toolWith({ subject: 'base64ish' }), args).subject).toBe('Grüße');
  });
});

describe('the shipped gmail manifest declares it', () => {
  it('send_message and create_draft encode the subject', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'gmail.json'), 'utf-8'),
    );
    for (const tool of ['send_message', 'create_draft']) {
      expect(manifest.toolGating.overrides[tool].argEncoding).toEqual({ subject: 'rfc2047' });
    }
  });
});
