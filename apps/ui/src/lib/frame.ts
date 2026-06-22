/**
 * Frame hash computation for the Authority UI.
 *
 * Uses SubtleCrypto (browser) instead of Node crypto.
 */

import type { AgentProfile, AgentFrameParams, AgentBoundsParams, AgentContextParams } from '@hap/core';

/**
 * Browser-safe re-implementation of hap-core's canonicalizeText.
 * Must stay in sync with the hap-core definition:
 *   Unicode NFC + CRLF/CR → LF + strip trailing whitespace per line + strip trailing newlines.
 * We inline this here because the full @hap/core ESM bundle imports node:crypto at the module
 * level (for computeIntentHash etc.) which Vite rejects in browser builds.
 */
function canonicalizeText(input: string): string {
  const nfc = input.normalize('NFC');
  const lf = nfc.replace(/\r\n?/g, '\n');
  const lines = lf.split('\n').map(line => line.replace(/[ \t]+$/, ''));
  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Compute SHA-256 hash in the browser.
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute frame hash client-side using the same canonical form as hap-core.
 */
export async function computeFrameHashBrowser(
  params: AgentFrameParams,
  profile: AgentProfile
): Promise<string> {
  if (!profile.frameSchema) {
    throw new Error('Profile is missing frameSchema; cannot compute frame hash');
  }
  const lines = profile.frameSchema.keyOrder.map(
    (key) => `${key}=${String(params[key])}`
  );
  const canonical = lines.join('\n');
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Compute bounds hash client-side (v0.4).
 * Falls back to frameSchema if boundsSchema is not present.
 */
export async function computeBoundsHashBrowser(
  params: AgentBoundsParams,
  profile: AgentProfile
): Promise<string> {
  const schema = profile.boundsSchema ?? profile.frameSchema;
  if (!schema) throw new Error('Profile has no boundsSchema or frameSchema');
  const lines = schema.keyOrder.map(key => `${key}=${String(params[key])}`);
  const canonical = lines.join('\n');
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Compute context hash client-side (v0.4).
 * If the profile has no contextSchema or it has no keys, hashes the empty string.
 */
export async function computeContextHashBrowser(
  params: AgentContextParams,
  profile: AgentProfile
): Promise<string> {
  if (!profile.contextSchema || profile.contextSchema.keyOrder.length === 0) {
    const hash = await sha256('');
    return `sha256:${hash}`;
  }
  const lines = profile.contextSchema.keyOrder.map(key => `${key}=${String(params[key])}`);
  const canonical = lines.join('\n');
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Hash gate content (text) for gate_content_hashes.
 *
 * v0.5: canonicalizes the text (Unicode NFC + LF endings + trailing-whitespace
 * strip) before hashing so the result is byte-identical to the server-side
 * computeIntentHash from hap-core used in the MCP gatekeeper.
 *
 * Uses SubtleCrypto (browser-safe). Does NOT import computeIntentHash which
 * is Node-only.
 */
export async function hashGateContent(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeText(text));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(buf));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
