/**
 * Who is a colleague: the team's signed member list, fetched and verified on the gateway (DEC-73, design 20.21.6; build step 3).
 *
 * Real hap-core objects: real device chains, real device keys, real platform checks (ECDSA P-256 over the object hash), real signed lists,
 * anchors and leaves, built HERE and verified by `refreshTeamTrust` with hap-core, and the real sealed vault slot. The only stand-in is the
 * Authority Server's network: a function that serves what a test puts in it, including what a hacked server would serve (an extra member, another
 * admin, an older list after a newer one, a second list at the same version). The two-gateways-and-a-real-Authority-Server case belongs to
 * suveren-e2e (test/team-trust-gateway.test.ts); this file pins the verification and the rules around it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  b64uEncode, buildAnchor, buildEntry, buildLeave, buildMemberList, buildTeamMember, deriveRootKey, ecdsaRawToDer, ed25519PublicKey,
  entryHash, keyIdOf, memberListHash, objectHash, randomBytes, signEntry, signObject, verifyChain,
  type ChainState, type CheckKey, type DeviceRecord, type MemberList,
} from '@hap/core/device-keys';
import { Vault } from '../lib/vault';
import { TeamTrustStore, TeamTrustRefused, type VerifiedTeam } from '../lib/team-trust-store';
import { refreshTeamTrust, honouredTeam, ensureTeamTrust, TEAM_TRUST_GRACE_SECONDS, TEAM_TRUST_REFRESH_SECONDS, type TeamTrustEnv } from '../lib/team-trust';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const TEAM = 'team_one';
const now0 = 1_800_000_000;

async function vault() {
  const v = new Vault(mkdtempSync(join(tmpdir(), 'team-trust-')), { ...FAST, deviceKeys: true });
  await v.createWithPassword('correct horse battery', 'u1');
  return v;
}

// ─── people with real chains ────────────────────────────────────────────────

async function checkOver(priv: webcrypto.CryptoKey, hash: string): Promise<{ signature: string }> {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, digest));
  return { signature: b64uEncode(ecdsaRawToDer(raw)) };
}

async function person(name: string) {
  const root = await deriveRootKey(randomBytes(16));
  const seed = randomBytes(32);
  const signPub = await ed25519PublicKey(seed);
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const check: CheckKey = { type: 'platform', pub: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))) };
  const record: DeviceRecord = { key_id: await keyIdOf(signPub), sign_pub: b64uEncode(signPub), read_pub: b64uEncode(randomBytes(32)), kind: 'gateway', label: `${name}'s computer`, keystore: 'platform', check };
  const g = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: now0, signer: 'root', device: record });
  const h = await entryHash(g);
  g.sigs = [await signEntry(g, 'root', root.privateSeed), await signEntry(g, record.key_id, seed)];
  g.checks = [{ by: record.key_id, check: await checkOver(kp.privateKey, h) }];
  const state: ChainState = await verifyChain({ expectedRootDid: root.did, entries: [g] });
  return { name, did: root.did, seed, keyId: record.key_id, checkPriv: kp.privateKey, entries: [g], state };
}
type Person = Awaited<ReturnType<typeof person>>;

// ─── signed objects ─────────────────────────────────────────────────────────

let tick = 0;
const nonce = () => b64uEncode(randomBytes(16));

async function listOf(o: { version: number; prev: MemberList | null; members: Person[]; admin: Person; handover?: Person; names?: string }) {
  const { admin } = o;
  const members = await Promise.all(o.members.map(m => buildTeamMember(m.did, `${o.names ?? 'Name'} of ${m.name}`)));
  members.sort((a, b) => (a.did < b.did ? -1 : 1));
  const old = o.handover;
  const list = buildMemberList({
    team_id: TEAM, version: o.version, prev: o.prev ? await memberListHash(o.prev) : null, admin_did: admin.did, members,
    handover: old ? { admin_did: old.did, key_id: old.keyId, chain_seq: old.state.head.seq, chain_head: old.state.head.hash } : null,
    key_id: admin.keyId, chain_seq: admin.state.head.seq, chain_head: admin.state.head.hash, created_at: now0 + (tick++), nonce: nonce(),
  });
  const hash = await objectHash(list);
  const sigs: unknown[] = [{ key_id: admin.keyId, sig: await signObject(list, admin.seed), check: await checkOver(admin.checkPriv, hash) }];
  if (old) sigs.push({ key_id: old.keyId, sig: await signObject(list, old.seed), check: await checkOver(old.checkPriv, hash) });
  return { list, sigs };
}

async function anchorOf(m: Person, admin: Person) {
  const anchor = buildAnchor({ member_did: m.did, team_id: TEAM, admin_did: admin.did, version: 1, prev: null, key_id: m.keyId, chain_seq: m.state.head.seq, chain_head: m.state.head.hash, created_at: now0, nonce: nonce() });
  return { anchor, sig: await signObject(anchor, m.seed), check: await checkOver(m.checkPriv, await objectHash(anchor)) };
}

async function leaveOf(m: Person, listVersion: number) {
  const leave = buildLeave({ member_did: m.did, team_id: TEAM, list_version: listVersion, key_id: m.keyId, chain_seq: m.state.head.seq, chain_head: m.state.head.hash, created_at: now0, nonce: nonce() });
  return { leave, sig: await signObject(leave, m.seed), member_did: m.did };
}

// ─── the Authority Server's network, as a hacked one could serve it ─────────

interface Served {
  lists: Array<{ list: MemberList; sigs: unknown[] }>;
  anchor: unknown | null;
  leaves: Array<{ leave: unknown; sig: unknown; member_did: string }>;
  /** Versions per window (the real server: at most 256) and leaves per page. */
  window: number;
  leafPage: number;
  unreachable: boolean;
  isRequester: boolean;
  /** A server that ignores `from` and serves what it likes (an older list than the caller asked for). */
  ignoreFrom: boolean;
  calls: string[];
}

