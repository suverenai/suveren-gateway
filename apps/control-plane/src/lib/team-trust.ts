/**
 * Who is a colleague: the team's signed member list, fetched from the Authority Server and verified HERE with hap-core
 * (DEC-73, design 20.21.2, 20.21.3, 20.21.6; build step 3). The Authority Server only carries; nothing it says about a member is
 * believed unless the admin's device signed it and the verification below holds.
 *
 *   - A MEMBER's gateway runs hap-core `verifyTeamTrust` on its own anchor ("I trust this admin for this team", signed by its own
 *     device), the admin's verified chain, every list version from its pin up, and the members' own leaves.
 *   - The ADMIN's gateway has no anchor: its own chain is the root. It walks the lists with `verifyMemberList` against its own chain.
 *   - The pin (highest version and hash accepted) lives in a sealed vault slot (lib/team-trust-store.ts); the Authority Server cannot
 *     lower it. Rollback, fork, a gap in the history, or a newer version that was refused: nothing is honoured and a warning code
 *     stays for the page. A failed fetch keeps the last verified state for 15 minutes, then refuses.
 *
 * Both list windows are paged: a window of lists holds at most 256 versions (`next_from`); its leaves are paged with a cursor
 * (`leaves_next_after`). Nothing is logged but codes.
 *
 * Pure of the vault and the Authority Server: everything it needs comes in through {@link TeamTrustEnv}.
 */

import type { ChainState, MemberList, TeamPin, TeamTrust } from '@hap/core/device-keys';
import { deviceKeys, isDeviceKeysError, type DeviceKeys } from './device-keys-lazy';
import { BLOCKING_CODES, TeamTrustRefused, type TeamTrustCode, type TeamTrustStore, type VerifiedTeam } from './team-trust-store';

/** How old a verified state may get before it is fetched again (design: every 5 minutes, with the grant re-check). */
export const TEAM_TRUST_REFRESH_SECONDS = 5 * 60;
/** How long the last verified state stays in force when a fetch does not succeed (the same window as grants, 4.4 "Freshness"). */
export const TEAM_TRUST_GRACE_SECONDS = 15 * 60;

/** After a refused or failed run, the next question waits this long before it fetches again. */
export const TEAM_TRUST_RETRY_SECONDS = 30;
const MAX_WINDOWS = 32;
const MAX_LEAF_PAGES = 10;
const MAX_ADMINS = 16;
/** Distinct member chains fetched to check leaves in one run; a leave whose chain is not fetched is skipped (and reported by hap-core). */
const MAX_LEAF_CHAINS = 64;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A refusal with a code (the code is all the page needs). */
export class TeamTrustFailure extends Error {
  constructor(readonly code: TeamTrustCode, readonly version?: number) {
    super(code);
    this.name = 'TeamTrustFailure';
  }
}

export interface TeamTrustEnv {
  store: TeamTrustStore;
  /** The signed-in person: root DID and the chain this gateway already verified for it (the member's `anchorChain`, the admin's root). */
  ownDid: string;
  own: ChainState;
  /** A GET at the Authority Server as this person. Throws when it cannot be reached. */
  get(path: string): Promise<{ status: number; body: any }>;
  /**
   * Another person's device chain, verified from the genesis on against the head pinned before, and its pin moved forward
   * (lib/mandate-grants.ts `chainOf` and `DevicePinStore.advance`). Throws with a `code` when it does not verify
   * (`chain_rollback`, `chain_fork`, `chain_invalid`, `chain_unknown`, `as_*`).
   */
  chain(did: string): Promise<ChainState>;
  /** Epoch seconds. */
  now(): number;
}

export type RefreshResult =
  | { ok: true; team: VerifiedTeam }
  | { ok: false; code: TeamTrustCode | 'no_team' };

// ─── fetch ────────────────────────────────────────────────────────────────

interface Page {
  adminDid: string | null;
  lists: { list: unknown; sigs: unknown }[];
  truncated: boolean;
  lastVersion: number;
  leaves: { leave: unknown; sig: unknown; memberDid: string }[];
}

