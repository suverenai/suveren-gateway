/**
 * use-proposal-content.ts — PE1: the pure/async parts (no React) that don't
 * need a component to exercise. `useProposalContent`/`useDecryptedNote`
 * (the hooks) wrap these with `useState`/`useEffect` and are exercised via
 * the cards that call them (ApprovalBody, ActionCard) — this repo has no
 * React Testing Library, so hooks themselves are not unit-tested here, same
 * as every other hook in this codebase.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { decryptProposalArgs, missingRecipients, contentHashForDecision, decisionButtonsVisible, noteRecipients } from './use-proposal-content';
import { computeContentHashBrowser } from './content-hash';
import type { Proposal } from './sp-client';

describe('missingRecipients (G4)', () => {
  it('empty for a legacy row (no content at all)', () => {
    expect(missingRecipients({ content: undefined, createdBy: 'owner', pendingApprovers: ['bob'] })).toEqual([]);
  });

  it('empty when every named recipient has a key wrap', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { owner: { ct: 'a', enc: 'b' }, bob: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' },
      createdBy: 'owner',
      pendingApprovers: ['bob'],
    };
    expect(missingRecipients(proposal)).toEqual([]);
  });

  it('names the owner and/or approvers missing a key wrap', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { bob: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' },
      createdBy: 'owner',
      pendingApprovers: ['bob', 'carol'],
    };
    expect(missingRecipients(proposal)).toEqual(['owner', 'carol']);
  });

  it('dedupes when createdBy also appears in pendingApprovers', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' },
      createdBy: 'owner',
      pendingApprovers: ['owner'],
    };
    expect(missingRecipients(proposal)).toEqual(['owner']);
  });
});

describe('decryptProposalArgs', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a legacy row returns toolArgs as is — never touches the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await decryptProposalArgs({ toolArgs: { to: 'x@example.com' }, content: undefined });
    expect(result).toEqual({ to: 'x@example.com' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null (never throws) for a proposal with neither field', async () => {
    const result = await decryptProposalArgs({ toolArgs: undefined, content: undefined });
    expect(result).toBeNull();
  });

  it('an encrypted row decrypts via the CP route and parses the JSON', async () => {
    const toolArgs = { to: 'customer@example.com', amount: 42 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/api/decrypt-proposal-content');
      return new Response(JSON.stringify({ plaintext: JSON.stringify(toolArgs) }), { status: 200 });
    }));
    const result = await decryptProposalArgs({
      toolArgs: undefined,
      content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' },
    });
    expect(result).toEqual(toolArgs);
  });

  it('returns null (never throws) when this device cannot decrypt it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No key wrap' }), { status: 403 })));
    const result = await decryptProposalArgs({
      toolArgs: undefined,
      content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' },
    });
    expect(result).toBeNull();
  });
});

describe('decisionButtonsVisible (decision 10 — no Approve on an unreadable card)', () => {
  it('visible once settled and readable', () => {
    expect(decisionButtonsVisible({ loading: false, readable: true })).toBe(true);
  });

  it('hidden while still loading, even though nothing has failed yet (no false negative, but no false positive either)', () => {
    expect(decisionButtonsVisible({ loading: true, readable: true })).toBe(false);
    expect(decisionButtonsVisible({ loading: true, readable: false })).toBe(false);
  });

  it('hidden once settled and unreadable — "no Approve button: nothing can be approved that this device cannot show you"', () => {
    expect(decisionButtonsVisible({ loading: false, readable: false })).toBe(false);
  });
});

describe('noteRecipients (G5 — exactly who can already read the proposal, plus self)', () => {
  it('an encrypted row: exactly the userIds in content.keys, plus the deciding gateway\'s own user', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { submitter: { ct: 'a', enc: 'b' }, owner: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' },
      createdBy: undefined,
      pendingApprovers: undefined,
    };
    expect(new Set(noteRecipients(proposal, 'decider'))).toEqual(new Set(['submitter', 'owner', 'decider']));
  });

  it('a "personal" proposal — exactly one recipient in content.keys, who is also the decider: no duplicate, no extra', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { alice: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' },
      createdBy: undefined,
      pendingApprovers: undefined,
    };
    expect(noteRecipients(proposal, 'alice')).toEqual(['alice']);
  });

  it('never falls back to pendingDomains — only content.keys or (legacy) createdBy/pendingApprovers', () => {
    const proposal = {
      content: { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { submitter: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' },
      createdBy: undefined,
      pendingApprovers: undefined,
    };
    // Even if a caller mistakenly had a domain name lying around, this
    // function's signature doesn't accept pendingDomains at all — content.keys wins.
    expect(noteRecipients(proposal, 'decider')).toEqual(expect.arrayContaining(['submitter', 'decider']));
    expect(noteRecipients(proposal, 'decider')).not.toContain('finance-domain-owner');
  });

  it('a legacy row (no content) falls back to createdBy + pendingApprovers + self, deduped', () => {
    const proposal = { content: undefined, createdBy: 'owner', pendingApprovers: ['bob', 'owner'] };
    expect(new Set(noteRecipients(proposal, 'bob'))).toEqual(new Set(['owner', 'bob']));
  });

  it('a legacy row with neither createdBy nor pendingApprovers still includes self', () => {
    const proposal = { content: undefined, createdBy: undefined, pendingApprovers: undefined };
    expect(noteRecipients(proposal, 'decider')).toEqual(['decider']);
  });
});

describe('contentHashForDecision', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches computeContentHashBrowser over the decrypted toolArgs', async () => {
    const toolArgs = { to: 'a@example.com', amount: 5 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plaintext: JSON.stringify(toolArgs) }), { status: 200 })));
    const proposal: Pick<Proposal, 'toolArgs' | 'content'> = {
      toolArgs: undefined,
      content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' },
    };
    const hash = await contentHashForDecision(proposal);
    expect(hash).toBe(await computeContentHashBrowser('jcs', toolArgs));
  });

  it('is undefined (never a guess) when this device cannot decrypt it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No key wrap' }), { status: 403 })));
    const hash = await contentHashForDecision({ toolArgs: undefined, content: { v: 1, alg: 'x', ciphertext: 'ct', keys: {}, hash: 'sha256:x' } });
    expect(hash).toBeUndefined();
  });
});
