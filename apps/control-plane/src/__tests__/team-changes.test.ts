/**
 * Changes of a team's list after the join (DEC-73 step 5): the rules the screens rely on, with the Authority Server, the verified
 * head and the touch stood in by small fakes and REAL hap-core for the lists and the identity codes. NOT covered here (needs real
 * servers, real chains and a touch): the lists actually being verified by the Authority Server and by the members' gateways, the
 * native prompt text; that is `test/team-admin-change.test.ts` and the Playwright spec in suveren-e2e. NOT RUN when written
 * (the machine was held by a full e2e run).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TeamListChanges } from '../lib/team-changes';
import { CodeGate, type TeamJoin } from '../lib/team-join';
import { deviceKeys } from '../lib/device-keys-lazy';
import type { MemberList } from '@hap/core/device-keys';

const TEAM = 't1';

async function did(): Promise<string> { return (await (await deviceKeys()).deriveRootKey(randomBytes(16))).did; }

interface Rig { c: TeamListChanges; posts: Array<{ method: string; path: string; body: any }>; touches: number; head: { list: MemberList; hash: string }; people: Who }

/** `own` is this gateway's person; `members` the verified list (own first: the admin when `admin` is true). */
type Who = Record<'own' | 'maria' | 'jonas' | 'other' | 'newMaria', string>;
async function rig(o: { admin: boolean; offers?: (w: Who) => Record<string, unknown>; signerActive?: boolean; pin?: (head: { list: MemberList; hash: string }) => { version: number; hash: string } | null; asLists?: (head: { list: MemberList; hash: string }) => MemberList[]; handover?: (head: { list: MemberList; hash: string }, w: Who) => unknown; anchor?: 'none' | 'ok' | 'invalid'; withHead?: boolean }): Promise<Rig> {
  const dk = await deviceKeys();
  const own = await did(); const maria = await did(); const jonas = await did(); const other = await did(); const newMaria = await did();
  const adminDid = o.admin ? own : other;
  const members = await Promise.all([own, maria, jonas, other].filter((d, i, a) => a.indexOf(d) === i).map(d => dk.buildTeamMember(d, d === own ? 'Me' : d === maria ? 'Maria' : d === jonas ? 'Jonas' : 'Other')));
  members.sort((a, b) => (a.did < b.did ? -1 : 1));
  const list = dk.buildMemberList({ team_id: TEAM, version: 3, prev: 'sha256:' + 'a'.repeat(64), admin_did: adminDid, members, handover: null, key_id: 'k-signer', chain_seq: 1, chain_head: 'sha256:' + 'b'.repeat(64), created_at: 1794000000, nonce: 'n' });
  const head = { list, hash: await dk.memberListHash(list) };
  const posts: Rig['posts'] = [];
  const people: Who = { own, maria, jonas, other, newMaria };
  const out = { posts, touches: 0, head, people } as Rig;
  const gate = new CodeGate(() => 0);
  const asCall = async (method: string, path: string, body?: unknown) => {
    posts.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/offers')) return { status: 200, body: { admin_did: adminDid, admin_gone: false, ...(o.offers ? o.offers(people) : {}) } };
    if (method === 'GET' && path.endsWith('/handover')) return { status: 200, body: { handover: o.handover ? o.handover(head, people) : null } };
    if (method === 'GET' && path.endsWith('/anchor')) return { status: 200, body: { anchor: { anchor: { admin_did: adminDid } } } };
    if (method === 'GET' && path.includes('/trust')) return { status: 200, body: { lists: (o.asLists ? o.asLists(head) : []).map(l => ({ list: l, sigs: [] })) } };
    return { status: 201, body: {} };
  };
  const join = {
    active: () => true,
    teamId: (v: unknown) => v as string,
    userId: (v: unknown) => v as string,
    session: async () => ({ credential: 'x', stored: { rootDid: own, keyId: 'k-me' }, own: { devices: { 'k-signer': { removed_seq: o.signerActive === false ? 2 : null }, 'k-me': { removed_seq: null } }, head: { seq: 5, hash: 'sha256:' + 'c'.repeat(64) } } }),
    call: async (_s: unknown, m: string, p: string, b?: unknown) => asCall(m, p, b),
    signWithCheck: async () => { out.touches++; return { sig: 'sig', check: { signature: 'chk' } }; },
    anchorState: async () => o.anchor ?? 'none',
    adminGate: gate,
    d: { trust: { head: async () => (o.withHead === false ? (() => { throw Object.assign(new Error('x'), { name: 'TeamTrustUnavailable' }); })() : head) }, grants: { verifiedChainOf: async () => ({}) } },
  } as unknown as TeamJoin;
  out.c = new TeamListChanges({ join, store: { pin: () => (o.pin ? o.pin(head) : null) } as never, now: () => 1794000100 });
  return out;
}