/** One window of lists from `from`, and ALL of the leaves of that window (read on with the cursor until the Authority Server says it is done). */
async function fetchWindow(env: TeamTrustEnv, teamId: string, from: number): Promise<Page> {
  const base = `/api/teams/${encodeURIComponent(teamId)}/trust?from=${from}`;
  let first: any = null;
  const leaves: Page['leaves'] = [];
  let after = 0;
  for (let n = 0; n < MAX_LEAF_PAGES; n++) {
    const r = await env.get(n === 0 ? base : `${base}&leaves_after=${after}`);
    if (r.status === 404) throw new TeamTrustFailure('team_list_missing');
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.lists) || !Array.isArray(r.body.leaves)) throw new TeamTrustFailure('team_list_unreachable');
    if (n === 0) first = r.body;
    for (const l of r.body.leaves) {
      if (!isObj(l) || typeof l.member_did !== 'string' || !DID.test(l.member_did)) throw new TeamTrustFailure('team_list_invalid');
      leaves.push({ leave: l.leave, sig: l.sig, memberDid: l.member_did });
    }
    if (r.body.leaves_truncated !== true) {
      const lists = first.lists.filter(isObj) as { list: unknown; sigs: unknown }[];
      const versions = lists.map(l => (isObj(l.list) && typeof l.list.version === 'number' ? l.list.version : 0));
      return {
        adminDid: typeof first.admin_did === 'string' ? first.admin_did : null,
        lists,
        truncated: first.truncated === true,
        lastVersion: versions.length ? Math.max(...versions) : 0,
        leaves,
      };
    }
    if (!Number.isSafeInteger(r.body.leaves_next_after) || r.body.leaves_next_after <= after) throw new TeamTrustFailure('team_list_invalid');
    after = r.body.leaves_next_after;
  }
  throw new TeamTrustFailure('team_list_invalid');
}

/** The admins that signed (or handed over in) a window, with the chains this gateway verified for them. The anchored admin MUST have one. */
async function adminChainsOf(env: TeamTrustEnv, lists: Page['lists'], anchored: string | null): Promise<Record<string, ChainState>> {
  const dids = new Set<string>();
  if (anchored) dids.add(anchored);
  for (const l of lists) {
    if (!isObj(l.list)) continue;
    if (typeof l.list.admin_did === 'string' && DID.test(l.list.admin_did)) dids.add(l.list.admin_did);
    const h = l.list.handover;
    if (isObj(h) && typeof h.admin_did === 'string' && DID.test(h.admin_did)) dids.add(h.admin_did);
    if (dids.size > MAX_ADMINS) throw new TeamTrustFailure('team_list_invalid');
  }
  const out: Record<string, ChainState> = {};
  for (const did of dids) {
    if (did === env.ownDid) { out[did] = env.own; continue; }
    try { out[did] = await env.chain(did); } catch (e) {
      // The admin the member trusts must verify. Another admin that does not simply leaves its versions unverified (they are refused and reported).
      if (did === anchored) throw e;
    }
  }
  return out;
}

/** The leaves of a window, each with the verified chain of its member. A leave whose chain cannot be had is left out. */
async function leavesWithChains(env: TeamTrustEnv, page: Page): Promise<{ env: { leave: unknown; sig: unknown }; chain: ChainState }[]> {
  const chains = new Map<string, ChainState | null>();
  const out: { env: { leave: unknown; sig: unknown }; chain: ChainState }[] = [];
  for (const l of page.leaves) {
    let chain = chains.get(l.memberDid);
    if (chain === undefined) {
      if (l.memberDid === env.ownDid) chain = env.own;
      else if (chains.size >= MAX_LEAF_CHAINS) chain = null;
      else { try { chain = await env.chain(l.memberDid); } catch { chain = null; } }
      chains.set(l.memberDid, chain);
    }
    if (chain) out.push({ env: { leave: l.leave, sig: l.sig }, chain });
  }
  return out.slice(0, 1000);
}

// ─── verify ───────────────────────────────────────────────────────────────

const toPin = (p: { version: number; hash: string } | null): TeamPin | null => (p ? { version: p.version, hash: p.hash } : null);

interface Verified { adminDid: string; version: number; hash: string; members: { did: string; name: string }[]; rejected: { version: number; code: string } | null; anchorPin?: TeamPin }

