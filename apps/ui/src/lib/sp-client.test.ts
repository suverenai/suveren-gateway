import { describe, it, expect, vi, afterEach } from 'vitest';
import { asErrorMessage, spClient } from './sp-client';

/**
 * Bug: a v0.7 Authority Server refusal answers the spec envelope
 * `{ approved: false, errors: [{ code, message, field? }] }`. Reading
 * `err.error` (the pre-0.7 shape) on that body is `undefined`, so the person
 * only ever saw "Attest failed: 422" / "Signing failed: 422" — never the
 * AS's actual reason (e.g. PROFILE_INVALID — an old profile version can no
 * longer be issued a new mandate under). asErrorMessage() is the fix: read
 * errors[0] first, fall back to the legacy shape, then the given default.
 */
describe('asErrorMessage', () => {
  it('reads the v0.7 refusal envelope — message plus code', () => {
    const body = {
      approved: false,
      errors: [{ code: 'PROFILE_INVALID', message: 'Profile email@0.4 fails v0.7 validation.' }],
    };
    expect(asErrorMessage(body, 'Signing failed: 422')).toBe(
      'Profile email@0.4 fails v0.7 validation. (PROFILE_INVALID)',
    );
  });

  it('falls back to just the code when the envelope has no message', () => {
    const body = { approved: false, errors: [{ code: 'PROFILE_INVALID' }] };
    expect(asErrorMessage(body, 'Signing failed: 422')).toBe('PROFILE_INVALID');
  });

  it('falls back to the legacy { error } shape for non-protocol endpoints', () => {
    expect(asErrorMessage({ error: 'Invalid API key' }, 'Login failed: 401')).toBe('Invalid API key');
  });

  it('falls back to { detail } when neither errors nor error is present', () => {
    expect(asErrorMessage({ detail: 'something broke' }, 'fallback')).toBe('something broke');
  });

  it('falls back to the given default for an empty or unrecognized body', () => {
    expect(asErrorMessage({}, 'fallback text')).toBe('fallback text');
    expect(asErrorMessage(null, 'fallback text')).toBe('fallback text');
    expect(asErrorMessage(undefined, 'fallback text')).toBe('fallback text');
  });

  it('ignores an empty errors array and falls through to the default', () => {
    expect(asErrorMessage({ approved: false, errors: [] }, 'fallback')).toBe('fallback');
  });
});

describe('spClient.attest() surfaces the AS refusal reason (v0.7 envelope)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws the AS message + code on a 422 PROFILE_INVALID refusal, not "Attest/Signing failed: 422"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          approved: false,
          errors: [{
            code: 'PROFILE_INVALID',
            message:
              'Profile github.com/humanagencyprotocol/hap-profiles/email@0.4 fails v0.7 validation and cannot be issued a new mandate under.',
          }],
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      spClient.attest({
        authorization_id: 'authz_test',
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/email@0.4',
        profile_hash: 'hash',
        supported_versions: ['0.7'],
        domain: 'owner',
        did: 'did:key:test',
        gate_content_hashes: { intent: 'hash' },
        execution_context_hash: 'hash',
        group_id: 'group_test',
        commitment_mode: 'automatic',
      }),
    ).rejects.toThrow(/fails v0\.7 validation.*\(PROFILE_INVALID\)/);
  });
});
