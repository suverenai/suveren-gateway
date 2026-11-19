/**
 * PE1 — the MCP server asking the control plane to seal/open proposal
 * content (toolArgs, JCS-canonicalized, or a change-needed note) for
 * recipients it has no key material for. The vault's private HPKE key, and
 * the Authority Server session needed to resolve recipients' public keys,
 * live only in the control plane — this is the MCP-server-side half of
 * `/internal/encrypt-content` / `/internal/decrypt-content`
 * (control-plane/src/routes/internal-content-crypto.ts), the same
 * direction and auth style as cp-notify.ts (MCP → CP, shared secret), not
 * mcp-bridge.ts (which runs CP → MCP).
 */

/*
 * Same port-default reasoning as cp-notify.ts: must match the control
 * plane's own default (index.ts: 3402) exactly, since nothing sets
 * SUVEREN_CP_PORT in dev.
 */
const CP_PORT = process.env.SUVEREN_CP_PORT ?? '3402';
const CP_BASE = process.env.SUVEREN_CP_INTERNAL_URL ?? `http://127.0.0.1:${CP_PORT}`;
const TIMEOUT_MS = 10_000;

export interface ProposalContentWire {
  v: 1;
  alg: string;
  ciphertext: string;
  /** Suveren-internal name (pre-0.8), kept through the transition. */
  keys: Record<string, { ct: string; enc: string }>;
  /** Suveren-internal name (pre-0.8) of the fingerprint. */
  hash: string;
  /** v0.8 normative (protocol.md → Proposals, rule 2): the content key
   *  wrapped per reader. Under a 0.8 mandate keyed by DID (owner + signed
   *  deciders), beside `keys` by account id; under 0.7 the same as `keys`. */
  encrypted_keys?: Record<string, { ct: string; enc: string }>;
  readers?: string[];
  unreadable?: string[];
  /** Device keys, step 8: one wrap per active device of each reader (by device key id) and the sealed card context. */
  device_keys?: Record<string, { ct: string; enc: string }>;
  context?: string;
}

/** A reader that could not get a wrap, and why: a code (the page's wording is approval-card `S8`, DRAFT). */
export interface UnreadableReader { did: string; code: string }

/** What the gateway adds beside the arguments so a card can be drawn and checked (plan 5): its own data, never the AI's text. */
export interface CardContextInput {
  display: unknown;
  execution_mapping: unknown;
  /** The manifest's static execution fields (with the mapping, the whole execution context can be rebuilt). */
  static_execution?: unknown;
  linked_record: unknown;
  gateway_version: string;
}

async function postInternal(path: string, body: unknown): Promise<Record<string, unknown>> {
  const secret = process.env.SUVEREN_INTERNAL_SECRET ?? '';
  if (!secret) {
    throw new Error('No internal secret configured between the MCP server and the control plane.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CP_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((data.error as string) ?? `${path} failed: ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Encrypt toolArgs for the submitter (added by the control plane itself)
 * plus every listed recipient. `unreadableFor` lists anyone (besides the
 * submitter) with no registered end-to-end key — G4: the proposal is still
 * created for everyone who CAN read it.
 */
export async function cpEncryptContent(
  toolArgs: Record<string, unknown>,
  recipientUserIds: string[],
  /** v0.8 only — the mandate's owner DID and signed deciders (readers by DID). */
  readers?: { ownerDid: string; deciders: string[] },
  /** Device keys only (a gateway with a chain): sealed beside the content; a gateway without a chain ignores it. */
  context?: CardContextInput,
): Promise<{ content: ProposalContentWire; unreadableFor: string[]; unreadableReaders?: UnreadableReader[] }> {
  const data = await postInternal('/internal/encrypt-content', { toolArgs, recipientUserIds, ...(readers ? { readers } : {}), ...(context ? { context } : {}) });
  return data as unknown as { content: ProposalContentWire; unreadableFor: string[]; unreadableReaders?: UnreadableReader[] };
}

/**
 * Decrypt proposal content (or a change-needed note) sealed for this
 * gateway's own signed-in user — resolved by the control plane itself from
 * its own session, never trusted from this call's arguments.
 */
export async function cpDecryptContent(
  wire: {
    ciphertext: string;
    keys?: Record<string, { ct: string; enc: string }>;
    encrypted_keys?: Record<string, { ct: string; enc: string }>;
    /** Device keys, step 8: the caller's own wrap, as the Authority Server serves it to a device session. */
    device_keys?: Record<string, { ct: string; enc: string }>;
    context?: string;
    hash?: string;
    proposalContentHash?: string;
  },
): Promise<string> {
  const data = await postInternal('/internal/decrypt-content', {
    ciphertext: wire.ciphertext,
    // Both names: under a 0.8 mandate `encrypted_keys` is keyed by DID and
    // `keys` by account id; the control plane finds this user's wrap by either.
    keys: { ...(wire.keys ?? {}), ...(wire.encrypted_keys ?? {}) },
    ...(wire.device_keys ? { device_keys: wire.device_keys } : {}),
    ...(wire.context ? { context: wire.context } : {}),
    // v0.8 rule 8: the control plane checks the decrypted content against the fingerprint.
    ...(wire.proposalContentHash ? { proposalContentHash: wire.proposalContentHash } : wire.hash ? { hash: wire.hash } : {}),
  });
  return data.plaintext as string;
}
