import { describe, it, expect } from 'vitest';
import { learnAsKey, proveAsKey, CHALLENGE_MAX_SKEW } from './as-key';
import { FakeAs } from './test-kit';

describe('the server proves it holds the key the phone pinned', () => {
  it('accepts a server that signs under the pinned key', async () => {
    const as = await FakeAs.create();
    expect(await proveAsKey(as, as.keyHex, as.now)).toEqual({ ok: true, keyHex: as.keyHex });
  });

  it('refuses a server that signs under another key, and one whose key is not the pin', async () => {
    const as = await FakeAs.create();
    const other = await FakeAs.create();
    expect(await proveAsKey(as, other.keyHex, as.now)).toEqual({ ok: false, code: 'as_unverified' });
    as.challengeKey = (other as unknown as { key: CryptoKeyPair }).key.privateKey;
    expect(await proveAsKey(as, as.keyHex, as.now)).toEqual({ ok: false, code: 'as_unverified' });
  });

  it('refuses an answer that is stale, or one that echoes another nonce', async () => {
    const as = await FakeAs.create();
    expect(await proveAsKey(as, as.keyHex, () => as.now() + CHALLENGE_MAX_SKEW + 5)).toEqual({ ok: false, code: 'as_unverified' });
    const original = as.call.bind(as);
    as.call = (async (m, p, o) => {
      const r = await original(m, p, o);
      return p === '/api/as/challenge' ? { ...r, body: { ...(r.body as object), nonce: 'other' } } : r;
    }) as FakeAs['call'];
    expect(await proveAsKey(as, as.keyHex, as.now)).toEqual({ ok: false, code: 'as_answer_invalid' });
  });

  it('a pin that is not a hex key is a mismatch; a server that is down is unreachable', async () => {
    const as = await FakeAs.create();
    expect(await proveAsKey(as, 'zz', as.now)).toEqual({ ok: false, code: 'as_key_mismatch' });
    as.down = true;
    expect(await proveAsKey(as, as.keyHex, as.now)).toEqual({ ok: false, code: 'as_unreachable' });
  });

  it('the first registration learns the key the server names, and only if it proves it holds it', async () => {
    const as = await FakeAs.create();
    expect(await learnAsKey(as, as.now)).toEqual({ ok: true, keyHex: as.keyHex });
    const other = await FakeAs.create();
    as.challengeKey = (other as unknown as { key: CryptoKeyPair }).key.privateKey;
    expect(await learnAsKey(as, as.now)).toEqual({ ok: false, code: 'as_unverified' });
  });
});
