/**
 * buildGateForwardArgs — pins the per-ceremony identity contract.
 *
 * History: the extend flow once forwarded gate content with only `boundsHash`,
 * and the old fallback chain (frame_hash → bounds_hash → local boundsHash)
 * papered over it — which is exactly the fingerprint-as-identity bug that let
 * same-bounds twins cross-contaminate. The payload now REQUIRES the attest
 * result's `authorization_id` and there is no fallback: a result without one
 * means the Authority Server predates per-ceremony identity, and we fail
 * loudly (lockstep guard) instead of storing under a wrong key.
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
  it('keys the forward payload by the per-ceremony authorization_id', () => {
    const args = buildGateForwardArgs(
      { authorization_id: 'authz_11111111-2222-3333-4444-555555555555', bounds_hash: 'sha256:bounds' },
      FIELDS,
    );
    expect(args.authorizationId).toBe('authz_11111111-2222-3333-4444-555555555555');
    expect(args.boundsHash).toBe('sha256:bounds');
  });

  it('falls back to the locally computed boundsHash when the result omits bounds_hash', () => {
    const args = buildGateForwardArgs({ authorization_id: 'authz_a' }, FIELDS);
    expect(args.boundsHash).toBe('sha256:bounds');
  });

  it('THROWS when authorization_id is missing (lockstep guard — no fingerprint fallback)', () => {
    expect(() => buildGateForwardArgs({ bounds_hash: 'sha256:b' }, FIELDS))
      .toThrow(/authorization_id/);
    expect(() => buildGateForwardArgs({}, FIELDS))
      .toThrow(/lockstep/);
  });

  it('omits path when absent, includes it when given', () => {
    const noPath = buildGateForwardArgs({ authorization_id: 'authz_a' }, FIELDS);
    expect('path' in noPath).toBe(false);
    const withPath = buildGateForwardArgs({ authorization_id: 'authz_a' }, { ...FIELDS, path: 'charge' });
    expect(withPath.path).toBe('charge');
  });

  it('passes context and gateContent through unchanged', () => {
    const args = buildGateForwardArgs({ authorization_id: 'authz_a' }, FIELDS);
    expect(args.context).toEqual({ currency: 'USD' });
    expect(args.gateContent).toEqual({ intent: 'Manage records on my behalf.' });
    expect(args.contextHash).toBe('sha256:ctx');
  });
});
