/**
 * What this gateway remembers about mandate grants (device-keys plan 4.4 "Versions", "Receipt"; step 13).
 *
 *   - the highest `mandate_version` it VERIFIED per mandate, and whether a revoke was seen: a lower
 *     version is refused, a revoked mandate stays revoked. The MCP server verifies a grant with hap-core
 *     and then asks to record it here; this store checks nothing about the grant itself.
 *   - whether this computer already answered a version with its receipt (a receipt is sent once: the
 *     Authority Server does not replace one).
 *   - the approver DIDs the person compared (the identity code) and accepted, so the code is shown
 *     once per DID (plan 4.4 "Where it is made").
 *
 * Sealed in a vault slot, so the AI cannot rewrite it while the gateway is locked. It holds no key and
 * no mandate content: ids, version numbers, a hash and DIDs.
 */

import type { Vault } from './vault';

const SLOT = 'mandateGrants';
/** More than this many mandates is not a person's; the oldest go first. */
const MAX_MANDATES = 2000;
const MAX_APPROVERS = 512;

interface Entry { version: number; grantHash: string; revoked: boolean; receipted: number[]; at: number }
interface File { v: 1; mandates: Record<string, Entry>; approvers: string[] }

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const isDid = (d: unknown): d is string => typeof d === 'string' && d.startsWith('did:key:') && d.length <= 128;

export class GrantStoreRefused extends Error {
  constructor(readonly reason: 'lower_version' | 'same_version_other_grant' | 'revoked' | 'bad_request') {
    super(reason);
    this.name = 'GrantStoreRefused';
  }
}

export class MandateGrantStore {
  constructor(private readonly vault: Vault) {}

  private read(): File {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return { v: 1, mandates: {}, approvers: [] };
    const f = v as Partial<File>;
    if (f?.v !== 1 || !f.mandates || typeof f.mandates !== 'object' || !Array.isArray(f.approvers)) throw new Error('The stored mandate grants cannot be read');
    for (const [id, e] of Object.entries(f.mandates)) {
      if (!isId(id) || !isInt(e?.version) || !isHash(e?.grantHash) || typeof e?.revoked !== 'boolean' || !Array.isArray(e?.receipted)) throw new Error('The stored mandate grants cannot be read');
    }
    return f as File;
  }

  /** The highest verified version of a mandate, or null when none was. Throws while locked or on a slot it cannot read. */
  get(mandateId: string): { version: number; grantHash: string; revoked: boolean } | null {
    if (!isId(mandateId)) throw new GrantStoreRefused('bad_request');
    const e = this.read().mandates[mandateId];
    return e ? { version: e.version, grantHash: e.grantHash, revoked: e.revoked } : null;
  }

  /**
   * A grant of this version was verified. A lower version than the highest seen is refused; the same version
   * must be the same grant; after a revoke nothing is accepted again.
   */
  observe(mandateId: string, version: number, grantHash: string, op: 'grant' | 'change' | 'revoke'): { receiptNeeded: boolean } {
    if (!isId(mandateId) || !isInt(version) || !isHash(grantHash) || (op !== 'grant' && op !== 'change' && op !== 'revoke')) throw new GrantStoreRefused('bad_request');
    const f = this.read();
    const cur = f.mandates[mandateId];
    if (cur?.revoked) {
      if (op === 'revoke' && version === cur.version) return { receiptNeeded: false };
      throw new GrantStoreRefused('revoked');
    }
    if (cur) {
      if (op !== 'revoke' && version < cur.version) throw new GrantStoreRefused('lower_version');
      if (version === cur.version && op !== 'revoke' && grantHash !== cur.grantHash) throw new GrantStoreRefused('same_version_other_grant');
      if (op === 'revoke' && version < cur.version) throw new GrantStoreRefused('lower_version');
    } else if (Object.keys(f.mandates).length >= MAX_MANDATES) {
      const oldest = Object.entries(f.mandates).filter(([, e]) => !e.revoked).sort((a, b) => a[1].at - b[1].at)[0] ?? Object.entries(f.mandates).sort((a, b) => a[1].at - b[1].at)[0];
      delete f.mandates[oldest[0]];
    }
    const higher = !cur || version >= cur.version;
    f.mandates[mandateId] = {
      version: higher ? version : cur.version,
      grantHash: higher ? grantHash : cur.grantHash,
      revoked: op === 'revoke',
      receipted: cur?.receipted ?? [],
      at: Math.floor(Date.now() / 1000),
    };
    this.vault.setSecretSlot(SLOT, f);
    return { receiptNeeded: op !== 'revoke' && !f.mandates[mandateId].receipted.includes(version) };
  }

  /** This computer answered `version` with its receipt. */
  markReceipted(mandateId: string, version: number): void {
    if (!isId(mandateId) || !isInt(version)) throw new GrantStoreRefused('bad_request');
    const f = this.read();
    const e = f.mandates[mandateId];
    if (!e) throw new GrantStoreRefused('bad_request');
    if (!e.receipted.includes(version)) e.receipted.push(version);
    this.vault.setSecretSlot(SLOT, f);
  }

  isReceipted(mandateId: string, version: number): boolean {
    return this.read().mandates[mandateId]?.receipted.includes(version) === true;
  }

  /** Has the person already compared this approver's identity code and accepted it? */
  approverConfirmed(did: string): boolean {
    return isDid(did) && this.read().approvers.includes(did);
  }

  confirmApprovers(dids: readonly string[]): void {
    if (!dids.every(isDid)) throw new GrantStoreRefused('bad_request');
    const f = this.read();
    for (const d of dids) if (!f.approvers.includes(d)) f.approvers.push(d);
    if (f.approvers.length > MAX_APPROVERS) f.approvers = f.approvers.slice(-MAX_APPROVERS);
    this.vault.setSecretSlot(SLOT, f);
  }
}
