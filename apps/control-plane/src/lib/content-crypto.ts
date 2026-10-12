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
import { canonicalize } from '@hap/core';
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
  keys: Record<string, { ct: string; enc: string }>;
  hash: string;
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
  const canonical = canonicalize(toolArgs);
  const hash = computeProposalContentHash(toolArgs);
  const { resolved, unreadableFor } = await resolveRecipientPubkeys(recipientUserIds, deps);
  if (resolved.length === 0) {
    throw new Error('No recipient (including the submitter) has a registered end-to-end key — cannot encrypt this proposal.');
  }
  const encrypted = await encryptForRecipients(canonical, resolved);
  return {
    content: { v: 1, alg: CONTENT_ALG, ciphertext: toB64(encrypted.intentCiphertext), keys: keysToWire(encrypted.encryptedKeys), hash },
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
export async function decryptProposalContent(
  wire: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> },
  myUserId: string,
  myPrivateKey: Uint8Array,
): Promise<string> {
  const wrap = wire.keys[myUserId];
  if (!wrap) {
    throw new Error('No key wrap for this account in this content — this device cannot read it.');
  }
  const encrypted = {
    intentCiphertext: new Uint8Array(Buffer.from(wire.ciphertext, 'base64')),
    encryptedKeys: {
      [myUserId]: {
        ct: new Uint8Array(Buffer.from(wrap.ct, 'base64')),
        enc: new Uint8Array(Buffer.from(wrap.enc, 'base64')),
      },
    },
  };
  return decryptIntent(encrypted, myUserId, myPrivateKey);
}
