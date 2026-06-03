/**
 * Regression test for the extend-authorization bug: the extend flow forwarded
 * gate content with only `boundsHash` and no `frameHash`, so the MCP server's
 * AS lookup (keyed by the per-user storage key) 404'd — "Failed to forward
 * gate content to MCP server" — and the extend popup stuck open.
 *
 * The forward payload MUST always carry `frameHash`. Both the create and extend
 * flows route through buildGateForwardArgs so they can't diverge again.
 */
import { describe, it, expect } from 'vitest';
import { buildGateForwardArgs } from './gate-forward';

const FIELDS = {
  boundsHash: 'sha256:bounds',
  contextHash: 'sha256:ctx',
  context: { currency: 'USD' },
  gateContent: { intent: 'Manage records on my behalf.' },
};

describe('buildGateForwardArgs', () => {
  it('ALWAYS includes frameHash (the per-user storage key the MCP server resolves by)', () => {
    const args = buildGateForwardArgs(
      { frame_hash: 'sha256:bounds:alice', bounds_hash: 'sha256:bounds' },
      FIELDS,
    );
    // The bug: this was missing in the extend flow.
    expect(args.frameHash).toBe('sha256:bounds:alice');
    expect(args.boundsHash).toBe('sha256:bounds');
  });

  it('falls back frame_hash → bounds_hash → local boundsHash', () => {
    expect(buildGateForwardArgs({ bounds_hash: 'sha256:b' }, FIELDS).frameHash).toBe('sha256:b');
    expect(buildGateForwardArgs({}, FIELDS).frameHash).toBe('sha256:bounds');
  });

  it('omits path when absent, includes it when given', () => {
    const noPath = buildGateForwardArgs({ frame_hash: 'f' }, FIELDS);
    expect('path' in noPath).toBe(false);
    const withPath = buildGateForwardArgs({ frame_hash: 'f' }, { ...FIELDS, path: 'charge' });
    expect(withPath.path).toBe('charge');
  });

  it('passes context and gateContent through unchanged', () => {
    const args = buildGateForwardArgs({ frame_hash: 'f' }, FIELDS);
    expect(args.context).toEqual({ currency: 'USD' });
    expect(args.gateContent).toEqual({ intent: 'Manage records on my behalf.' });
    expect(args.contextHash).toBe('sha256:ctx');
  });
});
