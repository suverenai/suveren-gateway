/**
 * People with real device chains, real platform-style check keys (P-256) and mandate grants written out by hand, for the
 * tests of the mandate-grant check (device-keys plan 4.4; step 13). Nothing here is the gateway's own code: the members of a
 * grant are listed as the Authority Server lists them (PR #141), the signatures are hap-core's.
 */
import { randomBytes, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import * as dk from '@hap/core/device-keys';

export const now = (): number => Math.floor(Date.now() / 1000);

export interface Person {
  did: string;
  rootSeed: Uint8Array;
  entries: dk.ChainEntry[];
  /** The first device. */
  dev: { keyId: string; priv: Uint8Array };
  /** The first device's check key (a P-256 key standing for the Secure Enclave one), when it has one. */
  check?: KeyObject;
}

/** A platform check: ECDSA P-256 over the 32 digest bytes of a `sha256:` hash, DER. */
export function checkSignature(priv: KeyObject, hash: string): { signature: string } {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  return { signature: cryptoSign('sha256', digest, { key: priv, dsaEncoding: 'der' }).toString('base64url') };
}

export function newCheckKey(): { priv: KeyObject; key: { type: 'platform'; pub: string } } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { priv: privateKey, key: { type: 'platform', pub: pub.toString('base64url') } };
}

export async function person(label = 'Computer', o: { check?: boolean } = {}): Promise<Person> {
  const { seed } = await dk.generateRecoveryCode();
  const root = await dk.deriveRootKey(seed);
  const check = o.check ? newCheckKey() : undefined;
  const priv = randomBytes(32);
  const pub = await dk.ed25519PublicKey(priv);
  const record = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(randomBytes(32)), kind: 'gateway', label, keystore: 'software', ...(check ? { check: check.key } : {}) }, pub);
  const e0 = dk.buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: now(), signer: 'root', device: record });
  e0.sigs.push(await dk.signEntry(e0, 'root', root.privateSeed), await dk.signEntry(e0, record.key_id, new Uint8Array(priv)));
  if (check) e0.checks.push({ by: record.key_id, check: checkSignature(check.priv, await dk.entryHash(e0)) });
  await dk.verifyChain({ expectedRootDid: root.did, entries: [e0] });
  return { did: root.did, rootSeed: root.privateSeed, entries: [e0], dev: { keyId: record.key_id, priv: new Uint8Array(priv) }, ...(check ? { check: check.priv } : {}) };
}

export const headOf = (p: Person) => dk.verifyChain({ expectedRootDid: p.did, entries: p.entries }).then(s => s.head);

/** Add a device (root-signed; a device with a check key proves it with a check over the entry). */
export async function addDevice(p: Person, label: string, o: { check?: boolean } = {}): Promise<{ keyId: string; priv: Uint8Array; check?: KeyObject }> {
  const check = o.check ? newCheckKey() : undefined;
  const priv = randomBytes(32);
  const pub = await dk.ed25519PublicKey(priv);
  const record = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(randomBytes(32)), kind: 'gateway', label, keystore: 'software', ...(check ? { check: check.key } : {}) }, pub);
  const e = dk.buildEntry({ root_did: p.did, seq: p.entries.length, prev: await dk.entryHash(p.entries.at(-1)!), op: 'add', created_at: now(), signer: 'root', device: record });
  e.sigs.push(await dk.signEntry(e, 'root', p.rootSeed), await dk.signEntry(e, record.key_id, new Uint8Array(priv)));
  if (check) e.checks.push({ by: record.key_id, check: checkSignature(check.priv, await dk.entryHash(e)) });
  await dk.verifyChain({ expectedRootDid: p.did, entries: [...p.entries, e] });
  p.entries.push(e);
  return { keyId: record.key_id, priv: new Uint8Array(priv), ...(check ? { check: check.priv } : {}) };
}

/** Remove a device (root-signed). */
export async function removeDevice(p: Person, keyId: string): Promise<void> {
  const e = dk.buildEntry({ root_did: p.did, seq: p.entries.length, prev: await dk.entryHash(p.entries.at(-1)!), op: 'remove', created_at: now(), signer: 'root', target: keyId });
  e.sigs.push(await dk.signEntry(e, 'root', p.rootSeed));
  await dk.verifyChain({ expectedRootDid: p.did, entries: [...p.entries, e] });
  p.entries.push(e);
}