function rig(opts: { me: Person; chains: Person[]; store: TeamTrustStore }) {
  const served: Served = { lists: [], anchor: null, leaves: [], window: 256, leafPage: 1000, unreachable: false, isRequester: false, ignoreFrom: false, calls: [] };
  const clock = { now: now0 };
  const chains = new Map(opts.chains.map(p => [p.did, p.state]));
  const env: TeamTrustEnv = {
    store: opts.store, ownDid: opts.me.did, own: opts.me.state, now: () => clock.now,
    chain: async (did) => {
      const c = chains.get(did);
      if (!c) throw Object.assign(new Error('chain_unknown'), { code: 'chain_unknown' });
      return c;
    },
    get: async (path) => {
      served.calls.push(path);
      if (served.unreachable) throw Object.assign(new Error('as_unreachable'), { code: 'as_unreachable' });
      const url = new URL(path, 'http://as.invalid');
      if (url.pathname === '/api/groups') return { status: 200, body: { groups: [{ id: 'personal', isPersonal: true }, { id: TEAM, isPersonal: false }] } };
      if (url.pathname === `/api/teams/${TEAM}/anchor`) return { status: 200, body: { anchor: served.anchor } };
      if (url.pathname === `/api/teams/${TEAM}/trust`) {
        const sorted = [...served.lists].sort((a, b) => a.list.version - b.list.version);
        const headList = sorted[sorted.length - 1];
        if (served.isRequester) return { status: 200, body: { team_id: TEAM, admin_did: headList?.list.admin_did ?? null, head: null } };
        const from = served.ignoreFrom ? 1 : Number(url.searchParams.get('from') ?? 1);
        const after = Number(url.searchParams.get('leaves_after') ?? 0);
        const win = sorted.filter(l => l.list.version >= from).slice(0, served.window);
        const truncated = win.length > 0 && win[win.length - 1].list.version < headList.list.version;
        const page = served.leaves.slice(after, after + served.leafPage);
        const more = after + served.leafPage < served.leaves.length;
        return { status: 200, body: {
          team_id: TEAM, admin_did: headList?.list.admin_did ?? null, head: headList ? { version: headList.list.version } : null,
          lists: win, truncated, next_from: truncated ? win[win.length - 1].list.version + 1 : null,
          leaves: page, leaves_truncated: more, leaves_next_after: more ? after + served.leafPage : null,
        } };
      }
      return { status: 404, body: null };
    },
  };
  return { env, served, clock, chains };
}

