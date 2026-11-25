/**
 * DEC-73, steps 3 + 4 + stage C wired together: ONE verifier of the admin-signed member list, and both consumers use it.
 *
 * Real: a vault in a temp folder, the real stores, hap-core's real chain and list verification, the REAL `MandateGrants`
 * (its `teamTrustPort()` and `teamMembers()` are what index.ts passes on), the real `TeamJoin` and the real `DeviceReaders` /
 * `encryptProposalContent`. Stood in: the network to the Authority Server (a fake that serves chains, the team's lists and
 * what a hacked server would serve). Not covered here: the wiring inside `mountDeviceKeyRoutes` (suveren-e2e, team-trust-gateway).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  b64uEncode, buildEntry, buildMemberList, buildTeamMember, deriveRootKey, ecdsaRawToDer, ed25519PublicKey, entryHash, keyIdOf,
  memberListHash, objectHash, randomBytes, signEntry, signObject, type ChainEntry, type DeviceRecord, type MemberList,
} from '@hap/core/device-keys';
import { Vault } from '../lib/vault';
import { DeviceChainStore } from '../lib/device-chain-store';
import { DevicePinStore } from '../lib/device-pin-store';
import { MandateGrantStore } from '../lib/mandate-grant-store';
import { TeamTrustStore } from '../lib/team-trust-store';
import { MandateGrants, TeamTrustUnavailable } from '../lib/mandate-grants';
import { TeamJoin } from '../lib/team-join';
import { DeviceReaders } from '../lib/device-readers';
import { encryptProposalContent } from '../lib/content-crypto';
import { generateKeyPair } from '../lib/e2e-crypto';
import type { DeviceAsClient } from '../lib/device-as-client';

const legacy: Array<{ userId: string; did: string; pub: Uint8Array }> = [];
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: async (url: string) => {
    const seg = decodeURIComponent(url.split('/api/users/')[1].split('/')[0]);
    const a = legacy.find((x) => x.userId === seg || x.did === seg);
    return { res: { ok: !!a, status: a ? 200 : 404, json: async () => (a ? { userId: a.userId, pubkey: Buffer.from(a.pub).toString('base64'), did: a.did } : { error: 'nope' }) } };
  },
  AsTlsMismatchError: class extends Error {},
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const TEAM = 'team_one';
const NOW = 1_800_000_000;
let tick = 0;

async function checkOver(priv: webcrypto.CryptoKey, hash: string) {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  return { signature: b64uEncode(ecdsaRawToDer(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, digest)))) };
}

async function person() {
  const root = await deriveRootKey(randomBytes(16));
  const seed = randomBytes(32);
  const signPub = await ed25519PublicKey(seed);
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const read = await generateKeyPair();
  const record: DeviceRecord = {
    key_id: await keyIdOf(signPub), sign_pub: b64uEncode(signPub), read_pub: b64uEncode(read.publicKey), kind: 'gateway', label: 'Computer', keystore: 'platform',
    check: { type: 'platform', pub: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))) },
  };
  const e: ChainEntry = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: 1794000000, signer: 'root', device: record });
  const h = await entryHash(e);
  e.sigs = [await signEntry(e, 'root', root.privateSeed), await signEntry(e, record.key_id, seed)];
  e.checks = [{ by: record.key_id, check: await checkOver(kp.privateKey, h) }];
  return { did: root.did, seed, record, read, checkPriv: kp.privateKey, entries: [e], head: { seq: 0, hash: h } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function listOf(o: { version: number; prev: MemberList | null; members: Person[]; admin: Person }) {
  const members = await Promise.all(o.members.map((m) => buildTeamMember(m.did, 'Name')));
  members.sort((a, b) => (a.did < b.did ? -1 : 1));
  const { admin } = o;
  const list = buildMemberList({
    team_id: TEAM, version: o.version, prev: o.prev ? await memberListHash(o.prev) : null, admin_did: admin.did, members, handover: null,
    key_id: admin.record.key_id, chain_seq: admin.head.seq, chain_head: admin.head.hash, created_at: NOW + tick++, nonce: b64uEncode(randomBytes(16)),
  });
  const hash = await objectHash(list);
  return { list, sigs: [{ key_id: admin.record.key_id, sig: await signObject(list, admin.seed), check: await checkOver(admin.checkPriv, hash) }] };
}

class FakeAs {
  chains = new Map<string, unknown[]>();
  lists: Array<{ list: MemberList; sigs: unknown[] }> = [];
  ignoreFrom = false;
  serve(p: Person) { this.chains.set(p.did, p.entries); }
  readonly client = {
    asUrl: 'https://as.example',
    call: async (_m: string, path: string) => {
      if (path.startsWith('/api/devices/chain?did=')) {
        const entries = this.chains.get(decodeURIComponent(path.split('did=')[1]));
        if (!entries) return { status: 404, body: null };
        const last = entries[entries.length - 1] as ChainEntry;
        return { status: 200, body: { entries, head: { seq: last.seq, hash: await entryHash(last) } } };
      }
      const url = new URL(path, 'http://as.invalid');
      if (url.pathname === '/api/groups') return { status: 200, body: { groups: [{ id: 'personal', isPersonal: true }, { id: TEAM, isPersonal: false }] } };
      if (url.pathname === `/api/teams/${TEAM}/anchor`) return { status: 200, body: { anchor: null } };
      if (url.pathname === `/api/teams/${TEAM}/trust`) {
        const sorted = [...this.lists].sort((a, b) => a.list.version - b.list.version);
        const head = sorted[sorted.length - 1];
        const from = this.ignoreFrom ? 1 : Number(url.searchParams.get('from') ?? 1);
        return { status: 200, body: {
          team_id: TEAM, admin_did: head?.list.admin_did ?? null, head: head ? { version: head.list.version } : null,
          lists: sorted.filter((l) => l.list.version >= from), truncated: false, next_from: null, leaves: [], leaves_truncated: false, leaves_next_after: null,
        } };
      }
      return { status: 404, body: null };
    },
  } as unknown as DeviceAsClient;
}

/** The gateway of admin `me`, with the REAL MandateGrants whose two ports index.ts hands to the join and to the readers. */
async function boot(me: Person, as: FakeAs) {
  const clock = { t: NOW };
  const vault = new Vault(mkdtempSync(join(tmpdir(), 'team-int-')), { ...FAST, deviceKeys: true });
  await vault.createWithPassword('correct horse battery', 'u-me');
  vault.setCredential('e2eKey', { privateKey: Buffer.from(me.read.privateKey).toString('base64'), publicKey: Buffer.from(me.read.publicKey).toString('base64') } as never);
  vault.setSpCookie('Bearer test-token');
  vault.setSessionUser({ id: 'u-me', did: me.did });
  const store = new DeviceChainStore(vault);
  store.create({ v: 1, rootDid: me.did, keyId: me.record.key_id, head: me.head, asUrl: 'https://as.example', label: 'Computer', setUpAt: 1794000000 });
  const pins = new DevicePinStore(vault, store);
  const teamTrust = new TeamTrustStore(vault);
  const grants = new MandateGrants({ vault, store, client: as.client, pins, grants: new MandateGrantStore(vault), teamTrust, now: () => clock.t });
  const trust = grants.teamTrustPort();
  const joinScreens = new TeamJoin({ vault, store, grants, trust, now: () => clock.t });
  const readers = new DeviceReaders({ vault, store, client: as.client, pins, teamMembers: () => grants.teamMembers() });
  const deps = { spUrl: 'https://as.example', cookie: 'Bearer test-token', dataDir: '/tmp/x', selfUserId: 'u-me', selfDid: me.did, selfPublicKey: me.read.publicKey, device: { readers, selfPrivateKey: me.read.privateKey } };
  const session = () => grants.approvalSession();
  const headList = async () => (joinScreens as unknown as { headList(s: unknown, t: string): Promise<{ list: MemberList; hash: string }> }).headList(await session(), TEAM);
  return { clock, grants, teamTrust, trust, joinScreens, deps, headList, session };
}

