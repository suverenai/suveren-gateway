/**
 * What this gateway remembers about its team's signed member list (DEC-73, design 20.21.6; build step 3).
 *
 *   - per team the pin: the highest `(version, hash)` of the list it VERIFIED, and the pin of the person's own anchor line.
 *     A lower version is a rollback, the same version with another hash is a fork: refused, never believed. The Authority
 *     Server cannot lower a pin.
 *   - a cache of the verified result (the member set at that version and the admin's DID) with the time it was verified,
 *     so the synchronous questions ("is this DID a colleague?") need no fetch.
 *   - the warning state: why this gateway honours no colleague right now (a code the page can show; wording is not here).
 *
 * Sealed in a vault slot next to `devicePins`, so the AI cannot rewrite it while the gateway is locked. It holds no key and no
 * mandate content: team id, version numbers, hashes, DIDs and the member names exactly as the admin signed them (labels).
 * It checks nothing about a list itself: the caller verifies with hap-core first (lib/team-trust.ts) and then records here.
 */

import type { Vault } from './vault';

const SLOT = 'teamTrust';
/** A person is in at most one team; a few more entries only remember pins of teams they left (a pin is never dropped for a team they may re-join). */
const MAX_TEAMS = 16;
const MAX_MEMBERS = 500;

export interface TeamPinRef { version: number; hash: string }
export interface TeamMemberRef { did: string; name: string }

/** The last verified state of one team. */
export interface VerifiedTeam {
  adminDid: string;
  version: number;
  hash: string;
  /** Members at `version`, minus those whose own `leave` was applied; includes the admin. */
  members: TeamMemberRef[];
  /** Epoch seconds of the verification that produced this. */
  verifiedAt: number;
}

/**
 * Why no colleague is honoured. A neutral code: the page maps it to words (wording is the maintainer's).
 * The blocking ones (see BLOCKING_CODES) stop everything at once; the others leave the last verified state in force for the grace window.
 */
export type TeamTrustCode =
  | 'team_list_rollback' | 'team_list_fork' | 'team_list_history_gap' | 'team_list_rejected'
  | 'team_list_invalid' | 'team_list_unreachable' | 'team_list_missing' | 'team_anchor_missing' | 'team_anchor_invalid'
  | 'team_admin_chain_invalid' | 'team_not_a_member';

/** The codes that stop honouring colleagues immediately: the design's ROLLBACK / FORK / HISTORY_GAP / refused newer version, an admin chain that does not verify, and "this person is no member". */
export const BLOCKING_CODES: ReadonlySet<TeamTrustCode> = new Set<TeamTrustCode>(['team_list_rollback', 'team_list_fork', 'team_list_history_gap', 'team_list_rejected', 'team_admin_chain_invalid', 'team_not_a_member']);

export interface TeamWarning { code: TeamTrustCode; teamId: string; at: number; version?: number }

interface TeamEntry { pin: TeamPinRef; anchorPin?: TeamPinRef; verified?: VerifiedTeam; at: number }
interface File { v: 1; teams: Record<string, TeamEntry>; /** The team this person is in now (null: none known). */ current: string | null; warning?: TeamWarning | null }

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);
const isDid = (d: unknown): d is string => typeof d === 'string' && d.startsWith('did:key:') && d.length <= 128;
const isTeamId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
const isPin = (p: unknown): p is TeamPinRef => !!p && typeof p === 'object' && isInt((p as TeamPinRef).version) && isHash((p as TeamPinRef).hash);

export class TeamTrustRefused extends Error {
  constructor(readonly reason: 'rollback' | 'fork' | 'bad_request') {
    super(reason);
    this.name = 'TeamTrustRefused';
  }
}

export class TeamTrustStore {
  constructor(private readonly vault: Vault) {}

  private read(): File {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return { v: 1, teams: {}, current: null };
    const f = v as Partial<File>;
    if (f?.v !== 1 || !f.teams || typeof f.teams !== 'object' || (f.current !== null && !isTeamId(f.current))) throw new Error('The stored team trust cannot be read');
    for (const [id, e] of Object.entries(f.teams)) {
      const ok = isTeamId(id) && isPin(e?.pin) && (e.anchorPin === undefined || isPin(e.anchorPin))
        && (e.verified === undefined || (isDid(e.verified.adminDid) && isInt(e.verified.version) && isHash(e.verified.hash) && Array.isArray(e.verified.members)
          && e.verified.members.length <= MAX_MEMBERS && e.verified.members.every(m => isDid(m?.did) && typeof m?.name === 'string') && typeof e.verified.verifiedAt === 'number'));
      if (!ok) throw new Error('The stored team trust cannot be read');
    }
    return f as File;
  }