/** admin A (v1: alone) and member M (v2: A + M); M's anchor names A. */
async function team() {
  const A = await person('Anna');
  const M = await person('Max');
  const v1 = await listOf({ version: 1, prev: null, members: [A], admin: A });
  const v2 = await listOf({ version: 2, prev: v1.list, members: [A, M], admin: A });
  return { A, M, v1, v2, anchor: await anchorOf(M, A) };
}

// ─── the member's gateway ───────────────────────────────────────────────────

describe('a member\'s gateway verifies the team\'s list with hap-core', () => {
  it('honours the colleagues of a list the admin signed: the pin and the member set are kept in the sealed slot', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    const out = await refreshTeamTrust(r.env);
    expect(out).toMatchObject({ ok: true });
    expect(honouredTeam(store, r.clock.now)?.members.map(m => m.did).sort()).toEqual([t.A.did, t.M.did].sort());
    expect(honouredTeam(store, r.clock.now)?.members.find(m => m.did === t.A.did)?.name).toBe('Name of Anna');
    expect(store.pin(TEAM)).toMatchObject({ version: 2 });
    expect(store.colleagues().sort()).toEqual([t.A.did, t.M.did].sort());
    expect(store.warning()).toBeNull();
    // a later run reads from the pin, not from the start
    await refreshTeamTrust(r.env);
    expect(r.served.calls.some(c => /\/trust\?from=2$/.test(c))).toBe(true);
  });

  it('a gateway without a verified list honours no colleague, and without an anchor there is no list', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    expect(honouredTeam(store, now0)).toBeNull();
    expect(store.colleagues()).toEqual([]);
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = null;
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_anchor_missing' });
    expect(honouredTeam(store, now0)).toBeNull();
    expect(store.warning()).toMatchObject({ code: 'team_anchor_missing' });
  });

  it('a member the admin never listed is no colleague, even with an anchor and a head: the list must name this person', async () => {
    const t = await team();
    const stranger = await person('Sam');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: stranger, chains: [t.A, stranger], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = await anchorOf(stranger, t.A);
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_not_a_member' });
    expect(honouredTeam(store, now0)).toBeNull();
  });

  it('an Authority Server that adds a member by hand to a list it carries: the signature breaks, the added person is no colleague', async () => {
    const t = await team();
    const evil = await person('Eve');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    // the same version, a row added to its members
    const forged = JSON.parse(JSON.stringify(t.v2)) as typeof t.v2;
    forged.list.members.push(await buildTeamMember(evil.did, 'Eve'));
    forged.list.members.sort((a, b) => (a.did < b.did ? -1 : 1));
    r.served.lists = [t.v1, forged];
    const out = await refreshTeamTrust(r.env);
    expect(out.ok).toBe(false);
    expect(honouredTeam(store, r.clock.now)?.members.some(m => m.did === evil.did) ?? false).toBe(false);
    expect(store.colleagues()).not.toContain(evil.did);
  });

  it('a list signed by another admin (no hand-over) is refused and shown: nothing of the team is honoured', async () => {
    const t = await team();
    const B = await person('Bob');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M, B], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    const v3 = await listOf({ version: 3, prev: t.v2.list, members: [B, t.M], admin: B });
    r.served.lists = [t.v1, t.v2, v3];
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_list_rejected' });
    expect(store.warning()).toMatchObject({ code: 'team_list_rejected', version: 3 });
    expect(honouredTeam(store, r.clock.now)).toBeNull();
    expect(store.colleagues()).toEqual([]);
  });

  it('an older list after a newer one was seen is a rollback: refused, the pin stays, no colleague is honoured', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    r.served.lists = [t.v1];                       // the Authority Server serves the list from before M was added, whatever was asked
    r.served.ignoreFrom = true;
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_list_rollback' });
    expect(store.pin(TEAM)).toMatchObject({ version: 2 });
    expect(honouredTeam(store, r.clock.now)).toBeNull();
  });

  it('a second list at the pinned version is a fork', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    const other = await listOf({ version: 2, prev: t.v1.list, members: [t.A, t.M], admin: t.A, names: 'Other' });
    r.served.lists = [t.v1, other];
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_list_fork' });
    expect(honouredTeam(store, r.clock.now)).toBeNull();
  });

  it('a new computer of a member that has a pin but cannot see the versions between it and the served list: history gap, refused', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.anchor = t.anchor;
    // pin at version 2; the Authority Server serves only version 5 of a chain of versions it holds back
    let prev = t.v2.list;
    let v5 = t.v2;
    for (let v = 3; v <= 5; v++) { v5 = await listOf({ version: v, prev, members: [t.A, t.M], admin: t.A }); prev = v5.list; }
    r.served.lists = [t.v1, t.v2];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    r.served.lists = [v5];
    const out = await refreshTeamTrust(r.env);
    expect(out.ok).toBe(false);
    expect(['team_list_history_gap', 'team_list_missing']).toContain((out as { code: string }).code);
    expect(honouredTeam(store, r.clock.now)).toBeNull();
  });

  it('a member who left (their own signed leave) is no colleague; leaves are read page by page', async () => {
    const t = await team();
    const N = await person('Nora');
    const O = await person('Otto');
    const v3 = await listOf({ version: 3, prev: t.v2.list, members: [t.A, t.M, N, O], admin: t.A });
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M, N, O], store });
    r.served.lists = [t.v1, t.v2, v3];
    r.served.anchor = t.anchor;
    r.served.leaves = [await leaveOf(N, 3), await leaveOf(O, 3)];
    r.served.leafPage = 1;                          // one leave per page: both pages are needed
    const out = await refreshTeamTrust(r.env);
    expect(out.ok).toBe(true);
    expect(store.colleagues().sort()).toEqual([t.A.did, t.M.did].sort());
    expect(r.served.calls.some(c => c.includes('leaves_after=1'))).toBe(true);
  });

  it('a window of lists is paged: 120 versions in windows of 50 end at the newest', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    let prev = t.v2.list;
    const lists = [t.v1, t.v2];
    for (let v = 3; v <= 120; v++) { const l = await listOf({ version: v, prev, members: [t.A, t.M], admin: t.A }); lists.push(l); prev = l.list; }
    r.served.lists = lists;
    r.served.anchor = t.anchor;
    r.served.window = 50;
    const out = await refreshTeamTrust(r.env);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(store.pin(TEAM)).toMatchObject({ version: 120 });
  });

  it('a person who is in no team has nothing to verify', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    const get = r.env.get;
    r.env.get = async (p) => (p === '/api/groups' ? { status: 200, body: { groups: [{ id: 'personal', isPersonal: true }] } } : get(p));
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'no_team' });
    expect(store.currentTeam()).toBeNull();
    expect(honouredTeam(store, now0)).toBeNull();
  });
});