export const blob = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify({ payload, signature: 'sig' })).toString('base64url');

export const MANDATE_ID = 'mandate-grant-1';
export const AUTHZ = 'authz_11111111-1111-1111-1111-111111111111';

/** A v0.8 mandate payload as the Authority Server would sign it. */
export function mandatePayload(owner: Person, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.8', mandate_id: MANDATE_ID, profile_id: 'test-pay@1', profile_hash: `sha256:${'1'.repeat(64)}`, commitment_mode: 'review', issuer: 'did:key:as',
    issued_at: now(), bounds_hash: `sha256:${'2'.repeat(64)}`, scope_hash: `sha256:${'3'.repeat(64)}`, execution_context_hash: `sha256:${'4'.repeat(64)}`,
    gate_content_hashes: { intent: `sha256:${'5'.repeat(64)}` }, expires_at: now() + 3600, mandate_owners: [{ did: owner.did }], ...extra,
  };
}

export interface GrantRow { mandate_version: number; op: string; grant: Record<string, unknown>; sig: string; check: { signature: string } | null }

export interface GrantOpts {
  op?: 'grant' | 'change' | 'revoke';
  version?: number;
  /** Members said differently from the mandate (a grant that says something else). */
  override?: Record<string, unknown>;
  /** `own`: the check over THIS grant; `none`: the device signature alone; `other`: a check over another object. */
  check?: 'own' | 'none' | 'other';
  authorization?: string;
  mandateId?: string;
  /** Sign with this device instead of the owner's first. */
  signer?: { keyId: string; priv: Uint8Array; check?: KeyObject };
  ownerDid?: string;
  head?: { seq: number; hash: string };
}

/** The owner's grant for a mandate payload, members by hand (the Authority Server's list). */
export async function grantFor(owner: Person, payload: Record<string, unknown>, o: GrantOpts = {}): Promise<GrantRow> {
  const head = o.head ?? await headOf(owner);
  const approvers = (payload.above_cap_approvers as string[] | undefined) ?? null;
  const members = {
    version: payload.version, profile_id: payload.profile_id, profile_hash: payload.profile_hash, bounds_hash: payload.bounds_hash, scope_hash: payload.scope_hash,
    execution_context_hash: payload.execution_context_hash, gate_content_hashes: payload.gate_content_hashes, commitment_mode: payload.commitment_mode,
    expires_at: payload.expires_at, intent_disclosure_hash: payload.intent_disclosure_hash ?? null, above_cap_caps: payload.above_cap_caps ?? null,
    above_cap_approvers: approvers, above_cap_approvals: payload.above_cap_approvals ?? null, disclose_fields: null, subjects_disclosed: false,
    authorization_id: o.authorization ?? AUTHZ, group_id: 'g1', replaces: null, chain_dids: [owner.did, ...(approvers ?? [])].sort(), ...o.override,
  };
  const signer: { keyId: string; priv: Uint8Array; check?: KeyObject } = o.signer ?? owner.dev;
  const grant = dk.buildGrant({
    op: o.op ?? 'grant', owner_did: o.ownerDid ?? owner.did, key_id: signer.keyId, chain_seq: head.seq, chain_head: head.hash,
    mandate_id: o.mandateId ?? (payload.mandate_id as string), mandate_version: o.version ?? 1, granted_at: now(), nonce: dk.b64uEncode(randomBytes(16)),
  }, members) as unknown as Record<string, unknown>;
  const sig = await dk.signObject(grant as never, signer.priv);
  const mode = o.check ?? (o.op === 'revoke' ? 'none' : 'own');
  const check = mode === 'none' ? null : checkSignature(signer.check ?? owner.check!, mode === 'own' ? await dk.objectHash(grant as never) : `sha256:${'0'.repeat(64)}`);
  return { mandate_version: grant.mandate_version as number, op: grant.op as string, grant, sig, check };
}
