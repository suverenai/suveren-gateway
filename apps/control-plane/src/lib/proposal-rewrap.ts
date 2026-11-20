/**
 * Re-wrap open proposals for a device added later (device-keys plan 5, G11; build step 8, computer part).
 *
 * A proposal's content key was wrapped to the devices a person had when it was filed. A computer or phone added
 * afterwards holds no wrap, so it could not open what is still waiting. Any device of the person that CAN open the
 * content key wraps it once more for each of the person's other active devices (taken from the own chain this
 * gateway verified, never from the Authority Server's word) and hands the wraps to the Authority Server
 * (`POST /api/proposals/:id/wraps`), which accepts them for the caller's own person only and never replaces one.
 *
 * Run: after every device sign-in (the new device is learned from the verified chain) and on request
 * (`POST /internal/rewrap-proposals`). Each run is bounded; one proposal failing never stops the others.
 * Nothing is logged but counts: never a wrap, a key or a proposal's content.
 */
import type { Vault } from './vault';
import type { DeviceAsClient } from './device-as-client';
import type { DeviceReaders } from './device-readers';
import { isBearerCredential } from './as-credential';
import { loadOrGenerateKeyPair } from './e2e-key-manager';
import { openContentKey, sealContentKey, openContentWithKey } from './content-wraps';
import { computeProposalContentHash } from './content-crypto';

const MAX_PROPOSALS_PER_RUN = 100;
const MAX_REMEMBERED = 2000;

export interface RewrapResult {
  /** Open proposals this device could open the content key of. */
  checked: number;
  /** Proposals the Authority Server took at least one new wrap for. */
  rewrapped: number;
  failed: number;
  /** Proposals skipped, with a code: `no_wrap_for_this_device`, `content_key_mismatch`. Ids and codes only. */
  skippedProposals?: Array<{ id: string; code: 'content_key_mismatch' | 'content_unavailable' }>;
  /** Why nothing was done, when the run could not start: a code. */
  skipped?: 'locked' | 'not_signed_in' | 'no_other_device' | 'own_chain_unusable';
}

interface OpenProposal { id: string; status?: string; contentHash?: string; content?: { ciphertext?: string; hash?: string; proposalContentHash?: string; device_keys?: Record<string, { ct: string; enc: string }> } | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ProposalRewrap {
  /** `proposalId:keyId` pairs the Authority Server already holds a wrap for (taken, or it said so). In memory only. */
  private readonly done = new Set<string>();
  private running: Promise<RewrapResult> | null = null;

  constructor(private readonly d: { vault: Vault; client: DeviceAsClient; readers: DeviceReaders; log?: (m: string) => void }) {}

  /** One run at a time; a second caller gets the run in progress. */
  run(): Promise<RewrapResult> {
    return (this.running ??= this.once().finally(() => { this.running = null; }));
  }

  private async list(path: string, credential: string): Promise<OpenProposal[]> {
    try {
      const r = await this.d.client.call('GET', path, { bearer: credential });
      if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.proposals)) return [];
      return r.body.proposals.filter((p): p is OpenProposal => isObj(p) && typeof p.id === 'string');
    } catch {
      return [];
    }
  }

  private async once(): Promise<RewrapResult> {
    const { vault } = this.d;
    const result: RewrapResult = { checked: 0, rewrapped: 0, failed: 0 };
    if (!vault.isUnlocked()) return { ...result, skipped: 'locked' };
    const credential = vault.getSpCookie();
    const me = vault.getSessionUser();
    if (!isBearerCredential(credential) || !me) return { ...result, skipped: 'not_signed_in' };

    const kp = await loadOrGenerateKeyPair(vault);
    let own;
    try { own = await this.d.readers.own(kp.publicKey); } catch { return { ...result, skipped: 'own_chain_unusable' }; }
    const others = own.devices.filter(x => x.keyId !== own.keyId);
    if (others.length === 0) return { ...result, skipped: 'no_other_device' };

    // The proposals this person reads. `readable=me` is the AS's list of open proposals holding a wrap for one of this
    // person's devices: it alone also carries the owner's own proposal that names no creator and no pending domain
    // (review_above_cap with other approvers). The four older lists stay as well, so an AS without it still serves them.
    const lists = await Promise.all([
      this.list('/api/proposals?readable=me', credential),
      this.list('/api/proposals?creator=me', credential),
      this.list('/api/proposals?approver=me', credential),
      this.list('/api/proposals?domain=owner', credential),
      this.list(`/api/proposals?domain=${encodeURIComponent(me.id)}`, credential),
    ]);
    const byId = new Map<string, OpenProposal>();
    for (const p of lists.flat()) if (!byId.has(p.id)) byId.set(p.id, p);

    for (const p of [...byId.values()].slice(0, MAX_PROPOSALS_PER_RUN)) {
      if (p.status !== undefined && p.status !== 'pending' && p.status !== 'committed') continue;
      const ownWrap = p.content?.device_keys?.[own.keyId];
      if (!ownWrap) continue;   // no device wraps on this proposal, or this device holds none: it cannot hand anything on
      const missing = others.filter(x => !this.done.has(`${p.id}:${x.keyId}`));
      if (missing.length === 0) continue;
      result.checked += 1;
      try {
        const cek = await openContentKey(ownWrap, kp.privateKey);
        // The key opened from the AS-served wrap must decrypt THIS proposal's content to its stored fingerprint before it is
        // wrapped for anyone: a wrap the AS swapped for another proposal's must not be passed on.
        const fingerprint = p.content?.proposalContentHash ?? p.content?.hash ?? p.contentHash;
        let genuine = false;
        if (typeof p.content?.ciphertext === 'string' && typeof fingerprint === 'string') {
          try { genuine = computeProposalContentHash(JSON.parse(await openContentWithKey(cek, p.content.ciphertext))) === fingerprint; } catch { genuine = false; }
        } else {
          (result.skippedProposals ??= []).push({ id: p.id, code: 'content_unavailable' });
          cek.fill(0);
          continue;
        }
        if (!genuine) {
          (result.skippedProposals ??= []).push({ id: p.id, code: 'content_key_mismatch' });
          cek.fill(0);
          continue;
        }
        const wraps: Record<string, { ct: string; enc: string }> = {};
        try {
          for (const dev of missing) wraps[dev.keyId] = await sealContentKey(cek, dev.readPub);
        } finally { cek.fill(0); }
        const r = await this.d.client.call('POST', `/api/proposals/${encodeURIComponent(p.id)}/wraps`, { bearer: credential, body: { device_keys: wraps } });
        if (r.status !== 201 || !isObj(r.body)) { result.failed += 1; continue; }
        for (const dev of missing) this.done.add(`${p.id}:${dev.keyId}`);
        if (this.done.size > MAX_REMEMBERED) for (const k of [...this.done].slice(0, this.done.size - MAX_REMEMBERED)) this.done.delete(k);
        if (Array.isArray(r.body.added) && r.body.added.length > 0) result.rewrapped += 1;
      } catch {
        result.failed += 1;
      }
    }
    this.d.log?.(`[Control Plane] proposal re-wrap: ${result.checked} checked, ${result.rewrapped} re-wrapped, ${result.failed} failed`);
    return result;
  }
}