describe('freshness: 5 minutes to the next fetch, 15 minutes of grace, then nothing', () => {
  it('a fresh verification is not fetched again; an older one is', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    await ensureTeamTrust(r.env);
    const n = r.served.calls.length;
    r.clock.now += TEAM_TRUST_REFRESH_SECONDS - 1;
    await ensureTeamTrust(r.env);
    expect(r.served.calls.length).toBe(n);
    r.clock.now += 2;
    await ensureTeamTrust(r.env);
    expect(r.served.calls.length).toBeGreaterThan(n);
  });

  it('an Authority Server that cannot be reached: the last verified state stays for 15 minutes, then no colleague is honoured', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    r.served.unreachable = true;
    r.clock.now += TEAM_TRUST_REFRESH_SECONDS + 1;
    expect((await ensureTeamTrust(r.env))?.version).toBe(2);
    expect(store.warning()).toMatchObject({ code: 'team_list_unreachable' });
    r.clock.now = now0 + TEAM_TRUST_GRACE_SECONDS - 1;
    expect(honouredTeam(store, r.clock.now)).not.toBeNull();
    r.clock.now = now0 + TEAM_TRUST_GRACE_SECONDS + 1;
    expect(honouredTeam(store, r.clock.now)).toBeNull();
    // it comes back when the Authority Server does
    r.served.unreachable = false;
    expect((await ensureTeamTrust(r.env))?.version).toBe(2);
    expect(store.warning()).toBeNull();
  });

  it('a requester view (this person is no active member) is no colleague list', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.M, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.anchor = t.anchor;
    r.served.isRequester = true;
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_not_a_member' });
  });
});

