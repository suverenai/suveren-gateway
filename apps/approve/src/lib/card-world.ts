/**
 * A test world for the checks and the decisions of stage D2: a registered phone with an open session, a signed mandate the fake server
 * holds, its profile, and one waiting request whose content and card context are sealed for THIS phone's reading key, the way the
 * gateway seals them (plan 5). Real keys, real signatures, real hashes; only the network is fake.
 */
import { encryptProposalContent, computeProfileHash, buildMandateProjection, type AgentProfile, type MandatePayload } from '@hap/core';
import { b64uEncode, buildGrant, concat, hexDecode, hkdfSha256, objectHash, randomBytes, signedBytes, utf8 } from '@hap/core/device-keys';
import { createGrantMembers } from '@hap/core/mandate-grant';
import { FakeAs, registerPhone, testRuntime, type TestRuntime } from './test-kit';
import { CONTEXT_INFO } from './content';
import { didKeyOf } from './mandate-check';

export const PROFILE_ID = 'test/purchase@0.1';
export const AUTHZ = 'authz_00000000-0000-4000-8000-000000000001';
export const PROPOSAL_ID = 'prop-1';
export const MANDATE_ID = 'mandate-0001';

export const PROFILE = {
  id: PROFILE_ID,
  boundsSchema: {
    fields: { amount_max: { boundType: { kind: 'per_transaction', of: 'amount' } } },
    actionTypes: ['send'],
  },
  executionContextSchema: { fields: { amount: { source: 'declared', constraint: { type: 'number' } } } },
} as unknown as AgentProfile;

export const ARGS = { to: ['anna@example.com', 'ben@example.com'], amount: '12.50', currency: 'EUR', body: 'Hello Anna' };
export const MAPPING = { amount: 'amount', to: { field: 'recipients', transform: 'length' } };
export const DISPLAY = { labels: { amount: 'Amount', to: 'Recipients' }, order: ['to', 'amount'], money: ['amount'], currencyField: 'currency', aiText: 'body' };

export interface WorldOptions {
  args?: Record<string, unknown>;
  mapping?: unknown;
  /** What the request carries as its execution context (the server's copy). */
  executionContext?: Record<string, unknown>;
  display?: unknown;
  /** Omit the card context altogether. */
  noContext?: boolean;
  actionType?: string | null;
  profile?: unknown;
  mandate?: Record<string, unknown>;
  /** Plain `toolArgs` the (hostile) server serves BESIDE the sealed content. */
  servedToolArgs?: Record<string, unknown>;
  ownerDid?: string;
  pendingApprovers?: string[];
  pendingDomains?: string[];
  /** The owner's grant: `none` serves no grant; `over` changes members AFTER the members were rebuilt (a grant of another mandate). */
  grant?: { none?: true; op?: 'grant' | 'change'; over?: Record<string, unknown>; revoke?: true; noCheck?: true; authorizationId?: string; signWith?: 'other' };
}

const { grantMembersOf } = createGrantMembers(buildMandateProjection);

/**
 * The owner's grant of the mandate, signed by THIS phone with its check, the way a granting device signs it (plan 4.4): the members are
 * the mandate's projection plus where it lives, rebuilt with the gateway's own `createGrantMembers`.
 */
export async function signGrant(rt: TestRuntime, payload: MandatePayload, o: NonNullable<WorldOptions['grant']> = {}, version = 1) {
  const account = (await rt.accounts.read())!;
  const open = rt.session.current()!;
  const members = grantMembersOf(payload, { authorizationId: o.authorizationId ?? AUTHZ, groupId: 'personal-user-1', replaces: null, chainDids: [account.root_did] });
  const op = o.revoke ? 'revoke' : (o.op ?? 'grant');
  const grant = buildGrant({
    op, owner_did: account.root_did, key_id: account.key_id, chain_seq: open.chain.head.seq, chain_head: open.chain.head.hash,
    mandate_id: payload.mandate_id, mandate_version: version, granted_at: rt.now(), nonce: b64uEncode(randomBytes(16)),
  }, { ...members, ...(o.over ?? {}) });
  const signer = o.signWith === 'other' ? (bytes: Uint8Array) => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']).then((k) => crypto.subtle.sign({ name: 'Ed25519' }, (k as CryptoKeyPair).privateKey, new Uint8Array(bytes))).then((b) => new Uint8Array(b)) : (bytes: Uint8Array) => rt.keys.sign(bytes);
  const sig = b64uEncode(await signer(signedBytes(grant)));
  const check = o.noCheck || op === 'revoke' ? null : await rt.check.prove(account.check!.cred_id, await objectHash(grant));
  return { mandate_version: version, op, grant, sig, check };
}

