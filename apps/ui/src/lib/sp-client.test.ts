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

/**
 * RJ2/RJ5 — `resolveProposal`/`rejectProposal` grew `outcome`/`note` fields
 * (2026-10-11 "Reject or ask for a change" brief). Additive only: an old
 * caller passing just a domain string (resolveProposal) or a reason string
 * (rejectProposal) must keep working exactly as before — ActionCard.tsx,
 * ApproverProposalCard.tsx and AgentReviewPage.tsx are NOT touched by this
 * change and still call the old shape.
 */
describe('resolveProposal / rejectProposal — outcome/note are additive', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function okJson(body: Record<string, unknown> = { status: 'ok' }) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('resolveProposal with no 4th arg sends exactly { action, domain } — unchanged', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.resolveProposal('p1', 'reject', 'owner');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/proposals/p1/resolve');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ action: 'reject', domain: 'owner' });
  });

  it('resolveProposal(..., { outcome, note }) merges outcome/note into the body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.resolveProposal('p1', 'reject', 'owner', { outcome: 'change_needed', note: 'Lower the discount' });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: 'reject', domain: 'owner', outcome: 'change_needed', note: 'Lower the discount',
    });
  });

  it('rejectProposal(id, "a string reason") still sends the legacy { reason } body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ receipt: {}, status: 'rejected' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.rejectProposal('p1', 'cancelled by creator');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/proposals/p1/reject');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ reason: 'cancelled by creator' });
  });

  it('rejectProposal(id) with no reason sends the legacy { reason: undefined } body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ receipt: {}, status: 'rejected' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.rejectProposal('p1');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it('rejectProposal(id, { outcome: "replaced" }) — RJ5 edit-before-signing withdrawal, no reason/note', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ receipt: {}, status: 'rejected' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.rejectProposal('p1', { outcome: 'replaced' });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ outcome: 'replaced' });
  });

  it('rejectProposal(id, { outcome: "change_needed", note }) — RJ2 quick-choice path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ receipt: {}, status: 'rejected' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.rejectProposal('p1', { outcome: 'change_needed', note: 'Shorter' });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ outcome: 'change_needed', note: 'Shorter' });
  });
});

/**
 * Work-plan "Added 2026-10-11 — an account is Personal OR in one team":
 * join is now a REQUEST the team admin confirms/declines, with previews
 * before either side commits to anything — OnboardingPage.tsx is built
 * against exactly these contracts.
 */
describe('spClient — join/create a team (an account is Personal OR in one team)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function okJson(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('getJoinPreview reads the invite code as a query param and returns the preview as-is', async () => {
    const preview = {
      groupId: 'grp_team1', groupName: 'Alpenwerk Ersatzteile', admin: { name: 'Lena Gruber' },
      personalMandates: [{ id: 'authz_1', profileId: 'email@0.4', title: null, commitmentMode: 'automatic' }],
      pendingPersonalProposals: 1,
    };
    const fetchSpy = vi.fn().mockResolvedValue(okJson(preview));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.getJoinPreview('CODE123');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/groups/join/preview?inviteCode=CODE123');
    expect(result).toEqual(preview);
  });

  it('getJoinPreview throws with the AS message on an invalid/expired code (404)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okJson({ error: 'Invalid or expired invite code' }, 404)) as unknown as typeof fetch;
    await expect(spClient.getJoinPreview('bad')).rejects.toThrow(/Invalid or expired invite code/);
  });

  it('getCreatePreview hits the bare preview route', async () => {
    const preview = { personalMandates: [], pendingPersonalProposals: 0 };
    const fetchSpy = vi.fn().mockResolvedValue(okJson(preview));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.getCreatePreview();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/groups/create/preview');
    expect(result).toEqual(preview);
  });

  it('requestToJoinGroup POSTs the invite code and returns the pending request on 202', async () => {
    const request = { groupId: 'grp_team1', groupName: 'Alpenwerk Ersatzteile', status: 'pending', requestedAt: 1700000000 };
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ request }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.requestToJoinGroup('CODE123');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/groups/join');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ inviteCode: 'CODE123' });
    expect(result).toEqual(request);
  });

  it('requestToJoinGroup throws on 200 too — 202 is the ONLY success (the old instant-join contract is gone)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okJson({ group: { id: 'g1', name: 'x' } }, 200)) as unknown as typeof fetch;
    await expect(spClient.requestToJoinGroup('CODE123')).rejects.toThrow();
  });

  it('requestToJoinGroup surfaces a 409 REQUEST_PENDING refusal', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ error: 'You already have a pending request to join a team. Withdraw it before requesting another.', code: 'REQUEST_PENDING' }, 409),
    ) as unknown as typeof fetch;
    await expect(spClient.requestToJoinGroup('CODE123')).rejects.toThrow(/pending request/);
  });

  it('withdrawJoinRequest DELETEs and returns true on 200 { withdrawn: true }', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ withdrawn: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.withdrawJoinRequest();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/groups/join');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(result).toBe(true);
  });

  it('withdrawJoinRequest returns false (not a thrown error) on 404 — already resolved', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okJson({ error: 'No pending request to withdraw' }, 404)) as unknown as typeof fetch;
    await expect(spClient.withdrawJoinRequest()).resolves.toBe(false);
  });

  it('createGroup surfaces `ended` (decision 3 — the account moves, personal mandates end)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      okJson({ group: { id: 'grp_new', name: 'Acme Corp' }, ended: { mandates: 3, proposals: 1 } }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.createGroup('Acme Corp');
    expect(result.ended).toEqual({ mandates: 3, proposals: 1 });
  });

  it('createGroup defaults `ended` to zero counts for an older AS that omits it', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okJson({ group: { id: 'grp_new', name: 'Acme Corp' } })) as unknown as typeof fetch;
    const result = await spClient.createGroup('Acme Corp');
    expect(result.ended).toEqual({ mandates: 0, proposals: 0 });
  });

  it('getMyTeam reports pendingRequest alongside group/membership (independent, never assumed exclusive)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ group: null, membership: null, pendingRequest: { groupId: 'g1', groupName: 'Acme', requestedAt: 1 } }),
    ) as unknown as typeof fetch;
    const result = await spClient.getMyTeam();
    expect(result).toEqual({ group: null, membership: null, pendingRequest: { groupId: 'g1', groupName: 'Acme', requestedAt: 1 } });
  });

  it('getMyTeam defaults every field to null on a failed request rather than throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 })) as unknown as typeof fetch;
    const result = await spClient.getMyTeam();
    expect(result).toEqual({ group: null, membership: null, pendingRequest: null });
  });
});