/** A member's check: the anchor, the admin's chain, the lists from the pin up, the leaves. */
async function verifyAsMember(env: TeamTrustEnv, dk: DeviceKeys, teamId: string): Promise<Verified> {
  const a = await env.get(`/api/teams/${encodeURIComponent(teamId)}/anchor`);
  if (a.status !== 200 || !isObj(a.body)) throw new TeamTrustFailure('team_list_unreachable');
  const anchorEnv = a.body.anchor;
  if (!isObj(anchorEnv) || !isObj(anchorEnv.anchor)) throw new TeamTrustFailure('team_anchor_missing');
  const anchorAdmin = typeof anchorEnv.anchor.admin_did === 'string' ? anchorEnv.anchor.admin_did : null;
  const anchor = { anchor: anchorEnv.anchor, sig: anchorEnv.sig, check: anchorEnv.check ?? undefined };

  let pin = toPin(env.store.pin(teamId));
  let from = pin?.version ?? 1;
  let retried = false;
  for (let round = 0; round < MAX_WINDOWS; round++) {
    const page = await fetchWindow(env, teamId, from);
    if (page.lists.length === 0) throw new TeamTrustFailure('team_list_missing');
    // A window of the full history that stops below the pin cannot be linked to it: never read as a rollback.
    if (page.truncated && pin && page.lastVersion < pin.version) throw new TeamTrustFailure('team_list_history_gap');
    const adminChains = await adminChainsOf(env, page.lists, anchorAdmin);
    let trust: TeamTrust;
    try {
      trust = await dk.verifyTeamTrust({
        team_id: teamId, anchor, anchorChain: env.own, anchorPin: toPin(env.store.anchorPin(teamId)),
        versions: page.lists, adminChains, pin, leaves: await leavesWithChains(env, page),
      });
    } catch (e) {
      // From the pin up is the cheap read. When the first list of the anchored admin lies below it, read the whole history once.
      const code = isDeviceKeysError(e) ? e.code : '';
      if (from > 1 && !retried && (code === 'NO_TRUST' || code === 'HISTORY_GAP' || code === 'BAD_VERSION')) { retried = true; from = 1; continue; }
      throw e;
    }
    if (page.truncated) {
      // Not the last window: the next one starts at what was accepted here. Without progress the history cannot be walked.
      if (trust.version <= from) throw new TeamTrustFailure('team_list_history_gap');
      pin = trust.pin;
      from = trust.version;
      continue;
    }
    const a2 = dk.validateAnchor(anchor.anchor);
    return {
      adminDid: trust.admin_did, version: trust.version, hash: trust.hash,
      members: trust.members.map(m => ({ did: m.did, name: m.name })),
      rejected: trust.rejected,
      anchorPin: { version: a2.version, hash: await dk.anchorHash(a2) },
    };
  }
  throw new TeamTrustFailure('team_list_history_gap');
}

/** DIDs whose own verified `leave` applies at `best` (admin-path counterpart of the leave rule in hap-core's verifyTeamTrust). */
async function appliedLeaves(env: TeamTrustEnv, dk: DeviceKeys, teamId: string, page: Page, lists: MemberList[], best: MemberList): Promise<Set<string>> {
  const left = new Set<string>();
  for (const l of await leavesWithChains(env, page)) {
    try {
      const x = await dk.verifyLeave(l.env, { chain: l.chain, expect: { team_id: teamId } });
      if (x.list_version > best.version || x.member_did === best.admin_did) continue;
      let continuous = true;
      for (let v = x.list_version; v <= best.version && continuous; v++) {
        const at = lists.find(m => m.version === v);
        if (!at) { continuous = false; break; }
        if (!at.members.some(m => m.did === x.member_did)) continuous = false;
      }
      if (continuous) left.add(x.member_did);
    } catch { /* judged alone: a leave that does not verify or apply is skipped */ }
  }
  return left;
}

/**
 * The admin's check. The admin has no anchor: every version in the walk must name this person as admin and verify against this
 * person's own chain (the pin stands in for the re-sign rule). The members' own leaves are applied here too, by the rule of hap-core's
 * `verifyTeamTrust` (a leaver is honoured nowhere, even before the admin signs a new list): each leave verifies against its member's chain
 * (same 64-chain cap), applies only if its list_version is not above the accepted version and the member stays listed in every window
 * version from there up; a leave that cannot be judged (history below the window, no chain) is skipped.
 *
 * Known limits, refused on the safe side: a history of more than 256 versions between the first list of the anchored admin and the pin
 * cannot be walked (`team_list_history_gap`), and a `from` the Authority Server does not honour ends in gap, missing or rollback.
 */