describe('what is on offer: only what the verified list names', () => {
  it('the admin sees remove offers for listed members only, never for itself or a stranger, with the name from the signed list', async () => {
    let stranger = '';
    const r = await rig({ admin: true, offers: w => ({ remove: [{ did: w.maria, name: 'Hacker', reason: 'left' }, { did: w.own, reason: 'left' }, { did: stranger = w.newMaria, reason: 'removed' }] }) });
    const s = await r.c.status(TEAM);
    expect(s.role).toBe('admin');
    if (s.role !== 'admin') return;
    expect(s.remove).toEqual([{ did: r.people.maria, name: 'Maria', reason: 'left' }]);
    expect(s.remove.map(x => x.did)).not.toContain(stranger);
    expect(s.candidates.map(x => x.did)).not.toContain(r.people.own);
  });

  it('a replacement is offered with the old name; an offer for the admin itself is ignored', async () => {
    const r = await rig({ admin: true, anchor: 'ok', offers: w => ({ replace: [{ old_did: w.maria, new_did: w.newMaria, user_id: 'u1' }, { old_did: w.own, new_did: w.newMaria, user_id: 'u2' }] }) });
    const s = await r.c.status(TEAM);
    expect(s.role === 'admin' && s.replace).toEqual([{ oldDid: r.people.maria, newDid: r.people.newMaria, name: 'Maria', userId: 'u1', triesLeft: 3, compared: false, anchor: 'ok' }]);
  });

  it('re-sign is decided HERE from the own chain, not by what the Authority Server says', async () => {
    const gone = await rig({ admin: true, signerActive: false, offers: () => ({ resign: null }) });
    const sg = await gone.c.status(TEAM);
    expect(sg.role === 'admin' && sg.resign).toBe(true);
    const fine = await rig({ admin: true, signerActive: true, offers: () => ({ resign: { signer_key_id: 'k-signer' } }) });
    const sf = await fine.c.status(TEAM);
    expect(sf.role === 'admin' && sf.resign).toBe(false);
  });

  it('a member sees that the admin is gone, and never the admin\'s offers', async () => {
    const r = await rig({ admin: false, offers: () => ({ admin_gone: true }) });
    const s = await r.c.status(TEAM);
    expect(s).toMatchObject({ role: 'member', adminGone: true });
    expect(JSON.stringify(s)).not.toContain('"remove"');
  });
});

