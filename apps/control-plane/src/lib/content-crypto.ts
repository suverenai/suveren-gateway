/**
 * Proposal content encryption — PE1 (temp/briefs/pe1-encryption-brief.md).
 *
 * HPKE broadcast over JCS(toolArgs), or over a plain change-needed note
 * string — the SAME construction as intent encryption (e2e-crypto.ts /
 * intent-encryption.ts), reused as-is. The Authority Server stores only the
 * ciphertext and its fingerprint; it never sees toolArgs or the note.
 *
 * Unlike intent encryption (caller supplies recipients' pubkeys),
 * this module resolves recipients' E2EE public keys itself — the control
 * plane already owns the AS session (routes/auth.ts does the same kind of
 * direct AS call for the self pubkey-check) — and ALWAYS adds the gateway's
 * own signed-in user to the recipient set, so the submitter can read back
 * their own proposal. A recipient with no registered key is skipped, not
 * fatal (G4): the caller gets `unreadableFor` back to report it.
 */
import { createHash } from 'node:crypto';
import {
  canonicalize,
  encryptProposalContent as hapEncryptProposalContent,
  decryptProposalContent as hapDecryptProposalContent,
} from '@hap/core';
import { encryptForRecipients, decryptIntent, type RecipientWrap } from './e2e-crypto';
import { fetchAs, type AsFetchPinning } from './as-tls-pin';
import { readPairing } from './as-pairing';
import { resolvePinTls } from './as-config';

/** Wire `alg` value — see the PE1 brief's wire contract. */
export const CONTENT_ALG = 'HPKE-X25519-HKDF-SHA256-AES256GCM' as const;

export interface ProposalContentWire {
  v: 1;
  alg: typeof CONTENT_ALG;
  ciphertext: string;
  /** Suveren-internal name (pre-0.8), kept through the transition. */
  keys: Record<string, { ct: string; enc: string }>;
  /** Suveren-internal name (pre-0.8) of the fingerprint `proposalContentHash`. */
  hash: string;
  /**
   * v0.8 normative envelope (protocol.md → Proposals — what the Authority
   * Server receives, rules 2–3): the same wraps as `keys`, keyed by reader;
   * `readers` ∪ `unreadable` is the owner plus every signed decider, and
   * `readers` equals the key set of `encrypted_keys`. Readers are named by
   * user id until the Authority Server names accounts by key-bearing DID.
   */
  encrypted_keys: Record<string, { ct: string; enc: string }>;
  readers: string[];
  unreadable: string[];
}

/**
 * `content_hash` fingerprint: `sha256:` + hex of SHA-256 over JCS(toolArgs).
 * Uses hap-core's `canonicalize` (RFC 8785 JCS) — the Authority Server hashes
 * legacy (plaintext) rows the same way, so both sides agree independently of
 * which path a given proposal took (decision 4 of the PE1 brief).
 */
