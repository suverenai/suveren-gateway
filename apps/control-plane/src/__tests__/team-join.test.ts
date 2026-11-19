/**
 * The join (DEC-73 step 4): the rules the screens rely on, with the Authority Server and the chain stood in by small fakes and
 * REAL hap-core for the identity codes. What is NOT covered here (needs real servers, a real chain and a touch): the anchor and
 * the list actually being signed and verified by the Authority Server; that is `e2e/team-join-codes.spec.ts` in suveren-e2e.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { CodeGate, JoinRefusal, MAX_TRIES, MATCH_TTL_MS, TeamJoin } from '../lib/team-join';
import { createTeamJoinRouter } from '../routes/team-join';
import { deviceKeys } from '../lib/device-keys-lazy';
import type { MandateGrants } from '../lib/mandate-grants';
import type { Vault } from '../lib/vault';
import type { DeviceChainStore } from '../lib/device-chain-store';

describe('CodeGate: three tries, one match per person, a match runs out', () => {
  it('a right code matches, spaces and groups do not matter', () => {
    const g = new CodeGate(() => 0);
    expect(g.attempt('k', '4721 8830 1169 2284 0937 1250', '472188301169228409371250')).toEqual({ match: true });
    expect(g.matched('k')).toBe(true);
  });
  it('wrong codes count down and the third wrong one closes the side', () => {
    const g = new CodeGate(() => 0);
    expect(g.attempt('k', '1111', '2222')).toEqual({ match: false, triesLeft: 2 });
    expect(g.attempt('k', '1111', '2222')).toEqual({ match: false, triesLeft: 1 });
    expect(g.attempt('k', '1111', '2222')).toEqual({ match: false, triesLeft: 0 });
    expect(MAX_TRIES).toBe(3);
    // closed: even the right code is refused now
    expect(() => g.attempt('k', '1111', '1111')).toThrowError(JoinRefusal);
    expect(g.matched('k')).toBe(false);
  });
  it('an empty or letters-only entry never matches', () => {
    const g = new CodeGate(() => 0);
    expect(g.attempt('k', '1111', '')).toMatchObject({ match: false });
    expect(g.attempt('k', '', '')).toMatchObject({ match: false });
  });
  it('a match is for that key only (another team or another DID is not matched)', () => {
    const g = new CodeGate(() => 0);
    g.attempt('team1:did1', '1111', '1111');
    expect(g.matched('team1:did2')).toBe(false);
    expect(g.matched('team2:did1')).toBe(false);
  });
  it('a match runs out after 30 minutes', () => {
    let t = 0;
    const g = new CodeGate(() => t);
    g.attempt('k', '1111', '1111');
    t = MATCH_TTL_MS - 1; expect(g.matched('k')).toBe(true);
    t = MATCH_TTL_MS; expect(g.matched('k')).toBe(false);
  });
  it('a right code gives the three tries back; forget starts over', () => {
    const g = new CodeGate(() => 0);
    g.attempt('k', '1111', '9'); g.attempt('k', '1111', '9');
    g.attempt('k', '1111', '1111');
    expect(g.triesLeft('k')).toBe(3);
    g.forget('k');
    expect(g.matched('k')).toBe(false);
  });
});

const ADMIN = 'did:key:z6MkAdminAdminAdminAdminAdminAdminAdmin1111';
const MEMBER = 'did:key:z6MkMemberMemberMemberMemberMemberMember22222';

/** A gateway whose only knowledge is what the Authority Server says (the fake) and its own DID. */
function rig(own: string, as: (method: string, path: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const grants = {
    approvalSession: async () => ({ credential: 'Bearer x', stored: { rootDid: own, keyId: 'k1' }, own: { devices: {}, head: { seq: 0, hash: 'h' } } }),
    asCall: async (_s: unknown, method: string, path: string) => { calls.push(`${method} ${path}`); return as(method, path); },
    verifiedChainOf: async () => { throw new Error('not reached in these tests'); },
  } as unknown as MandateGrants;
  const join = new TeamJoin({ vault: {} as Vault, store: { exists: () => true } as unknown as DeviceChainStore, grants, trust: { head: async () => null } });
  return { join, calls };
}

describe('member: nothing is signed before the admin\'s code matched', () => {
  const as = (method: string, path: string) => {
    if (path.endsWith('/trust')) return { status: 200, body: { team_id: 't1', admin_did: ADMIN, head: null } };
    if (path.endsWith('/anchor') && method === 'GET') return { status: 200, body: { anchor: null } };
    return { status: 500, body: {} };
  };
  it('shows only its own code, computed from its own DID, and never the admin\'s', async () => {
    const dk = await deviceKeys();
    const { join } = rig(MEMBER, as);
    const v = await join.memberView('t1');
    expect(v.yourCode).toBe(await dk.identityCode(MEMBER));
    expect(JSON.stringify(v)).not.toContain(await dk.identityCode(ADMIN));
    expect(v).toMatchObject({ triesLeft: 3, compared: false, anchored: false });
  });
  it('the anchor is refused (409 not_compared) before any code matched, and the Authority Server is not asked to store one', async () => {
    const { join, calls } = rig(MEMBER, as);
    await expect(join.memberAnchor('t1')).rejects.toMatchObject({ code: 'not_compared', status: 409 });
    expect(calls.some(c => c.startsWith('POST'))).toBe(false);
  });
  it('a wrong admin code counts down; three close the side; the right one afterwards is still refused', async () => {
    const dk = await deviceKeys();
    const { join } = rig(MEMBER, as);
    expect(await join.memberCheck('t1', '0000 0000 0000 0000 0000 0000')).toEqual({ match: false, triesLeft: 2 });
    expect(await join.memberCheck('t1', '1')).toEqual({ match: false, triesLeft: 1 });
    expect(await join.memberCheck('t1', '2')).toEqual({ match: false, triesLeft: 0 });
    await expect(join.memberCheck('t1', await dk.identityCode(ADMIN))).rejects.toMatchObject({ code: 'tries_used' });
    await expect(join.memberAnchor('t1')).rejects.toMatchObject({ code: 'not_compared' });
  });
  it('the code of the admin matches, and the view then says so', async () => {
    const dk = await deviceKeys();
    const { join } = rig(MEMBER, as);
    expect(await join.memberCheck('t1', await dk.identityCode(ADMIN))).toEqual({ match: true });
    expect((await join.memberView('t1')).compared).toBe(true);
  });
  it('a different admin DID from the Authority Server is a different join: the earlier match does not carry over', async () => {
    const dk = await deviceKeys();
    let admin = ADMIN;
    const { join } = rig(MEMBER, (m, p) => p.endsWith('/trust') ? { status: 200, body: { team_id: 't1', admin_did: admin, head: null } } : as(m, p));
    await join.memberCheck('t1', await dk.identityCode(ADMIN));
    admin = 'did:key:z6MkSomebodyElseSomebodyElseSomebodyElse9999';
    await expect(join.memberAnchor('t1')).rejects.toMatchObject({ code: 'not_compared' });
  });
  it('bad input is a 400 before anything is asked', async () => {
    const { join, calls } = rig(MEMBER, as);
    await expect(join.memberView('../x')).rejects.toMatchObject({ status: 400 });
    await expect(join.memberCheck('t1', 42)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});

describe('admin: no add before the member\'s code matched AND the member\'s anchor is there', () => {
  let anchor: unknown = null;
  const as = (method: string, path: string) => {
    if (path === '/api/groups/t1/requests') return { status: 200, body: { requests: [{ userId: 'u1', name: 'Maria (account)', memberDid: MEMBER, memberName: 'Maria Huber' }, { userId: 'u2', name: 'Old', memberDid: null, memberName: null }] } };
    if (path === '/api/teams/t1/anchors/u1') return { status: 200, body: { user_id: 'u1', member_did: MEMBER, anchor } };
    return { status: 500, body: {} };
  };
  it('the view has the admin\'s own code and each request, a request without identity marked', async () => {
    const dk = await deviceKeys();
    const { join } = rig(ADMIN, as);
    const v = await join.adminView('t1');
    expect(v.yourCode).toBe(await dk.identityCode(ADMIN));
    expect(v.requests).toEqual([
      { userId: 'u1', memberName: 'Maria Huber', hasDid: true, triesLeft: 3, compared: false, anchor: 'none' },
      { userId: 'u2', memberName: 'Old', hasDid: false, triesLeft: 0, compared: false, anchor: 'none' },
    ]);
    expect(JSON.stringify(v)).not.toContain(await dk.identityCode(MEMBER));
  });
  it('add is refused before the code matched (not_compared) and no list is posted', async () => {
    const { join, calls } = rig(ADMIN, as);
    await expect(join.adminAdd('t1', 'u1')).rejects.toMatchObject({ code: 'not_compared', status: 409 });
    expect(calls.some(c => c.startsWith('POST'))).toBe(false);
  });
  it('after the right code but without the member\'s anchor: anchor_required', async () => {
    const dk = await deviceKeys();
    const { join, calls } = rig(ADMIN, as);
    expect(await join.adminCheck('t1', 'u1', await dk.identityCode(MEMBER))).toEqual({ match: true });
    await expect(join.adminAdd('t1', 'u1')).rejects.toMatchObject({ code: 'anchor_required', status: 409 });
    expect(calls.some(c => c.startsWith('POST'))).toBe(false);
  });
  it('a person without a device chain cannot be compared', async () => {
    const { join } = rig(ADMIN, as);
    await expect(join.adminCheck('t1', 'u2', '1111')).rejects.toMatchObject({ code: 'member_has_no_chain' });
  });
  it('three wrong codes close this request on the admin\'s side only', async () => {
    const { join } = rig(ADMIN, as);
    for (let i = 0; i < 3; i++) await join.adminCheck('t1', 'u1', '1');
    await expect(join.adminCheck('t1', 'u1', '1')).rejects.toMatchObject({ code: 'tries_used', status: 423 });
    expect((await join.adminView('t1')).requests[0].triesLeft).toBe(0);
  });
  it('a request the Authority Server no longer lists is unknown', async () => {
    const { join } = rig(ADMIN, as);
    await expect(join.adminCheck('t1', 'nobody', '1')).rejects.toMatchObject({ code: 'no_join_request', status: 404 });
  });
});

describe('the routes', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { while (servers.length) servers.pop()!.close(); });
  function serve(join: Pick<TeamJoin, 'active' | 'memberView' | 'memberCheck'>) {
    const app = express();
    app.use('/api/team-join', express.json(), createTeamJoinRouter(join as unknown as TeamJoin));
    const srv = app.listen(0); servers.push(srv);
    return `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/team-join`;
  }
  it('answers not_set_up (409) on a gateway without a chain, whatever the path', async () => {
    const base = serve({ active: () => false, memberView: async () => { throw new Error('no'); }, memberCheck: async () => { throw new Error('no'); } });
    const r = await fetch(`${base}/member/t1`);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, code: 'not_set_up' });
  });
  it('a refusal keeps its status and neutral code; a wrong code is a 200 answer, never a failure', async () => {
    const base = serve({
      active: () => true,
      memberView: async () => { throw new JoinRefusal('as_unreachable', 502); },
      memberCheck: async () => ({ match: false, triesLeft: 2 }),
    });
    const a = await fetch(`${base}/member/t1`);
    expect(a.status).toBe(502); expect(await a.json()).toEqual({ ok: false, error: 'as_unreachable', code: 'as_unreachable' });
    const b = await fetch(`${base}/member/t1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '1' }) });
    expect(b.status).toBe(200); expect(await b.json()).toEqual({ ok: true, match: false, triesLeft: 2 });
    expect(a.headers.get('cache-control')).toBe('no-store');
  });
  it('an unexpected error answers 500 with no detail', async () => {
    const base = serve({ active: () => true, memberView: async () => { throw new Error('secret detail'); }, memberCheck: async () => { throw new Error('x'); } });
    const r = await fetch(`${base}/member/t1`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('secret');
  });
});