  private write(f: File): void { this.vault.setSecretSlot(SLOT, f); }

  /** The team this person is in, as last discovered; null when none. Throws while locked or on a slot it cannot read. */
  currentTeam(): string | null { return this.read().current; }

  /** The person's team changed (or is none): the verified cache of the old one stops counting; its pin stays. */
  setCurrentTeam(teamId: string | null): void {
    if (teamId !== null && !isTeamId(teamId)) throw new TeamTrustRefused('bad_request');
    const f = this.read();
    if (f.current === teamId) return;
    f.current = teamId;
    if (f.warning && f.warning.teamId !== teamId) f.warning = null;
    this.write(f);
  }

  pin(teamId: string): TeamPinRef | null {
    if (!isTeamId(teamId)) throw new TeamTrustRefused('bad_request');
    const p = this.read().teams[teamId]?.pin;
    return p ? { version: p.version, hash: p.hash } : null;
  }

  anchorPin(teamId: string): TeamPinRef | null {
    if (!isTeamId(teamId)) throw new TeamTrustRefused('bad_request');
    const p = this.read().teams[teamId]?.anchorPin;
    return p ? { version: p.version, hash: p.hash } : null;
  }

  /** The last verified state of the CURRENT team, or null. It is not judged for age or warning here (see {@link colleagues}). */
  verified(): VerifiedTeam | null {
    const f = this.read();
    return f.current ? f.teams[f.current]?.verified ?? null : null;
  }

  warning(): TeamWarning | null { return this.read().warning ?? null; }

  /**
   * A list was verified by the caller: move the pin forward and keep the result. Lower than the pin is a rollback; the same version with
   * another hash is a fork (nothing is written). `anchorPin` moves the same way. A good result clears the warning.
   */
  accept(teamId: string, v: VerifiedTeam, anchorPin?: TeamPinRef): void {
    if (!isTeamId(teamId) || !isDid(v.adminDid) || !isInt(v.version) || !isHash(v.hash) || v.members.length > MAX_MEMBERS || !v.members.every(m => isDid(m.did) && typeof m.name === 'string')) throw new TeamTrustRefused('bad_request');
    if (anchorPin !== undefined && !isPin(anchorPin)) throw new TeamTrustRefused('bad_request');
    const f = this.read();
    const cur = f.teams[teamId];
    if (cur) {
      if (v.version < cur.pin.version) throw new TeamTrustRefused('rollback');
      if (v.version === cur.pin.version && v.hash !== cur.pin.hash) throw new TeamTrustRefused('fork');
      const a = cur.anchorPin;
      if (a && anchorPin) {
        if (anchorPin.version < a.version) throw new TeamTrustRefused('rollback');
        if (anchorPin.version === a.version && anchorPin.hash !== a.hash) throw new TeamTrustRefused('fork');
      }
    } else if (Object.keys(f.teams).length >= MAX_TEAMS) {
      const victim = Object.entries(f.teams).filter(([id]) => id !== f.current).sort((x, y) => x[1].at - y[1].at)[0];
      if (victim) delete f.teams[victim[0]];
    }
    f.teams[teamId] = {
      pin: { version: v.version, hash: v.hash },
      ...(anchorPin ?? cur?.anchorPin ? { anchorPin: anchorPin ?? cur!.anchorPin } : {}),
      verified: { adminDid: v.adminDid, version: v.version, hash: v.hash, members: v.members.map(m => ({ did: m.did, name: m.name })), verifiedAt: v.verifiedAt },
      at: v.verifiedAt,
    };
    f.current = teamId;
    f.warning = null;
    this.write(f);
  }

  /** Record why no colleague is honoured. A blocking code also drops the verified cache: nothing stays honoured. */
  warn(teamId: string, code: TeamTrustCode, at: number, version?: number): void {
    if (!isTeamId(teamId)) throw new TeamTrustRefused('bad_request');
    const f = this.read();
    f.warning = { code, teamId, at, ...(version !== undefined ? { version } : {}) };
    if (BLOCKING_CODES.has(code) && f.teams[teamId]) delete f.teams[teamId].verified;
    this.write(f);
  }

  clearWarning(): void {
    const f = this.read();
    if (!f.warning) return;
    f.warning = null;
    this.write(f);
  }

  /** The DIDs this gateway may honour as colleagues now: the verified members of the current team, unless a blocking warning stands. Empty without a verified list. */
  colleagues(): string[] {
    const f = this.read();
    if (f.warning && BLOCKING_CODES.has(f.warning.code)) return [];
    const v = f.current ? f.teams[f.current]?.verified : undefined;
    return v ? v.members.map(m => m.did) : [];
  }
}