export function computeProposalContentHash(toolArgs: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalize(toolArgs)).digest('hex')}`;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function keysToWire(encryptedKeys: Record<string, RecipientWrap>): Record<string, { ct: string; enc: string }> {
  const keys: Record<string, { ct: string; enc: string }> = {};
  for (const [userId, wrap] of Object.entries(encryptedKeys)) {
    keys[userId] = { ct: toB64(wrap.ct), enc: toB64(wrap.enc) };
  }
  return keys;
}

export interface ContentCryptoDeps {
  spUrl: string;
  /** The control plane's own AS session cookie (vault.getSpCookie()). */
  cookie: string;
  dataDir: string;
  /** The gateway's own signed-in user id — always added as a recipient. */
  selfUserId: string;
}

/** Fetch one user's registered E2EE public key from the AS. null = unregistered (404) or unreachable. */
async function fetchUserPubkey(userId: string, deps: ContentCryptoDeps): Promise<string | null> {
  const pin = readPairing(deps.dataDir);
  const pinning: AsFetchPinning = {
    enforce: resolvePinTls(deps.dataDir),
    pinnedSpkiHex: pin && pin.asUrl === deps.spUrl ? pin.tlsSpkiPinHex : undefined,
  };
  try {
    const { res } = await fetchAs(
      `${deps.spUrl}/api/users/${encodeURIComponent(userId)}/pubkey`,
      { headers: { Cookie: deps.cookie }, signal: AbortSignal.timeout(5_000) },
      pinning,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { pubkey?: string };
    return typeof data.pubkey === 'string' ? data.pubkey : null;
  } catch {
    return null;
  }
}

/**
 * Resolve recipient userIds (plus `selfUserId`, always added, deduplicated)
 * to their registered E2EE public keys. Anyone with no registered key (or
 * a malformed one) lands in `unreadableFor` instead of failing the whole
 * call — G4.
 */
async function resolveRecipientPubkeys(
  recipientUserIds: string[],
  deps: ContentCryptoDeps,
): Promise<{ resolved: Array<{ userId: string; publicKey: Uint8Array }>; unreadableFor: string[] }> {
  const ids = Array.from(new Set([deps.selfUserId, ...recipientUserIds]));
  const resolved: Array<{ userId: string; publicKey: Uint8Array }> = [];
  const unreadableFor: string[] = [];
  for (const userId of ids) {
    const pubkeyB64 = await fetchUserPubkey(userId, deps);
    if (!pubkeyB64) {
      unreadableFor.push(userId);
      continue;
    }
    try {
      const bytes = new Uint8Array(Buffer.from(pubkeyB64, 'base64'));
      if (bytes.length !== 32) {
        unreadableFor.push(userId);
        continue;
      }
      resolved.push({ userId, publicKey: bytes });
    } catch {
      unreadableFor.push(userId);
    }
  }
  return { resolved, unreadableFor };
}

/**
 * Encrypt a proposal's toolArgs for the submitter plus every listed
 * recipient. Throws only when NOBODY (not even the submitter) has a usable
 * key — an unreadable proposal must never be created.
 */
export async function encryptProposalContent(
  toolArgs: Record<string, unknown>,
  recipientUserIds: string[],
  deps: ContentCryptoDeps,
): Promise<{ content: ProposalContentWire; unreadableFor: string[] }> {
  const { resolved, unreadableFor } = await resolveRecipientPubkeys(recipientUserIds, deps);
  if (resolved.length === 0) {
    throw new Error('No recipient (including the submitter) has a registered end-to-end key — cannot encrypt this proposal.');
  }
  // v0.8 (protocol.md → Proposals, rules 1–4): hap-core's construction,
  // byte for byte the conformance vector's — JCS content, AES-256-GCM under a
  // fresh CEK, the CEK HPKE-sealed per reader, base64url throughout. Readers
  // are named by account id until the Authority Server names accounts by
  // key-bearing DID (Track B). The same wraps also travel as `keys` and the
  // fingerprint as `hash`, the names today's AS stores and every 0.40
  // gateway reads (Node's base64 decoder reads base64url too, so a 0.40
  // gateway decrypts this content unchanged).
  const { content: env, proposalContentHash } = await hapEncryptProposalContent(
    toolArgs,
    resolved.map((r) => ({ did: r.userId, publicKey: r.publicKey })),
    { unreadable: unreadableFor },
  );
  return {
    content: {
      v: 1, alg: CONTENT_ALG, ciphertext: env.ciphertext,
      keys: env.encrypted_keys, hash: proposalContentHash,
      encrypted_keys: env.encrypted_keys, readers: env.readers, unreadable: env.unreadable,
    },
    unreadableFor,
  };
}

/**
 * Encrypt a change-needed note (G5) for the submitter plus every listed
 * recipient (normally just the mandate owner). Unlike proposal content,
 * a note is plain text — no JCS, no fingerprint (the AS only caps its size).
 */
export async function encryptProposalNote(
  note: string,
  recipientUserIds: string[],
  deps: ContentCryptoDeps,
): Promise<{ noteEncrypted: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> }; unreadableFor: string[] }> {
  const { resolved, unreadableFor } = await resolveRecipientPubkeys(recipientUserIds, deps);
  if (resolved.length === 0) {
    throw new Error('No recipient (including the submitter) has a registered end-to-end key — cannot encrypt this note.');
  }
  const encrypted = await encryptForRecipients(note, resolved);
  return {
    noteEncrypted: { ciphertext: toB64(encrypted.intentCiphertext), keys: keysToWire(encrypted.encryptedKeys) },
    unreadableFor,
  };
}

/**
 * Decrypt proposal content (or a note) sealed the same way, for `myUserId`.
 * Generic over the plaintext: the caller decides whether it is JCS(toolArgs)
 * (then JSON.parse it) or a plain note.
 */
/**
 * v0.8 (protocol.md → Proposals, rule 8): an approval surface MUST recompute
 * `proposalContentHash` over the plaintext it decrypted and MUST NOT offer a
 * decision on a mismatch — AES-GCM is not key-committing, so one ciphertext
 * can open to different plaintexts under different wrapped keys, and only the
 * fingerprint shows it. Throws on a mismatch; a wire without a fingerprint
 * (a note) is not checked.
 */
export function assertContentFingerprint(plaintext: string, wire: { hash?: string; proposalContentHash?: string }): void {
  const expected = wire.proposalContentHash ?? wire.hash;
  if (!expected) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Decrypted proposal content is not JSON — refusing to show it.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Decrypted proposal content is not a JSON object — refusing to show it.');
  }
  const actual = computeProposalContentHash(parsed as Record<string, unknown>);
  if (actual !== expected) {
    throw new Error('Decrypted proposal content does not match its fingerprint — refusing to show it.');
  }
}

const STRICT_B64URL = /^[A-Za-z0-9_-]+$/;

export async function decryptProposalContent(
  wire: {
    ciphertext: string;
    keys?: Record<string, { ct: string; enc: string }>;
    encrypted_keys?: Record<string, { ct: string; enc: string }>;
    hash?: string;
    proposalContentHash?: string;
  },
  myUserId: string,
  myPrivateKey: Uint8Array,
): Promise<string> {
  const keys = wire.encrypted_keys ?? wire.keys ?? {};
  const wrap = keys[myUserId];
  if (!wrap) {
    throw new Error('No key wrap for this account in this content — this device cannot read it.');
  }
  const fingerprint = wire.proposalContentHash ?? wire.hash;
  // v0.8 content (base64url, a fingerprint to check against): hap-core's
  // decryption, which treats any failure as unreadable, never as partial
  // content (Proposals, rule 3).
  if (fingerprint && [wire.ciphertext, wrap.ct, wrap.enc].every((x) => STRICT_B64URL.test(x))) {
    let opened: { contentJcs: string; proposalContentHash: string };
    try {
      opened = await hapDecryptProposalContent(
        { ciphertext: wire.ciphertext, encrypted_keys: { [myUserId]: wrap }, readers: [myUserId], unreadable: [] },
        myUserId,
        myPrivateKey,
      );
    } catch (err) {
      throw new Error(`This content could not be opened on this device: ${err instanceof Error ? err.message : String(err)}`);
    }
    // v0.8 rule 8 — never show content whose fingerprint does not match.
    if (opened.proposalContentHash !== fingerprint) {
      throw new Error('Decrypted proposal content does not match its fingerprint — refusing to show it.');
    }
    return opened.contentJcs;
  }
  // Pre-0.41 content (standard base64) and change-needed notes (no fingerprint).
  const encrypted = {
    intentCiphertext: new Uint8Array(Buffer.from(wire.ciphertext, 'base64')),
    encryptedKeys: {
      [myUserId]: {
        ct: new Uint8Array(Buffer.from(wrap.ct, 'base64')),
        enc: new Uint8Array(Buffer.from(wrap.enc, 'base64')),
      },
    },
  };
  const plaintext = await decryptIntent(encrypted, myUserId, myPrivateKey);
  // v0.8 rule 8 — never show content whose fingerprint does not match.
  assertContentFingerprint(plaintext, wire);
  return plaintext;
}