// ─── the admin's gateway ────────────────────────────────────────────────────

describe('the admin\'s gateway: its own chain is the root, there is no anchor', () => {
  it('a member who left (own signed leave) is not honoured by the admin\'s gateway either, before the admin signs a new list', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    r.served.leaves = [await leaveOf(t.M, 2)];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    expect(store.colleagues()).toEqual([t.A.did]);
  });

  it('verifies the lists against its own chain and honours the listed members', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    const out = await refreshTeamTrust(r.env);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(store.colleagues().sort()).toEqual([t.A.did, t.M.did].sort());
    expect(store.pin(TEAM)).toMatchObject({ version: 2 });
  });

  it('the server naming someone else as admin does not move an admin to the member path: no hand-over means rejected, blocking', async () => {
    const t = await team();
    const B = await person('Bob');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M, B], store });
    r.served.lists = [t.v1, t.v2];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    expect(store.pinnedAdmin(TEAM)).toBe(t.A.did);
    const v3 = await listOf({ version: 3, prev: t.v2.list, members: [B, t.A, t.M], admin: B });
    r.served.lists = [t.v1, t.v2, v3];
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_list_rejected' });
    expect(honouredTeam(store, r.clock.now)).toBeNull();
  });

  it('a valid hand-over from this admin (both signatures) is followed: the pin moves, the former admin needs a fresh anchor and honours nothing until then', async () => {
    const t = await team();
    const B = await person('Bob');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M, B], store });
    r.served.lists = [t.v1, t.v2];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    const v3 = await listOf({ version: 3, prev: t.v2.list, members: [B, t.A, t.M], admin: B, handover: t.A });
    r.served.lists = [t.v1, t.v2, v3];
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_anchor_missing' });
    expect(store.pin(TEAM)).toMatchObject({ version: 3 });
    expect(store.pinnedAdmin(TEAM)).toBe(B.did);
    expect(honouredTeam(store, r.clock.now)).toBeNull();
    // the next run is a member's: without an anchor for Bob there is still nothing; with one the list is honoured
    r.clock.now += 60;
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_anchor_missing' });
    r.served.anchor = await anchorOf(t.A, B);
    const again = await refreshTeamTrust(r.env);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(store.colleagues().sort()).toEqual([B.did, t.A.did, t.M.did].sort());
  });

  it('a hand-over signed by the new admin alone (no signature of this admin) is not followed', async () => {
    const t = await team();
    const B = await person('Bob');
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M, B], store });
    r.served.lists = [t.v1, t.v2];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    const v3 = await listOf({ version: 3, prev: t.v2.list, members: [B, t.A, t.M], admin: B, handover: t.A });
    (v3.sigs as unknown[]).pop();
    r.served.lists = [t.v1, t.v2, v3];
    expect(await refreshTeamTrust(r.env)).toEqual({ ok: false, code: 'team_list_rejected' });
  });

  it('keeps the verified head list itself (as signed) for the join screens, on both paths', async () => {
    const t = await team();
    const sa = new TeamTrustStore(await vault());
    const ra = rig({ me: t.A, chains: [t.A, t.M], store: sa });
    ra.served.lists = [t.v1, t.v2];
    await refreshTeamTrust(ra.env);
    expect(sa.verified()?.head).toMatchObject({ version: 2, admin_did: t.A.did });
    const sm = new TeamTrustStore(await vault());
    const rm = rig({ me: t.M, chains: [t.A, t.M], store: sm });
    rm.served.lists = [t.v1, t.v2];
    rm.served.anchor = t.anchor;
    await refreshTeamTrust(rm.env);
    expect(sm.verified()?.head).toMatchObject({ version: 2, admin_did: t.A.did });
  });

  it('an older list after a newer one was seen is a rollback here too', async () => {
    const t = await team();
    const store = new TeamTrustStore(await vault());
    const r = rig({ me: t.A, chains: [t.A, t.M], store });
    r.served.lists = [t.v1, t.v2];
    expect((await refreshTeamTrust(r.env)).ok).toBe(true);
    r.served.lists = [t.v1];
    r.served.ignoreFrom = true;
    const out = await refreshTeamTrust(r.env);
    expect(out.ok).toBe(false);
    expect(honouredTeam(store, r.clock.now)).toBeNull();
  });
});