describe('the join uses step 3\'s pinned head, and only that', () => {
  it('returns the verified head and the pin follows it; a server that serves an OLDER list afterwards is refused, not believed', async () => {
    const as = new FakeAs();
    const A = await person(); const M = await person();
    as.serve(A); as.serve(M);
    const v1 = await listOf({ version: 1, prev: null, members: [A], admin: A });
    const v2 = await listOf({ version: 2, prev: v1.list, members: [A, M], admin: A });
    as.lists = [v1, v2];
    const g = await boot(A, as);
    const head = await g.headList();
    expect(head.list.version).toBe(2);
    expect(head.hash).toBe(await memberListHash(v2.list));
    expect(g.teamTrust.pin(TEAM)).toMatchObject({ version: 2 });
    // A hacked Authority Server serves the list from before M was added. The join's old private verifier (first: true) would have taken it.
    as.lists = [v1]; as.ignoreFrom = true;
    g.clock.t += 301;   // past the 5 minutes: the next ask fetches again
    const err = await g.headList().catch((e) => e);
    expect(err).toMatchObject({ code: 'trust_unavailable', status: 422 });
    expect(['team_list_rollback', 'team_list_history_gap']).toContain(err.extra.reason);
    expect(g.teamTrust.pin(TEAM)).toMatchObject({ version: 2 });   // the pin did not move down
  });

  it('a port that says "cannot say" (TeamTrustUnavailable) is a refusal with a neutral code, never a 500 and never a signature', async () => {
    const as = new FakeAs();
    const A = await person(); as.serve(A);
    const g = await boot(A, as);
    const refused = new TeamJoin({ vault: {} as Vault, store: { exists: () => true } as never, grants: g.grants, trust: { head: async () => { throw new TeamTrustUnavailable('stale'); } } });
    const err = await (refused as unknown as { headList(s: unknown, t: string): Promise<unknown> }).headList(await g.session(), TEAM).catch((e) => e);
    expect(err).toMatchObject({ code: 'trust_unavailable', status: 422, extra: { reason: 'stale' } });
  });
});

