/**
 * The gateway page's wiring of the shared approval card: the card's reads and its decrypt call
 * must reach the control plane through spClient, on the same routes as before the card moved
 * into packages/approval-card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import './approval-host';
import { approvalHost } from '@suveren/approval-card/host';
import { decryptProposalArgs } from '@suveren/approval-card/lib/use-proposal-content';

afterEach(() => { vi.unstubAllGlobals(); });

describe('approval host (gateway page)', () => {
  it('opens a sealed proposal through the control plane decrypt route', async () => {
    const toolArgs = { to: 'a@example.com', amount: 5 };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ plaintext: JSON.stringify(toolArgs) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const wire = { v: 1 as const, alg: 'x', ciphertext: 'ct', keys: { me: { ct: 'a', enc: 'b' } }, hash: 'sha256:x' };
    const out = await decryptProposalArgs({ toolArgs: undefined, content: wire });
    expect(out).toEqual(toolArgs);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/decrypt-proposal-content');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(wire);
  });

  it('reads a proposal and its preview from the same routes', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await approvalHost().data.getProposal('p1');
    await approvalHost().data.getProposalPreview('p1');
    const urls = fetchSpy.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls[0]).toContain('/api/proposals/p1');
    expect(urls[1]).toContain('/proposal-status/p1/preview');
  });
});
