/**
 * Reading proposals from the Authority Server with the phone's session (plan 8, "Showing a proposal"; stage D1 is read-only).
 *
 * A phone session may read proposals and, in D2, decide them; nothing else (suveren-as `approveAppMayCall`). Two lists make
 * what waits for this person: the proposals pending for their own domain (in a Personal account the domain is the account
 * id) and the ones awaiting their approval (`approver=me`). A list that the person asked for counts as use of the session
 * (plan 6.2: only requests made on a person's action do); a refresh by timer never does.
 *
 * Nothing read here is stored: the list lives in memory, and decrypted content is opened on demand (content.ts).
 */
import type { Proposal } from '@suveren/approval-card/types';
import type { AsApi } from './as-api';
import type { DeviceSession } from './session';

export type ReadResult<T> = { ok: true; data: T } | { ok: false; code: 'session_ended' | 'as_unreachable' | 'as_error' | 'refused' };

export class ProposalReader {
  constructor(
    private readonly api: AsApi,
    private readonly session: DeviceSession,
    /** The account id: the Personal domain. */
    private readonly userId: () => string,
  ) {}

  private bearer(byPerson: boolean): string | null {
    const b = this.session.bearer();
    if (b && byPerson) this.session.noteUse();
    return b;
  }

  /** The proposals waiting for this person, newest first. */
  async list(byPerson: boolean): Promise<ReadResult<Proposal[]>> {
    const bearer = this.bearer(byPerson);
    if (!bearer) return { ok: false, code: 'session_ended' };
    const [own, approver] = await Promise.all([this.api.listPending(this.userId(), bearer), this.api.listForApprover(bearer)]);
    for (const r of [own, approver]) {
      if (!r.ok) {
        if (r.status === 401 || r.code === 'SESSION_EXPIRED') { this.session.lost(); return { ok: false, code: 'session_ended' }; }
        // An approver list refused for reconfirmation is not "nothing waiting": say so.
        return { ok: false, code: r.status === 0 ? 'as_unreachable' : r.status >= 500 ? 'as_error' : 'refused' };
      }
    }
    const seen = new Map<string, Proposal>();
    for (const r of [own, approver]) {
      if (!r.ok) continue;
      for (const p of r.data.proposals) {
        const prop = p as Proposal;
        if (prop && typeof prop.id === 'string' && !seen.has(prop.id)) seen.set(prop.id, prop);
      }
    }
    return { ok: true, data: [...seen.values()].sort((a, b) => b.createdAt - a.createdAt) };
  }

  /** One proposal, fresh (the card reads it again before it shows). */
  async get(id: string, byPerson = true): Promise<ReadResult<Proposal>> {
    const bearer = this.bearer(byPerson);
    if (!bearer) return { ok: false, code: 'session_ended' };
    const r = await this.api.proposal(id, bearer);
    if (!r.ok) {
      if (r.status === 401 || r.code === 'SESSION_EXPIRED') { this.session.lost(); return { ok: false, code: 'session_ended' }; }
      return { ok: false, code: r.status === 0 ? 'as_unreachable' : r.status >= 500 ? 'as_error' : 'refused' };
    }
    const p = (r.data as { proposal?: Proposal }).proposal;
    if (!p || typeof p.id !== 'string') return { ok: false, code: 'as_error' };
    return { ok: true, data: p };
  }
}
