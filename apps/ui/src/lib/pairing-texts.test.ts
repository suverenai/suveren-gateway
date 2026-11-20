import { describe, it, expect } from 'vitest';
import { T, textForCode } from './device-texts';
import { PT, PAIRING_ERROR_CODES, pairingErrorText, whenText } from './pairing-texts';
import { PAIRING_CODES } from '../../../control-plane/src/lib/device-pairing';

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : typeof v === 'function' ? [String((v as (...a: string[]) => string)('Office Mac', 'today'))] : [];

describe('every code of the pairing has words', () => {
  it('no code the control plane can say reads as the generic text or as the raw code (other than the generic code itself)', () => {
    for (const code of PAIRING_CODES) {
      // The generic code and a malformed request have no text of their own on purpose (the device-key texts' rule: 103).
      if (code === 'generic' || code === 'bad_request') continue;
      const text = pairingErrorText(code);
      expect(text, code).not.toBe(code);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, `${code} fell through to the generic text`).not.toBe(T.generic);
    }
  });

  it('a code nobody knows reads as the generic text; the phone\'s own reasons (done.refused) have words', () => {
    expect(pairingErrorText('something_new')).toBe(T.generic);
    expect(pairingErrorText(undefined)).toBe(T.generic);
    for (const refused of ['check_cancelled', 'chain_head_moved', 'cancelled_by_phone', 'as_unreachable']) expect(pairingErrorText(refused)).not.toBe(T.generic);
  });

  it('a cancelled touch on THIS computer is not "the phone ended this"', () => {
    expect(pairingErrorText('cancelled')).toBe(textForCode('cancelled'));
    expect(pairingErrorText('cancelled')).not.toBe(pairingErrorText('cancelled_by_phone'));
  });

  it('own codes list is the table', () => {
    expect(PAIRING_ERROR_CODES).toContain('wrong_code');
  });
});

describe('the words follow the rules (DEC-78, DEC-79, the golden rule)', () => {
  const all: string[] = [];
  for (const v of Object.values(PT)) all.push(...strings(v));
  for (const c of PAIRING_ERROR_CODES) all.push(pairingErrorText(c));

  it('no gendered pronoun, no "agent", no "Authority Server", no "receipt"', () => {
    for (const t of all) {
      expect(t, t).not.toMatch(/\b(he|she|him|her|his|hers|himself|herself)\b/i);
      expect(t, t).not.toMatch(/\bagents?\b/i);
      expect(t, t).not.toMatch(/Authority Server/);
      expect(t, t).not.toMatch(/\breceipts?\b/i);
      expect(t, t).not.toMatch(/\bcolleague/i);
    }
  });

  it('"computer" only where a computer is set up, connected or added; a list line says "device"', () => {
    expect(PT.devicesTitle).toBe('Your devices');
    expect(PT.addComputerTitle).toContain('computer');
    expect(PT.devAddPhone).toBe('Add a phone');
  });

  it('the identity code is always named with its noun', () => {
    expect(PT.devIdentity).toContain('identity code');
    expect(PT.reviewIdentity).toBe('Identity code');
  });

  it('DEC-47 step 8: a computer that joins says once whose identity it joins, when, and where it was made', () => {
    expect(PT.reviewMade('My iPhone', 'today')).toBe('This account already has an identity, created today on My iPhone. This computer is being added to it.');
  });
});

describe('whenText', () => {
  it('today, yesterday, n days ago, then a date', () => {
    const now = 1_800_000_000;
    expect(whenText(now - 3600, now)).toBe(PT.whenToday);
    expect(whenText(now - 86400 - 10, now)).toBe(PT.whenYesterday);
    expect(whenText(now - 5 * 86400, now)).toBe('5 days ago');
    expect(whenText(now - 30 * 86400, now)).toMatch(/\d{4}/);
  });
});

describe('one string, both apps (item: no duplicates of the shared pairing texts)', () => {
  it('neither the gateway\'s nor the phone\'s texts module holds a shared sentence as its own literal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { SP, SHARED_ERRORS } = await import('@suveren/approval-card/lib/pairing-texts');
    const files = ['./pairing-texts.ts', '../../../approve/src/texts.ts'].map(f => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'));
    const shared: string[] = [...(Object.values(SP) as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 8), ...Object.values(SHARED_ERRORS)];
    for (const src of files) for (const sentence of shared) expect(src, sentence).not.toContain(`'${sentence}'`);
    expect(PT.devicesTitle).toBe(SP.devicesTitle);
    expect(pairingErrorText('wrong_code')).toBe(SHARED_ERRORS.wrong_code);
  });
});
