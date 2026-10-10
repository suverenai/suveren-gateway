/**
 * content-hash — browser-side mirror of hap-core's content-binding.ts.
 *
 * Pins the SAME (content → hash) vectors as hap-core/test/content-binding.test.ts
 * (computeContentHash — pinned vectors). If this file and that one ever
 * disagree, a receipt the gateway (Node) signed would fail to verify here
 * (browser) — the whole point of local, offline verification.
 */
import { describe, it, expect } from 'vitest';
import { computeContentHashBrowser } from './content-hash';

describe('computeContentHashBrowser — pinned vectors (must match hap-core content-binding.ts)', () => {
  it('jcs: sorts keys then hashes (order-independent)', async () => {
    const a = await computeContentHashBrowser('jcs', { title: 'Q3 plan', type: 'note' });
    const b = await computeContentHashBrowser('jcs', { type: 'note', title: 'Q3 plan' });
    expect(a).toBe('sha256:82c28e63f951c1ac68080788fda46be42b2128f80c43dbc01d5c3b160a09717f');
    expect(a).toBe(b);
  });

  it('text: hashes the canonicalized string', async () => {
    expect(await computeContentHashBrowser('text', 'Hello\r\nWorld  '))
      .toBe('sha256:35c6b9f66dceb6cf8f733d08689564e420e18eb40250d9435352617c027f36d6');
  });

  it('text: empty string hashes the sha256 of ""', async () => {
    expect(await computeContentHashBrowser('text', ''))
      .toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('computeContentHashBrowser — kind/content mismatch fails closed', () => {
  it('jcs rejects a string', async () => {
    await expect(computeContentHashBrowser('jcs', 'oops' as unknown as Record<string, unknown>))
      .rejects.toThrow(/jcs.*record payload/);
  });

  it('text rejects an object', async () => {
    await expect(computeContentHashBrowser('text', { x: 1 } as unknown as string))
      .rejects.toThrow(/text.*string/);
  });
});

describe('computeContentHashBrowser — change detection', () => {
  it('a different object hashes differently', async () => {
    const a = await computeContentHashBrowser('jcs', { contact: 'cust-1', text: 'original note' });
    const b = await computeContentHashBrowser('jcs', { contact: 'cust-1', text: 'altered note' });
    expect(a).not.toBe(b);
  });

  it('nested objects and arrays canonicalize deterministically regardless of key order', async () => {
    const a = await computeContentHashBrowser('jcs', { to: ['a@x.example', 'b@x.example'], meta: { x: 1, y: 2 } });
    const b = await computeContentHashBrowser('jcs', { meta: { y: 2, x: 1 }, to: ['a@x.example', 'b@x.example'] });
    expect(a).toBe(b);
  });
});
