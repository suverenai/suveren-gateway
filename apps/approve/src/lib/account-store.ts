/**
 * The public facts of the paired account, kept in IndexedDB (plan 8, "Keys and storage"; DEC-16: the phone pins its own
 * identity). No secret is in here: no private key (key-store.ts keeps those), no recovery code, no token.
 *
 * The head only moves forward, exactly as on the computer (device-chain-store.ts): a lower head is a rollback, the same
 * number with another hash is a fork. Either is an alarm, never an update.
 */
import type { Kv } from './kv';

const K_ACCOUNT = 'account';
const K_BUILD = 'app.last_build';

export interface HeadRef { seq: number; hash: string }

export interface StoredAccount {
  v: 1;
  /** The Authority Server this account was made on. A chain belongs to one. */
  as_url: string;
  /** Its public key, hex: the pinned `as_key` (plan 4.3 step 2). */
  as_key: string;
  root_did: string;
  /** This phone's key id. */
  key_id: string;
  label: string;
  head: HeadRef;
  /** The phone's own passkey: what `allowCredentials` names when a check is asked. */
  check: { rp_id: string; cred_id: string };
  /** Epoch seconds. */
  paired_at: number;
}

export class HeadRefusedError extends Error {
  constructor(readonly reason: 'rollback' | 'fork') {
    super(reason);
    this.name = 'HeadRefusedError';
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);

function valid(v: unknown): v is StoredAccount {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const h = o.head as Record<string, unknown> | undefined;
  const c = o.check as Record<string, unknown> | undefined;
  return o.v === 1 && typeof o.as_url === 'string' && /^[0-9a-f]{64}$/.test(String(o.as_key)) && typeof o.root_did === 'string'
    && typeof o.key_id === 'string' && typeof o.label === 'string' && !!h && isInt(h.seq) && isHash(h.hash)
    && !!c && typeof c.rp_id === 'string' && typeof c.cred_id === 'string' && isInt(o.paired_at);
}

export class AccountStore {
  constructor(private readonly kv: Kv) {}

  /** The stored account, or null when this phone is not paired. A record that is there but wrong is an error, never "not paired". */
  async read(): Promise<StoredAccount | null> {
    const v = await this.kv.get(K_ACCOUNT);
    if (v === undefined) return null;
    if (!valid(v)) throw new Error('The stored account cannot be read');
    return v;
  }

  async write(a: StoredAccount): Promise<void> {
    if (!valid(a)) throw new Error('not an account');
    if (await this.kv.get(K_ACCOUNT) !== undefined) throw new Error('already paired');
    await this.kv.set(K_ACCOUNT, a);
  }

  /** Move the head forward. Same head: no change. */
  async advance(next: HeadRef): Promise<void> {
    const a = await this.read();
    if (!a) throw new Error('not paired');
    if (next.seq < a.head.seq) throw new HeadRefusedError('rollback');
    if (next.seq === a.head.seq) {
      if (next.hash !== a.head.hash) throw new HeadRefusedError('fork');
      return;
    }
    await this.kv.set(K_ACCOUNT, { ...a, head: { seq: next.seq, hash: next.hash } });
  }

  async clear(): Promise<void> {
    await this.kv.delete(K_ACCOUNT);
  }

  /** "The app was updated" (plan 8): true once, the first time a new build starts after an older one ran. */
  async buildChanged(build: string): Promise<boolean> {
    const last = await this.kv.get<string>(K_BUILD);
    await this.kv.set(K_BUILD, build);
    return last !== undefined && last !== build;
  }
}
