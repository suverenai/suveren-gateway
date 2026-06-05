/**
 * Frame hash computation for the Authority UI.
 *
 * Uses SubtleCrypto (browser) instead of Node crypto.
 */

import type { AgentProfile, AgentFrameParams, AgentBoundsParams, AgentContextParams } from '@hap/core';

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
 */
export async function hashGateContent(text: string): Promise<string> {
  const hash = await sha256(text);
  return `sha256:${hash}`;
}
