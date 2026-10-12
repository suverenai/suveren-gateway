/**
 * content-crypto tests — PE1 proposal content encryption (toolArgs + notes).
 *
 * Mirrors e2e-crypto.test.ts's style, but resolves recipients via a mocked
 * `fetchAs` (the AS pubkey lookup) rather than caller-supplied keys — the
 * behaviour this module adds on top of e2e-crypto.ts's broadcast pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalize } from '@hap/core';
import { generateKeyPair } from '../src/lib/e2e-crypto';

const fetchAsMock = vi.fn();
vi.mock('../src/lib/as-tls-pin', () => ({
  fetchAs: (...args: unknown[]) => fetchAsMock(...args),
}));
vi.mock('../src/lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../src/lib/as-config', () => ({ resolvePinTls: () => false }));

import {
  computeProposalContentHash,
  encryptProposalContent,
  encryptProposalNote,
  decryptProposalContent,
} from '../src/lib/content-crypto';

function jsonResponse(status: number, body: unknown) {
  return { res: { ok: status >= 200 && status < 300, status, json: async () => body } };
}

const DEPS = { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/suveren-test' };

describe('computeProposalContentHash', () => {
  it('is sha256: + hex of SHA-256 over hap-core JCS of the content', async () => {
    const { createHash } = await import('node:crypto');
    const toolArgs = { to: 'a@example.com', amount: 5 };
    const expected = `sha256:${createHash('sha256').update(canonicalize(toolArgs)).digest('hex')}`;
    expect(computeProposalContentHash(toolArgs)).toBe(expected);
  });

  it('is independent of key order (JCS sorts keys)', () => {
    expect(computeProposalContentHash({ b: 1, a: 2 })).toBe(computeProposalContentHash({ a: 2, b: 1 }));
  });
});

describe('encryptProposalContent / decryptProposalContent', () => {
  beforeEach(() => { fetchAsMock.mockReset(); });

  it('encrypts for self + recipients; each decrypts to the same toolArgs', async () => {
    const [kpSelf, kpOwner] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    fetchAsMock.mockImplementation((url: string) => {
      if (url.includes('/users/self/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpSelf.publicKey).toString('base64') }));
      if (url.includes('/users/owner/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpOwner.publicKey).toString('base64') }));
      return Promise.resolve(jsonResponse(404, {}));
    });

    const toolArgs = { to: 'customer@example.com', subject: 'Quote', amount: 120 };
    const { content, unreadableFor } = await encryptProposalContent(toolArgs, ['owner'], { ...DEPS, selfUserId: 'self' });

    expect(unreadableFor).toEqual([]);
    expect(content.v).toBe(1);
    expect(content.hash).toBe(computeProposalContentHash(toolArgs));
    expect(Object.keys(content.keys).sort()).toEqual(['owner', 'self']);

    const fromSelf = await decryptProposalContent(content, 'self', kpSelf.privateKey);
    const fromOwner = await decryptProposalContent(content, 'owner', kpOwner.privateKey);
    expect(JSON.parse(fromSelf)).toEqual(toolArgs);
    expect(JSON.parse(fromOwner)).toEqual(toolArgs);
    expect(fromSelf).toBe(canonicalize(toolArgs));
  });

  it('dedupes recipients that also appear as self', async () => {
    const kp = await generateKeyPair();
    fetchAsMock.mockResolvedValue(jsonResponse(200, { pubkey: Buffer.from(kp.publicKey).toString('base64') }));

    const { content } = await encryptProposalContent({ x: 1 }, ['self', 'self'], { ...DEPS, selfUserId: 'self' });
    expect(Object.keys(content.keys)).toEqual(['self']);
  });

  it('G4: a recipient with no registered key is skipped, not fatal', async () => {
    const kpSelf = await generateKeyPair();
    fetchAsMock.mockImplementation((url: string) => {
      if (url.includes('/users/self/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpSelf.publicKey).toString('base64') }));
      return Promise.resolve(jsonResponse(404, {}));
    });

    const { content, unreadableFor } = await encryptProposalContent({ x: 1 }, ['nokey'], { ...DEPS, selfUserId: 'self' });
    expect(unreadableFor).toEqual(['nokey']);
    expect(Object.keys(content.keys)).toEqual(['self']);
  });

  it('throws when nobody, including self, has a registered key', async () => {
    fetchAsMock.mockResolvedValue(jsonResponse(404, {}));
    await expect(
      encryptProposalContent({ x: 1 }, ['owner'], { ...DEPS, selfUserId: 'self' }),
    ).rejects.toThrow(/no.*registered end-to-end key/i);
  });

  it('decrypt throws when the caller has no key wrap in this content', async () => {
    const kp = await generateKeyPair();
    fetchAsMock.mockResolvedValue(jsonResponse(200, { pubkey: Buffer.from(kp.publicKey).toString('base64') }));
    const { content } = await encryptProposalContent({ x: 1 }, [], { ...DEPS, selfUserId: 'self' });
    await expect(decryptProposalContent(content, 'mallory', kp.privateKey)).rejects.toThrow(/no key wrap/i);
  });
});

describe('encryptProposalNote', () => {
  beforeEach(() => { fetchAsMock.mockReset(); });

  it('encrypts plain text (no JCS, no hash) and round-trips', async () => {
    const [kpSelf, kpOwner] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    fetchAsMock.mockImplementation((url: string) => {
      if (url.includes('/users/self/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpSelf.publicKey).toString('base64') }));
      if (url.includes('/users/owner/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpOwner.publicKey).toString('base64') }));
      return Promise.resolve(jsonResponse(404, {}));
    });

    const { noteEncrypted, unreadableFor } = await encryptProposalNote('Please use the smaller logo.', ['owner'], { ...DEPS, selfUserId: 'self' });
    expect(unreadableFor).toEqual([]);
    const decrypted = await decryptProposalContent(noteEncrypted, 'owner', kpOwner.privateKey);
    expect(decrypted).toBe('Please use the smaller logo.');
  });
});