async function verifyAsAdmin(env: TeamTrustEnv, dk: DeviceKeys, teamId: string): Promise<Verified> {
  let pin = toPin(env.store.pin(teamId));
  let from = pin?.version ?? 1;
  for (let round = 0; round < MAX_WINDOWS; round++) {
    const page = await fetchWindow(env, teamId, from);
    const seen: { list: MemberList; hash: string; env: { list: unknown; sigs: unknown } }[] = [];
    for (const e of page.lists) {
      const list = dk.validateMemberList(e.list);
      if (list.team_id !== teamId) throw new TeamTrustFailure('team_list_invalid');
      const hash = await dk.memberListHash(list);
      const last = seen.find(x => x.list.version === list.version);
      if (last) { if (last.hash !== hash) throw new TeamTrustFailure('team_list_fork'); continue; }
      seen.push({ list, hash, env: e });
    }
    seen.sort((x, y) => x.list.version - y.list.version);
    if (seen.length === 0) throw new TeamTrustFailure('team_list_missing');
    if (seen[0].list.version !== from) throw new TeamTrustFailure('team_list_history_gap');
    if (pin && from === pin.version && seen[0].hash !== pin.hash) throw new TeamTrustFailure('team_list_fork');

    // Walk upward; a list a later one hash-links to may have a signer that was removed since (it is endorsed by the later list).
    const strict: boolean[] = [];
    let lastOk = -1;
    let walkError: unknown = null;
    for (let i = 0; i < seen.length; i++) {
      const { list, env: e } = seen[i];
      if (list.admin_did !== env.ownDid) { walkError = new TeamTrustFailure('team_list_rejected', list.version); break; }
      if (i > 0 && seen[i - 1].list.version !== list.version - 1) { walkError = new TeamTrustFailure('team_list_history_gap'); break; }
      const step = i > 0 ? { prev: seen[i - 1].list } : from === 1 ? { prev: null } : { first: true as const };
      try {
        await dk.verifyMemberList(e, { chain: env.own, ...step, pin, linked: false });
        strict[i] = true;
      } catch (err) {
        const next = seen[i + 1];
        if (!next || next.list.prev !== seen[i].hash) { walkError = err; break; }
        try { await dk.verifyMemberList(e, { chain: env.own, ...step, pin, linked: true }); strict[i] = false; } catch (err2) { walkError = err2; break; }
      }
      lastOk = i;
    }
    if (lastOk < 0) throw walkError ?? new TeamTrustFailure('team_list_missing');
    let accepted = lastOk;
    while (accepted >= 0 && !strict[accepted] && !(pin && seen[accepted].list.version === pin.version && seen[accepted].hash === pin.hash)) accepted--;
    if (accepted < 0) throw walkError ?? new TeamTrustFailure('team_list_rejected', seen[lastOk].list.version);
    const best = seen[accepted];
    dk.checkTeamPin(best.list.version, best.hash, pin);

    if (page.truncated) {
      if (best.list.version <= from) throw new TeamTrustFailure('team_list_history_gap');
      pin = { version: best.list.version, hash: best.hash };
      from = best.list.version;
      continue;
    }
    let rejected: Verified['rejected'] = null;
    if (accepted < lastOk) rejected = { version: seen[accepted + 1].list.version, code: 'NOT_ACTIVE' };
    else if (lastOk + 1 < seen.length) rejected = { version: seen[lastOk + 1].list.version, code: isDeviceKeysError(walkError) ? walkError.code : walkError instanceof TeamTrustFailure ? walkError.code : 'INVALID' };
    const left = await appliedLeaves(env, dk, teamId, page, seen.slice(0, accepted + 1).map(x => x.list), best.list);
    return { adminDid: best.list.admin_did, version: best.list.version, hash: best.hash, members: best.list.members.filter(m => !left.has(m.did)).map(m => ({ did: m.did, name: m.name })), rejected };
  }
  throw new TeamTrustFailure('team_list_history_gap');
}

/** hap-core's and this module's failures, as the code the page shows. */
export function codeOfFailure(e: unknown): TeamTrustCode {
  if (e instanceof TeamTrustFailure) return e.code;
  if (isDeviceKeysError(e)) {
    switch (e.code) {
      case 'ROLLBACK': return 'team_list_rollback';
      case 'FORK': return 'team_list_fork';
      case 'HISTORY_GAP': return 'team_list_history_gap';
      case 'NOT_A_MEMBER': return 'team_not_a_member';
      case 'NO_TRUST': return 'team_list_missing';
      default: return 'team_list_invalid';
    }
  }
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string') {
    // verified chain of the admin (lib/mandate-grants.ts `chainOf`)
    if (code === 'chain_rollback' || code === 'chain_fork' || code === 'chain_invalid' || code === 'head_mismatch') return 'team_admin_chain_invalid';
    if (code === 'chain_unknown') return 'team_admin_chain_invalid';
    if (code.startsWith('as_') || code === 'locked' || code === 'not_signed_in') return 'team_list_unreachable';
  }
  return 'team_list_invalid';
}

// ─── the entry points ─────────────────────────────────────────────────────

/**
 * Fetch and verify the team's list now, and record the outcome: a good result moves the pin and replaces the cache; a refusal records
 * its code (a blocking one also drops the cache). Never throws for a refusal. A person in no team: `{ ok: false, code: 'no_team' }`.
 */