/**
 * suveren-as#89 — GET /api/proposals?creator=me and POST
 * /api/proposals/:id/withdraw. Real response shapes (coordinator's spec,
 * matching the merged AS route code): the list mode answers
 * `{ proposals: Proposal[] }` like every other list mode here; an older AS
 * that doesn't support `creator=me` yet 400s (no `domain`/`status`/
 * `approver`/`creator` match) — the one signal ProposalReviewPage.tsx uses
 * to fall back to the gateway's own local submission record, never merging
 * both.
 */
describe('spClient.getProposalsCreatedByMe / withdrawProposal — real suveren-as#89 shapes', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function okJson(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('getProposalsCreatedByMe: GET /api/proposals?creator=me, returns the real proposals array', async () => {
    const proposal = {
      id: 'p1',
      authorizationId: 'authz_1',
      profileId: 'github.com/humanagencyprotocol/hap-profiles/email@0.8',
      tool: 'email__send',
      status: 'pending',
      createdAt: 1760000000,
      createdBy: 'tom-fecb81a6-9e2d-4a11-8f3c-2b9b1a7c4e10@test.local',
      pendingApprovers: ['lisa-7a3f2c91-1b4d-4e9a-9c0e-5f6a8d2b3c71@test.local'],
    };
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ proposals: [proposal] }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.getProposalsCreatedByMe();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/proposals?creator=me');
    expect(result).toEqual([proposal]);
  });

  it('getProposalsCreatedByMe: a 400 (an AS that predates creator=me) returns null, not []', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Missing query parameter: domain, status, or approver' }), { status: 400 }),
    ) as unknown as typeof fetch;
    const result = await spClient.getProposalsCreatedByMe();
    expect(result).toBeNull();
  });

  it('withdrawProposal: POST /api/proposals/:id/withdraw with no body fields when nothing is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({
      status: 'rejected',
      proposalId: 'p1',
      withdrawnBy: { userId: 'tom-fecb81a6-9e2d-4a11-8f3c-2b9b1a7c4e10@test.local', at: 1760000100 },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await spClient.withdrawProposal('p1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/proposals/p1/withdraw');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
    expect(result.status).toBe('rejected');
    expect(result.withdrawnBy.userId).toBe('tom-fecb81a6-9e2d-4a11-8f3c-2b9b1a7c4e10@test.local');
  });

  it('withdrawProposal: content_hash and shown_hash are added to the body only when given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({
      status: 'rejected', proposalId: 'p1', withdrawnBy: { userId: 'u1', at: 1760000100 },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.withdrawProposal('p1', undefined, 'sha256:abc', 'sha256:def');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      content_hash: 'sha256:abc',
      shown_hash: 'sha256:def',
    });
  });

  it('withdrawProposal: a plain note and a sealed note are mutually exclusive on the wire', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({
      status: 'rejected', proposalId: 'p1', withdrawnBy: { userId: 'u1', at: 1760000100, note: 'wrong recipient' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await spClient.withdrawProposal('p1', { note: 'wrong recipient' });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ note: 'wrong recipient' });

    const encFetchSpy = vi.fn().mockResolvedValue(okJson({
      status: 'rejected', proposalId: 'p1', withdrawnBy: { userId: 'u1', at: 1760000100 },
    }));
    globalThis.fetch = encFetchSpy as unknown as typeof fetch;
    const noteEncrypted = { ciphertext: 'ct', keys: { u1: { ct: 'k', enc: 'e' } } };
    await spClient.withdrawProposal('p1', { noteEncrypted });
    const [, encInit] = encFetchSpy.mock.calls[0];
    expect(JSON.parse((encInit as RequestInit).body as string)).toEqual({ note_encrypted: noteEncrypted });
  });

  it('withdrawProposal: a 403 (not the creator) surfaces the AS message, not a bare "withdrawProposal failed: 403" ' +
    '— the real route uses forbiddenResponse, the legacy { error } shape, not the errors[] envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Only the proposal's own creator may withdraw it" }),
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    await expect(spClient.withdrawProposal('p1')).rejects.toThrow(/Only the proposal's own creator may withdraw it/);
  });
});