describe('stage C with the real port: only the admin-signed list decides who gets a wrap', () => {
  it('a verified member without a chain gets no legacy wrap, and a decider who is not on the list gets none at all', async () => {
    legacy.length = 0;
    const as = new FakeAs();
    const A = await person();
    const M = await person();   // on the list; the Authority Server has no chain for them
    const O = await person();   // not on the list; chain fine
    as.serve(A); as.serve(O);
    const v1 = await listOf({ version: 1, prev: null, members: [A], admin: A });
    const v2 = await listOf({ version: 2, prev: v1.list, members: [A, M], admin: A });
    as.lists = [v1, v2];
    const k = await generateKeyPair();
    legacy.push({ userId: 'u-m', did: M.did, pub: k.publicKey });
    const g = await boot(A, as);
    const members = await g.grants.teamMembers();
    expect(g.teamTrust.warning(), JSON.stringify(g.teamTrust.warning())).toBeNull();
    expect([...(members ?? [])].sort()).toEqual([A.did, M.did].sort());
    const r = await encryptProposalContent({ to: 'x@example.com', amount: 5 }, [], g.deps, { ownerDid: A.did, deciders: [M.did, O.did] });
    expect((r.unreadableReaders ?? []).sort((a, b) => a.did.localeCompare(b.did))).toEqual([
      { did: M.did, code: 'chain_missing' }, { did: O.did, code: 'not_a_team_member' },
    ].sort((a, b) => a.did.localeCompare(b.did)));
    expect(r.content.readers).toEqual([A.did]);
    expect(r.content.keys).toEqual({});
  });

  it('with no verified list (a gateway whose team trust is blocked) nothing is honoured: teamMembers is null and today\'s legacy path stays', async () => {
    legacy.length = 0;
    const as = new FakeAs();
    const A = await person(); const M = await person();
    as.serve(A);
    as.lists = [];
    const k = await generateKeyPair();
    legacy.push({ userId: 'u-m', did: M.did, pub: k.publicKey });
    const g = await boot(A, as);
    expect(await g.grants.teamMembers()).toBeNull();
    const r = await encryptProposalContent({ a: 1 }, [], g.deps, { ownerDid: A.did, deciders: [M.did] });
    expect(r.content.readers.sort()).toEqual([A.did, M.did].sort());
  });
});
