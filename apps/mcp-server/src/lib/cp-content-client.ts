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
  keys: Record<string, { ct: string; enc: string }>;
  hash: string;
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
): Promise<{ content: ProposalContentWire; unreadableFor: string[] }> {
  const data = await postInternal('/internal/encrypt-content', { toolArgs, recipientUserIds });
  return data as unknown as { content: ProposalContentWire; unreadableFor: string[] };
}

/**
 * Decrypt proposal content (or a change-needed note) sealed for this
 * gateway's own signed-in user — resolved by the control plane itself from
 * its own session, never trusted from this call's arguments.
 */
export async function cpDecryptContent(wire: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> }): Promise<string> {
  const data = await postInternal('/internal/decrypt-content', { ciphertext: wire.ciphertext, keys: wire.keys });
  return data.plaintext as string;
}
