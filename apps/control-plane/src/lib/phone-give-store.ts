/**
 * Gives waiting on the person's phone (device-keys plan 4.4 "Transport", DEC-86), kept across a restart of the gateway.
 *
 * Sealed in a vault slot like the other pending state of this gateway (mandate-grant-store.ts): the AI cannot read or rewrite it, and
 * nothing is written to a plain file. A record holds what the ceremony needs to request the mandate once the phone's grant is here: the
 * planned grant members and the request, the person's request and the plan it was checked against (the mandate's own content, as the
 * gateway holds it anyway for its gates). No key, no session, no credential.
 *
 * At most {@link MAX_WAITING} gives wait; each for {@link PHONE_GIVE_TTL_S}. An unreadable slot is not "nothing waits": it throws.
 */
import type { Vault } from './vault';

const SLOT = 'phoneGives';
export const PHONE_GIVE_TTL_S = 30 * 60;
export const MAX_WAITING = 20;
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

export interface PhoneGiveRecord {
  /** Epoch seconds. */
  startedAt: number;
  /** The give as `sendToPhone` planned it (PhoneGive) and the ceremony's context (no functions): stored and handed back as they were. */
  give: Record<string, unknown>;
  ctx: Record<string, unknown>;
  /** The approved AI proposal this give carries out (setup__create_mandate / setup__change_mandate), when it came from one. */
  proposalId?: string;
}

interface File { v: 1; gives: Record<string, PhoneGiveRecord> }

export class PhoneGiveStore {
  constructor(private readonly vault: Vault, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private read(): File {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return { v: 1, gives: {} };
    const f = v as Partial<File>;
    if (f?.v !== 1 || !f.gives || typeof f.gives !== 'object') throw new Error('The waiting gives cannot be read');
    for (const [id, r] of Object.entries(f.gives)) {
      if (!isId(id) || typeof r?.startedAt !== 'number' || typeof r.give !== 'object' || typeof r.ctx !== 'object'
      || (r.proposalId !== undefined && typeof r.proposalId !== 'string')) throw new Error('The waiting gives cannot be read');
    }
    return f as File;
  }

  private live(f: File): File {
    const now = this.now();
    for (const [id, r] of Object.entries(f.gives)) if (now - r.startedAt > PHONE_GIVE_TTL_S) delete f.gives[id];
    return f;
  }

  /** Keep a give that now waits on the phone. The oldest goes when too many wait. */
  hold(mandateId: string, record: Omit<PhoneGiveRecord, 'startedAt'>): void {
    if (!isId(mandateId)) throw new Error('bad mandate id');
    const f = this.live(this.read());
    f.gives[mandateId] = { startedAt: this.now(), give: record.give, ctx: record.ctx, ...(record.proposalId ? { proposalId: record.proposalId } : {}) };
    const ids = Object.keys(f.gives).sort((a, b) => f.gives[a].startedAt - f.gives[b].startedAt);
    while (ids.length > MAX_WAITING) delete f.gives[ids.shift()!];
    this.vault.setSecretSlot(SLOT, f);
  }

  /** The give waiting under this id, or null (none, or its time is over). */
  get(mandateId: string): PhoneGiveRecord | null {
    if (!isId(mandateId)) return null;
    return this.live(this.read()).gives[mandateId] ?? null;
  }

  /** Every give still waiting (ids, oldest first): what the background completion goes through. */
  list(): Array<{ mandateId: string; startedAt: number; proposalId?: string }> {
    const f = this.live(this.read());
    return Object.entries(f.gives)
      .map(([mandateId, r]) => ({ mandateId, startedAt: r.startedAt, ...(r.proposalId ? { proposalId: r.proposalId } : {}) }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The give waiting for this AI proposal (setup__create_mandate / setup__change_mandate), or null. */
  byProposal(proposalId: string): { mandateId: string; record: PhoneGiveRecord } | null {
    if (!isId(proposalId)) return null;
    const f = this.live(this.read());
    for (const [mandateId, r] of Object.entries(f.gives)) if (r.proposalId === proposalId) return { mandateId, record: r };
    return null;
  }

  /** Stop waiting for it. True when one was waiting. */
  drop(mandateId: string): boolean {
    if (!isId(mandateId)) return false;
    const f = this.live(this.read());
    const had = mandateId in f.gives;
    delete f.gives[mandateId];
    this.vault.setSecretSlot(SLOT, f);
    return had;
  }
}
