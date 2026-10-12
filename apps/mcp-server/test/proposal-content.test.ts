/**
 * proposal-content.ts — PE1: resolving an encrypted proposal's toolArgs (or
 * a change-needed note) back to plaintext. Decryption itself is mocked here
 * (it round-trips through the control plane — cp-content-client.ts); this
 * file covers the "decrypt, verify the fingerprint, parse" logic every
 * reader (the committed executor, check-pending-commitments, the outcome
 * outbox) goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalize } from '@hap/core';

const cpDecryptContentMock = vi.fn();
vi.mock('../src/lib/cp-content-client', () => ({
  cpDecryptContent: (...args: unknown[]) => cpDecryptContentMock(...args),
}));

import { resolveProposalToolArgs, decryptRejectionNote, computeProposalContentHash, ProposalContentError } from '../src/lib/proposal-content';
import type { SPProposal } from '../src/lib/sp-client';

const BASE: SPProposal = {
  id: 'prop-1',
  authorizationId: 'authz_1',
  profileId: 'email@0.5',
  path: 'email@0.5',
  pendingDomains: [],
  committedBy: {},
  rejectedBy: null,
  tool: 'gmail__send_message',
  executionContext: {},
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

describe('computeProposalContentHash', () => {
  it('matches hap-core JCS + SHA-256, prefixed sha256:', async () => {
    const { createHash } = await import('node:crypto');
    const toolArgs = { to: 'a@example.com', amount: 5 };
    const expected = `sha256:${createHash('sha256').update(canonicalize(toolArgs)).digest('hex')}`;
    expect(computeProposalContentHash(toolArgs)).toBe(expected);
  });
});

describe('resolveProposalToolArgs', () => {
  beforeEach(() => { cpDecryptContentMock.mockReset(); });

  it('a legacy row returns toolArgs as is — never decrypts', async () => {
    const proposal: SPProposal = { ...BASE, toolArgs: { to: 'x@example.com' } };
    const result = await resolveProposalToolArgs(proposal);
    expect(result).toEqual({ to: 'x@example.com' });
    expect(cpDecryptContentMock).not.toHaveBeenCalled();
  });

  it('an encrypted row decrypts, parses, and verifies the fingerprint', async () => {
    const toolArgs = { to: 'customer@example.com', amount: 42 };
    const hash = computeProposalContentHash(toolArgs);
    cpDecryptContentMock.mockResolvedValue(canonicalize(toolArgs));
    const proposal: SPProposal = {
      ...BASE,
      content: { v: 1, alg: 'HPKE-X25519-HKDF-SHA256-AES256GCM', ciphertext: 'ct', keys: {}, hash },
      contentHash: hash,
    };
    const result = await resolveProposalToolArgs(proposal);
    expect(result).toEqual(toolArgs);
    expect(cpDecryptContentMock).toHaveBeenCalledWith(proposal.content);
  });

  it('refuses when the decrypted content does not match its own fingerprint', async () => {
    cpDecryptContentMock.mockResolvedValue(canonicalize({ to: 'tampered@example.com' }));
    const proposal: SPProposal = {
      ...BASE,
      content: { v: 1, alg: 'HPKE-X25519-HKDF-SHA256-AES256GCM', ciphertext: 'ct', keys: {}, hash: computeProposalContentHash({ to: 'original@example.com' }) },
    };
    await expect(resolveProposalToolArgs(proposal)).rejects.toThrow(ProposalContentError);
    await expect(resolveProposalToolArgs(proposal)).rejects.toThrow(/does not match its own fingerprint/);
  });

  it('refuses (never crashes the caller unexpectedly) when decryption itself fails', async () => {
    cpDecryptContentMock.mockRejectedValue(new Error('control plane unreachable'));
    const proposal: SPProposal = { ...BASE, content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' } };
    await expect(resolveProposalToolArgs(proposal)).rejects.toThrow(ProposalContentError);
  });

  it('refuses when decrypted content is not valid JSON', async () => {
    cpDecryptContentMock.mockResolvedValue('not json');
    const proposal: SPProposal = { ...BASE, content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' } };
    await expect(resolveProposalToolArgs(proposal)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses when a proposal carries neither toolArgs nor content', async () => {
    await expect(resolveProposalToolArgs({ ...BASE })).rejects.toThrow(/carries neither/);
  });
});

describe('decryptRejectionNote', () => {
  beforeEach(() => { cpDecryptContentMock.mockReset(); });

  it('passes a legacy plaintext note through unchanged', async () => {
    const note = await decryptRejectionNote({ note: 'please redo the amount' });
    expect(note).toBe('please redo the amount');
    expect(cpDecryptContentMock).not.toHaveBeenCalled();
  });

  it('decrypts a sealed note', async () => {
    cpDecryptContentMock.mockResolvedValue('use the smaller logo');
    const noteEncrypted = { ciphertext: 'ct', keys: {} };
    const note = await decryptRejectionNote({ noteEncrypted });
    expect(note).toBe('use the smaller logo');
    expect(cpDecryptContentMock).toHaveBeenCalledWith(noteEncrypted);
  });

  it('degrades to a visible marker, never throws, when decryption fails', async () => {
    cpDecryptContentMock.mockRejectedValue(new Error('no key wrap'));
    const note = await decryptRejectionNote({ noteEncrypted: { ciphertext: 'ct', keys: {} } });
    expect(note).toMatch(/could not decrypt/i);
  });

  it('returns undefined for no decision at all', async () => {
    expect(await decryptRejectionNote(null)).toBeUndefined();
    expect(await decryptRejectionNote(undefined)).toBeUndefined();
    expect(await decryptRejectionNote({})).toBeUndefined();
  });
});