export async function refreshTeamTrust(env: TeamTrustEnv): Promise<RefreshResult> {
  const { store } = env;
  const now = env.now();
  let teamId = '';
  // The team known from the last run: a failure before the team is found again is still recorded against it.
  try { teamId = store.currentTeam() ?? ''; } catch { /* locked: nothing can be recorded, nothing is honoured */ }
  try {
    const dk = await deviceKeys();
    const g = await env.get('/api/groups');
    if (g.status !== 200 || !isObj(g.body) || !Array.isArray(g.body.groups)) throw new TeamTrustFailure('team_list_unreachable');
    const team = g.body.groups.find((x: unknown) => isObj(x) && !x.isPersonal && typeof x.id === 'string');
    if (!team) { store.setCurrentTeam(null); store.clearWarning(); return { ok: false, code: 'no_team' }; }
    teamId = (team as { id: string }).id;
    store.setCurrentTeam(teamId);

    // Which side this person is on is first the Authority Server's word and then CHECKED: an admin's lists must verify against its own
    // chain, a member's against its own anchor. A wrong claim ends in a refusal, never in a colleague.
    // (A `from` above any version asks for the head and the admin only.)
    const head = await env.get(`/api/teams/${encodeURIComponent(teamId)}/trust?from=2147483647&leaves_limit=1`);
    if (head.status === 404) throw new TeamTrustFailure('team_list_missing');
    if (head.status !== 200 || !isObj(head.body)) throw new TeamTrustFailure('team_list_unreachable');
    // A requester view (no `lists`): this person is not an active member of the team.
    if (!Array.isArray(head.body.lists)) throw new TeamTrustFailure('team_not_a_member');
    if (head.body.head === null) throw new TeamTrustFailure('team_list_missing');
    const asAdmin = head.body.admin_did === env.ownDid;
    const v = asAdmin ? await verifyAsAdmin(env, dk, teamId) : await verifyAsMember(env, dk, teamId);

    const team2: VerifiedTeam = { adminDid: v.adminDid, version: v.version, hash: v.hash, members: v.members, verifiedAt: now };
    try { store.accept(teamId, team2, v.anchorPin); } catch (e) {
      if (e instanceof TeamTrustRefused && (e.reason === 'rollback' || e.reason === 'fork')) throw new TeamTrustFailure(e.reason === 'rollback' ? 'team_list_rollback' : 'team_list_fork');
      throw e;
    }
    if (v.rejected) {
      store.warn(teamId, 'team_list_rejected', now, v.rejected.version);
      return { ok: false, code: 'team_list_rejected' };
    }
    return { ok: true, team: team2 };
  } catch (e) {
    const code = codeOfFailure(e);
    if (teamId) { try { store.warn(teamId, code, now, e instanceof TeamTrustFailure ? e.version : undefined); } catch { /* the slot cannot be written (locked): nothing is honoured anyway */ } }
    return { ok: false, code };
  }
}

/**
 * The verified team this gateway honours right now: the last verified state, if no blocking warning stands and it is not older than
 * the grace window. Reads only.
 */
export function honouredTeam(store: TeamTrustStore, now: number): VerifiedTeam | null {
  let v: VerifiedTeam | null;
  try {
    const w = store.warning();
    if (w && BLOCKING_CODES.has(w.code)) return null;
    v = store.verified();
  } catch { return null; }
  return v && now - v.verifiedAt <= TEAM_TRUST_GRACE_SECONDS ? v : null;
}

/** Is the last verification younger than the refresh time and without a warning? Then nothing needs fetching. */
export function teamTrustFresh(store: TeamTrustStore, now: number): boolean {
  try {
    const v = store.verified();
    return !!v && now - v.verifiedAt < TEAM_TRUST_REFRESH_SECONDS && store.warning() === null;
  } catch { return false; }
}

/** A refusal was recorded a moment ago: do not ask the Authority Server again for every question while it stands (the page's own refresh still does). */
function recentlyRefused(store: TeamTrustStore, now: number): boolean {
  try { const w = store.warning(); return !!w && now - w.at < TEAM_TRUST_RETRY_SECONDS; } catch { return false; }
}

/** Fetch again when the last verification is older than the refresh time (or there is none), then say what is honoured. */
export async function ensureTeamTrust(env: TeamTrustEnv): Promise<VerifiedTeam | null> {
  if (!teamTrustFresh(env.store, env.now()) && !recentlyRefused(env.store, env.now())) await refreshTeamTrust(env);
  return honouredTeam(env.store, env.now());
}
