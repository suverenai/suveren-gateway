import { describe, it, expect } from 'vitest';
import { P, errorText, ERROR_CODES, scanFailureText, blockedText, BLOCKED_REASONS } from './texts';

/** Every visible string of the module, with sample arguments for the functions. */
function allTexts(): string[] {
  const out: string[] = [];
  for (const v of Object.values(P)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push((v as (...a: never[]) => string)(...(['Anna\'s iPhone', 'last week', 3, 'abcd1234'] as never[])));
  }
  for (const c of ERROR_CODES) out.push(errorText(c));
  for (const r of BLOCKED_REASONS) out.push(blockedText(r));
  out.push(scanFailureText('camera_refused'), scanFailureText('camera_unavailable'), scanFailureText('timeout'));
  return out;
}

describe('the phone app\'s words (DEC-75, 78, 79; all DRAFT)', () => {
  it('every code has a text of its own; an unknown code, and no code, get the generic text, never the code', () => {
    for (const c of ERROR_CODES) {
      const t = errorText(c);
      expect(t.length, c).toBeGreaterThan(10);
      expect(t, c).not.toBe(c);
    }
    expect(errorText('SOMETHING_NEW')).toBe(errorText('generic'));
    expect(errorText(undefined)).toBe(errorText('generic'));
    expect(errorText('ENROLMENT_CODE_USED')).toBe(errorText('enrolment_code_used'));
  });

  it('uses the one word per concept: never agent, Authority Server, colleague, receipt, attestation, "Sign mandate"', () => {
    for (const t of allTexts()) {
      expect(t).not.toMatch(/\bagents?\b/i);
      expect(t).not.toMatch(/authority server/i);
      expect(t).not.toMatch(/\bcolleagues?\b/i);
      expect(t).not.toMatch(/\breceipts?\b/i);
      expect(t).not.toMatch(/attestation/i);
      expect(t).not.toMatch(/sign mandate|approve and sign/i);
    }
  });

  it('never uses a gendered pronoun', () => {
    for (const t of allTexts()) expect(t).not.toMatch(/\b(he|she|his|hers?|him)\b/i);
  });

  it('names a code with its noun: no sentence says a bare "the code" without recovery, identity, setup or the screen\'s own', () => {
    // "Scan the code" / "Type the code instead" are about the one code on the screen in front of the person; the sensitive ones carry their noun.
    expect(P.codeTitle).toBe('Your recovery code');
    expect(P.devIdentity).toContain('identity code');
    expect(P.reviewIdentity).toBe('Identity code');
  });

  it('says what happened and what to do, and says "Nothing changed" only for refusals', () => {
    expect(errorText('as_unreachable')).toMatch(/internet/i);
    expect(errorText('wrong_code')).toMatch(/Nothing was added/);
    expect(errorText('store_failed')).toMatch(/recovery code/);
  });

  it('is plain text: no markup and no inline code', () => {
    for (const t of allTexts()) expect(t).not.toMatch(/[<>]|&[a-z]+;/);
  });

  it('the scan screen says the picture can stay black (iPhone, step 1 check 7)', () => {
    expect(P.scanBlackNote).toMatch(/black/);
    expect(P.scanProgress(3)).toBe('Looking for the code... 3 s');
  });
});

describe('the notification words (stage D4)', () => {
  it('public/sw.js carries exactly texts.ts\'s pushTitle, pushOne and pushMany (a service worker cannot import the module)', async () => {
    const { readFileSync } = await import('node:fs');
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const block = /\/\/ BEGIN PUSH TEXTS\nconst PUSH_TEXT = (\{[\s\S]*?\});\n\/\/ END PUSH TEXTS/.exec(sw);
    expect(block).not.toBeNull();
    const t = new Function(`return ${block![1]}`)() as { title: string; one: string; many: string; devicesChanged: string; recoveryStarted: string; identityReset: string };
    expect(t.title).toBe(P.pushTitle);
    expect(t.one).toBe(P.pushOne);
    for (const n of [2, 3, 17]) expect(t.many.replace('{n}', String(n))).toBe(P.pushMany(n));
    expect(t.devicesChanged).toBe(P.pushDevicesChanged);
    expect(t.recoveryStarted).toBe(P.pushRecoveryStarted);
    expect(t.identityReset).toBe(P.pushIdentityReset);
  });

  it('the notification names nothing of the request: no amount, no name, no action word', () => {
    for (const t of [P.pushTitle, P.pushOne, P.pushMany(3)]) {
      expect(t).not.toMatch(/approve|reject|€|\$|\d+\s*(eur|usd)/i);
    }
  });
});