describe('remove: one touch, built on the verified head', () => {
  it('posts the list without that person: version + 1, prev = the head hash, admin stays, sorted', async () => {
    const r = await rig({ admin: true });
    const maria = r.head.list.members.find(m => m.name === 'Maria')!.did;
    expect(await r.c.removeMember(TEAM, maria)).toEqual({ version: 4 });
    const post = r.posts.find(p => p.method === 'POST')!;
    expect(post.path).toBe(`/api/teams/${TEAM}/members/remove`);
    expect(post.body.list.version).toBe(4);
    expect(post.body.list.prev).toBe(r.head.hash);
    expect(post.body.list.admin_did).toBe(r.people.own);
    expect(post.body.list.members.map((m: { did: string }) => m.did)).not.toContain(maria);
    expect(post.body.list.members.map((m: { did: string }) => m.did)).toEqual([...post.body.list.members.map((m: { did: string }) => m.did)].sort());
    expect(r.touches).toBe(1);
  });
  it('refuses to remove the admin itself, a stranger, or when this person is not the admin; no touch is spent', async () => {
    const r = await rig({ admin: true });
    await expect(r.c.removeMember(TEAM, r.people.own)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(r.c.removeMember(TEAM, await did())).rejects.toMatchObject({ code: 'not_a_member' });
    const m = await rig({ admin: false });
    await expect(m.c.removeMember(TEAM, m.people.maria)).rejects.toMatchObject({ code: 'not_admin' });
    expect(r.touches + m.touches).toBe(0);
  });
  it('without a verified head nothing is signed', async () => {
    const r = await rig({ admin: true, withHead: false });
    await expect(r.c.removeMember(TEAM, r.people.maria)).rejects.toMatchObject({ code: 'trust_unavailable' });
    expect(r.touches).toBe(0);
  });
});

describe('a new identity of a member is a new join', () => {
  const offerOf = (w: Who) => ({ replace: [{ old_did: w.maria, new_did: w.newMaria, name: 'Maria', user_id: 'u-maria', anchored: true }] });

  it('refuses before the code matched; then replaces the old DID by the new one with one touch', async () => {
    const r = await rig({ admin: true, anchor: 'ok', offers: offerOf });
    await expect(r.c.replaceMember(TEAM, 'u-maria')).rejects.toMatchObject({ code: 'not_compared' });
    expect(r.touches).toBe(0);
    const dk = await deviceKeys();
    // a wrong code counts; the right one (of the NEW DID the Authority Server names) matches
    expect(await r.c.replaceCheck(TEAM, 'u-maria', '0000')).toMatchObject({ match: false, triesLeft: 2 });
    expect(await r.c.replaceCheck(TEAM, 'u-maria', await dk.identityCode(r.people.newMaria))).toEqual({ match: true });
    expect((await r.c.replaceMember(TEAM, 'u-maria')).version).toBe(4);
    const post = r.posts.filter(p => p.method === 'POST').pop()!;
    expect(post.path).toBe(`/api/teams/${TEAM}/members/replace`);
    const dids = post.body.list.members.map((m: { did: string }) => m.did);
    expect(dids).toContain(r.people.newMaria);
    expect(dids).not.toContain(r.people.maria);
    expect(post.body.list.members.find((m: { did: string }) => m.did === r.people.newMaria).name).toBe('Maria');
    expect(r.touches).toBe(1);
  });

  it('a person whose new anchor is missing or does not verify is not confirmed; no touch is spent', async () => {
    for (const anchor of ['none', 'invalid'] as const) {
      const r = await rig({ admin: true, anchor, offers: offerOf });
      const dk = await deviceKeys();
      await r.c.replaceCheck(TEAM, 'u-maria', await dk.identityCode(r.people.newMaria));
      await expect(r.c.replaceMember(TEAM, 'u-maria')).rejects.toMatchObject({ code: 'anchor_required' });
      expect(r.touches).toBe(0);
    }
  });

  it('three wrong codes close this person\'s check; a person with no new identity yet cannot be checked', async () => {
    const r = await rig({ admin: true, anchor: 'ok', offers: offerOf });
    await r.c.replaceCheck(TEAM, 'u-maria', '1'); await r.c.replaceCheck(TEAM, 'u-maria', '2');
    expect(await r.c.replaceCheck(TEAM, 'u-maria', '3')).toMatchObject({ match: false, triesLeft: 0 });
    await expect(r.c.replaceCheck(TEAM, 'u-maria', '4')).rejects.toMatchObject({ code: 'tries_used' });
    const n = await rig({ admin: true, offers: w => ({ replace: [{ old_did: w.maria, new_did: null, user_id: 'u-maria' }] }) });
    await expect(n.c.replaceCheck(TEAM, 'u-maria', '1')).rejects.toMatchObject({ code: 'new_identity_missing' });
  });
});

describe('re-sign', () => {
  it('refused while the signer device is still one of the own devices', async () => {
    const r = await rig({ admin: true, signerActive: true });
    await expect(r.c.resign(TEAM)).rejects.toMatchObject({ code: 'resign_not_needed' });
    expect(r.touches).toBe(0);
  });
  it('posts the same members again, version + 1, once the signer is gone', async () => {
    const r = await rig({ admin: true, signerActive: false });
    expect(await r.c.resign(TEAM)).toEqual({ version: 4 });
    const post = r.posts.find(p => p.method === 'POST')!;
    expect(post.path).toBe(`/api/teams/${TEAM}/members/resign`);
    expect(post.body.list.members).toEqual(r.head.list.members);
    expect(post.body.sigs[0].key_id).toBe('k-me');
  });
});

describe('hand-over: the old admin signs last, and only what she expected', () => {
  it('the old admin names a member of the verified list and her own device; nothing is signed', async () => {
    const r = await rig({ admin: true });
    await r.c.handoverOffer(TEAM, r.people.maria);
    const post = r.posts.find(p => p.method === 'POST')!;
    expect(post.path).toBe(`/api/teams/${TEAM}/handover`);
    expect(post.body).toMatchObject({ new_admin_did: r.people.maria, handover: { key_id: 'k-me', chain_seq: 5 } });
    expect(r.touches).toBe(0);
    await expect(r.c.handoverOffer(TEAM, r.people.own)).rejects.toMatchObject({ code: 'not_a_member' });
  });
  it('the new admin builds the list on the device the old admin named and signs it', async () => {
    const r = await rig({ admin: false, handover: () => ({ you: 'new_admin', handover: { key_id: 'k-old', chain_seq: 9, chain_head: 'sha256:' + 'd'.repeat(64) }, list: null, sigs: null }) });
    expect(await r.c.handoverBuild(TEAM)).toEqual({ version: 4 });
    const post = r.posts.find(p => p.method === 'POST')!;
    expect(post.path).toBe(`/api/teams/${TEAM}/handover/list`);
    expect(post.body.list).toMatchObject({ admin_did: r.people.own, version: 4, prev: r.head.hash, handover: { admin_did: r.head.list.admin_did, key_id: 'k-old', chain_seq: 9 } });
    expect(post.body.list.members).toEqual(r.head.list.members);
  });
  it('a list that changes the members or does not name her device is refused and no touch is spent', async () => {
    const dk = await deviceKeys();
    const r = await rig({
      admin: true,
      handover: (head, w) => ({
        you: 'old_admin', handover: {}, sigs: [{ key_id: 'k-b', sig: 's', check: {} }],
        list: dk.buildMemberList({ ...head.list, version: 4, prev: head.hash, admin_did: w.maria, members: head.list.members.slice(0, 2), handover: { admin_did: w.own, key_id: 'k-me', chain_seq: 5, chain_head: 'sha256:' + 'c'.repeat(64) }, key_id: 'k-b', nonce: 'm' } as never),
      }),
    });
    await expect(r.c.handoverSign(TEAM)).rejects.toMatchObject({ code: expect.stringMatching(/handover_mismatch|list_invalid/) });
    expect(r.touches).toBe(0);
  });
});
