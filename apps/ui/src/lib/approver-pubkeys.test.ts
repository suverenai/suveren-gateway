import { describe, it, expect } from 'vitest';
import { parseApproverPubkeys } from './sp-client';

/**
 * The AS answers `{ pubkeys: { <userId>: <key> } }`. The sign page read
 * `data.approvers` — never sent — so it always got [] and never encrypted a
 * team mandate's intent for the approvers.
 */
describe('parseApproverPubkeys', () => {
  it('reads the shape the Authority Server actually sends', () => {
    expect(parseApproverPubkeys({ pubkeys: { u_anna: 'a2V5QQ==', u_bernd: 'a2V5Qg==' } })).toEqual([
      { userId: 'u_anna', publicKey: 'a2V5QQ==' },
      { userId: 'u_bernd', publicKey: 'a2V5Qg==' },
    ]);
  });

  it('no approvers / unexpected shapes → empty, never throws', () => {
    expect(parseApproverPubkeys({ pubkeys: {} })).toEqual([]);
    expect(parseApproverPubkeys({ approvers: [{ userId: 'x', publicKey: 'y' }] })).toEqual([]);
    expect(parseApproverPubkeys(null)).toEqual([]);
    expect(parseApproverPubkeys({ pubkeys: { u: 42 } })).toEqual([]);
  });
});
