/**
 * Who is who in a report — one place that turns an owner DID or an approver's
 * account id into the best name the LOCAL archive can vouch for (review of a
 * real export, 2026-10-06: an approval read "approved … by c7246947-…", and
 * one ticket's mandate showed "Andreas Schadauer" while another showed
 * "Owner (key …246947)" for the same person; since RR3 an undisclosed owner
 * reads "Owner (name not disclosed)").
 *
 * Why the two disagreed: a name is only ever disclosed inside a signed
 * attestation (`subjects[].disclose.name`, at `assurance: "high"`), and the
 * mandate card read ONLY the attestation of that ticket's own mandate. A
 * second mandate the same person signed with disclosure off had no name, so
 * it fell back to the key. This directory collects names from EVERY archived
 * attestation whose signature verifies, so the same DID always gets the same,
 * best available label.
 *
 * Linking an approver to a DID uses only signed data too: an archived
 * proposal's `committedBy` is keyed by the domain the approver acted for, and
 * each attestation's signed `resolved_domains` maps that domain to its owner
 * DID (in team mode the domain IS the approver's account id). No name is
 * guessed from an account id; with no verified link the approver is shown as
 * "a person (name not disclosed)" — never an id, nor part of one.
 */
import { decodeAttestationBlob, verifyAttestationSignature } from '@hap/core';
import type { ReceiptArchiveReader } from './types';
import { formatOwnerLabel } from './format';

export interface IdentityDirectory {
  /** did -> disclosed name (high assurance, from a verified attestation). */
  names: Map<string, string>;
  /** domain (or account id in team mode) -> owner did. */
  domainDids: Map<string, string>;
}

const cache = new WeakMap<object, { key: string; dir: Promise<IdentityDirectory> }>();

function cacheKey(archive: ReceiptArchiveReader): string {
  const auths = archive.getAuthorizations();
  return `${auths.length}:${auths.map(a => `${a.authorizationId}/${a.attestations.length}`).join(',')}:${archive.getReceipts().length}`;
}

async function build(archive: ReceiptArchiveReader): Promise<IdentityDirectory> {
  const names = new Map<string, string>();
  const domainDids = new Map<string, string>();
  const receipts = archive.getReceipts();
  for (const auth of archive.getAuthorizations()) {
    // Verify against the AS key archived with a ticket of THIS mandate — the
    // same key resolveMandateElement uses; no ticket, no trusted key, skip.
    const key = receipts.find(r => r.authorizationId === auth.authorizationId && r.asPublicKey)?.asPublicKey;
    if (!key) continue;
    for (const att of auth.attestations) {
      try {
        const attestation = decodeAttestationBlob(att.blob);
        await verifyAttestationSignature(attestation, key);
        for (const s of attestation.payload.subjects ?? []) {
          if (s.assurance === 'high' && s.disclose?.name && !names.has(s.did)) names.set(s.did, s.disclose.name);
        }
        for (const rd of attestation.payload.resolved_domains ?? []) {
          if (rd?.domain && rd?.did && !domainDids.has(rd.domain)) domainDids.set(rd.domain, rd.did);
        }
      } catch {
        // Unverifiable blob — contributes nothing; never a name from unsigned data.
      }
    }
  }
  return { names, domainDids };
}

export function getIdentityDirectory(archive: ReceiptArchiveReader): Promise<IdentityDirectory> {
  const key = cacheKey(archive);
  const hit = cache.get(archive);
  if (hit && hit.key === key) return hit.dir;
  const dir = build(archive);
  cache.set(archive, { key, dir });
  return dir;
}

/** The owner label for a DID: its disclosed name if ANY verified archived
 *  attestation carries one, else the truncated-key label. */
export function ownerLabel(dir: IdentityDirectory, did: string): string {
  return dir.names.get(did) ?? formatOwnerLabel(did);
}

/** The approver label when no name was disclosed — neutral, never an id or
 *  part of one (RR3, 2026-10-06: the report AI and the reader see a name only
 *  when that person disclosed it). */
export const UNDISCLOSED_APPROVER_LABEL = 'a person (name not disclosed)';

/** The approver label for one `committedBy` entry. */
export function approverLabel(dir: IdentityDirectory, domainKey: string, userId: string): string {
  const did = dir.domainDids.get(domainKey) ?? dir.domainDids.get(userId);
  const name = did ? dir.names.get(did) : undefined;
  if (name) return name;
  return UNDISCLOSED_APPROVER_LABEL;
}