/** Seal the content for `readPub` (hap-core's own encryption) and the card context under the key derived from the content key. */
async function seal(rt: TestRuntime, args: Record<string, unknown>, context: object | null, keyId: string, readPub: Uint8Array) {
  const { content, proposalContentHash } = await encryptProposalContent(args, [{ did: 'did:key:z6Mkreader', publicKey: readPub }]);
  const wrap = content.encrypted_keys['did:key:z6Mkreader'];
  let sealedContext: string | undefined;
  if (context) {
    const cek = await rt.keys.openContentKey(wrap);
    const ctxKey = await hkdfSha256(cek, '', CONTEXT_INFO, 32);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(ctxKey), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = concat(utf8('context'), Uint8Array.of(0), utf8(proposalContentHash));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) }, key, new Uint8Array(utf8(JSON.stringify(context)))));
    sealedContext = b64uEncode(concat(iv, ct));
  }
  return { ciphertext: content.ciphertext, device_keys: { [keyId]: wrap }, ...(sealedContext ? { context: sealedContext } : {}), proposalContentHash, hash: proposalContentHash };
}

export async function cardWorld(o: WorldOptions = {}) {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  await registerPhone(rt, as);
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('the session did not open');
  const account = (await rt.accounts.read())!;
  const keys = (await rt.keys.publicKeys())!;
  const args = o.args ?? ARGS;

  const profile = o.profile ?? PROFILE;
  as.profiles.set(PROFILE_ID, profile);
  const payload = {
    mandate_id: MANDATE_ID, version: '0.8', profile_id: PROFILE_ID, profile_hash: computeProfileHash(profile as never), bounds_hash: 'sha256:' + 'a'.repeat(64),
    scope_hash: 'sha256:' + 'b'.repeat(64), execution_context_hash: 'sha256:' + 'c'.repeat(64), issuer: didKeyOf(hexDecode(as.keyHex)),
    mandate_owners: [{ did: o.ownerDid ?? account.root_did }], gate_content_hashes: {}, commitment_mode: 'review',
    issued_at: as.now() - 3600, expires_at: as.now() + 86400, ...(o.mandate ?? {}),
  };
  as.mandates.set(AUTHZ, { blobs: [await as.mandateBlob(payload)] });
  if (!o.grant?.none) as.grants.set(MANDATE_ID, [await signGrant(rt, payload as unknown as MandatePayload, o.grant ?? {})]);
  as.mandateOf.set(PROPOSAL_ID, MANDATE_ID);

  const context = o.noContext ? null : { display: o.display ?? DISPLAY, execution_mapping: o.mapping ?? MAPPING, linked_record: null, gateway_version: '0.0.0-test' };
  const content = await seal(rt, args, context, keys.keyId, keys.readPub);
  const proposal = {
    id: PROPOSAL_ID, authorizationId: AUTHZ, profileId: PROFILE_ID, path: 'test', pendingDomains: o.pendingDomains ?? ['owner'], committedBy: {}, rejectedBy: null,
    tool: 'email__send_message', content, contentHash: content.proposalContentHash, executionContext: o.executionContext ?? { amount: 12.5 }, status: 'pending',
    executionResult: null, createdAt: as.now() - 60, expiresAt: as.now() + 86400, ...(o.pendingApprovers ? { pendingApprovers: o.pendingApprovers } : {}),
    ...(o.actionType === null ? {} : { actionType: o.actionType ?? 'send' }), deviceDecisions: [],
    ...(o.servedToolArgs ? { toolArgs: o.servedToolArgs } : {}),
  };
  as.byId.set(PROPOSAL_ID, proposal);
  as.pending = [proposal];
  return { as, rt, account, keys, proposal, payload, args };
}