// ─── the sealed slot ────────────────────────────────────────────────────────

describe('the teamTrust slot', () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;
  const ver = (version: number, c: string, did = 'did:key:z6MkAdmin'): VerifiedTeam => ({ adminDid: did, version, hash: H(c), members: [{ did, name: 'A' }], verifiedAt: now0 });

  it('the pin only moves up: lower is a rollback, the same version with another hash is a fork; the Authority Server cannot lower it', async () => {
    const st = new TeamTrustStore(await vault());
    st.accept(TEAM, ver(3, 'a'));
    expect(() => st.accept(TEAM, ver(2, 'b'))).toThrow(TeamTrustRefused);
    try { st.accept(TEAM, ver(2, 'b')); } catch (e) { expect((e as TeamTrustRefused).reason).toBe('rollback'); }
    try { st.accept(TEAM, ver(3, 'b')); } catch (e) { expect((e as TeamTrustRefused).reason).toBe('fork'); }
    st.accept(TEAM, ver(3, 'a'));
    st.accept(TEAM, ver(4, 'c'));
    expect(st.pin(TEAM)).toEqual({ version: 4, hash: H('c') });
  });

  it('is sealed: it survives a restart (same vault file) and is not in the clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-trust-'));
    const v = new Vault(dir, { ...FAST, deviceKeys: true });
    await v.createWithPassword('correct horse battery', 'u1');
    new TeamTrustStore(v).accept(TEAM, ver(3, 'a'));
    const again = new Vault(dir, { ...FAST, deviceKeys: true });
    await again.unlockWithPassword('correct horse battery');
    expect(new TeamTrustStore(again).pin(TEAM)).toEqual({ version: 3, hash: H('a') });
    expect((await import('node:fs')).readFileSync(join(dir, 'vault.enc.json'), 'utf8')).not.toContain('did:key:z6MkAdmin');
  });

  it('a blocking warning drops what was verified; a good verification clears the warning', async () => {
    const st = new TeamTrustStore(await vault());
    st.accept(TEAM, ver(3, 'a'));
    st.warn(TEAM, 'team_list_unreachable', now0);
    expect(st.colleagues()).toEqual(['did:key:z6MkAdmin']);   // a failed fetch alone does not stop the grace window
    st.warn(TEAM, 'team_list_rollback', now0);
    expect(st.colleagues()).toEqual([]);
    expect(st.verified()).toBeNull();
    st.accept(TEAM, ver(4, 'b'));
    expect(st.warning()).toBeNull();
    expect(st.colleagues()).toEqual(['did:key:z6MkAdmin']);
  });
});
