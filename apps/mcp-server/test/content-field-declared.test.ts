import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerProfile, clearProfiles } from '@hap/core';
import { computeContentBinding } from '../src/lib/content-binding';
import { appendVerificationFooter } from '../src/lib/receipt-footer';
import type { DiscoveredTool } from '../src/lib/integration-manager';

/**
 * A manifest may declare WHICH argument the receipt binds to.
 *
 * Auto-detection only knows a prose vocabulary (body/text/description/content).
 * Everything that is not a message — a commit SHA, an infrastructure plan hash,
 * a record id — produces no hash, no binding, and no error. The receipt is
 * still issued and simply proves less than it looks like it does, which is the
 * worst available failure mode: it is invisible at the moment it matters and
 * only discovered when someone tries to verify.
 */
const PROFILE = 'binding-test';

beforeAll(() => {
  registerProfile(PROFILE, {
    id: PROFILE, name: 'Binding Test', version: '0',
    boundsSchema: { keyOrder: [], fields: {} },
    contextSchema: { keyOrder: [], fields: {} },
    content_binding: { version: '1', kind: 'text' },
  } as unknown as Parameters<typeof registerProfile>[1]);
});
afterAll(() => clearProfiles());

function tool(props: Record<string, { type: string }>, contentField?: string): DiscoveredTool {
  return {
    originalName: 'deploy',
    namespacedName: 'deploy-github__deploy',
    integrationId: 'deploy-github',
    description: 'Deploy',
    inputSchema: { properties: props },
    gating: { profile: PROFILE, executionMapping: {}, ...(contentField ? { contentField } : {}) },
  } as unknown as DiscoveredTool;
}

describe('manifest-declared content field', () => {
  const deployProps = { repo: { type: 'string' }, sha: { type: 'string' }, environment: { type: 'string' } };

  it('binds NOTHING when a non-prose tool relies on auto-detection', () => {
    // The bug this feature exists to fix. No field named body/text/description/
    // content, so nothing is bound — silently.
    const result = computeContentBinding(PROFILE, tool(deployProps), { repo: 'o/r', sha: 'abc123', environment: 'production' });
    expect(result).toBeUndefined();
  });

  it('binds the declared field', () => {
    const result = computeContentBinding(PROFILE, tool(deployProps, 'sha'), { repo: 'o/r', sha: 'abc123', environment: 'production' });
    expect(result?.contentHash).toBeTruthy();
    expect(result?.contentBinding).toEqual({ version: '1', kind: 'text' });
  });

  it('binds the commit, so a different commit produces a different hash', () => {
    // The property the whole deploy verification rests on: a receipt for one
    // commit must not verify against another.
    const a = computeContentBinding(PROFILE, tool(deployProps, 'sha'), { sha: 'aaa111' })!;
    const b = computeContentBinding(PROFILE, tool(deployProps, 'sha'), { sha: 'bbb222' })!;
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('is deterministic — the same commit always yields the same hash', () => {
    // A verifier recomputes this independently; drift would fail every check.
    const a = computeContentBinding(PROFILE, tool(deployProps, 'sha'), { sha: 'abc123' })!;
    const b = computeContentBinding(PROFILE, tool(deployProps, 'sha'), { sha: 'abc123' })!;
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('refuses to bind when the declared field is missing at call time', () => {
    // Binding the empty string would look like a real binding while committing
    // to nothing — a receipt that appears to name a commit and does not.
    expect(computeContentBinding(PROFILE, tool(deployProps, 'sha'), { repo: 'o/r' })).toBeUndefined();
    expect(computeContentBinding(PROFILE, tool(deployProps, 'sha'), { sha: '' })).toBeUndefined();
  });

  it('a declared field overrides auto-detection', () => {
    // A tool with BOTH a prose field and a declared one must bind what the
    // manifest chose, not what detection happens to find first.
    const both = { text: { type: 'string' }, sha: { type: 'string' } };
    const declared = computeContentBinding(PROFILE, tool(both, 'sha'), { text: 'a note', sha: 'abc123' })!;
    const detected = computeContentBinding(PROFILE, tool(both), { text: 'a note', sha: 'abc123' })!;
    expect(declared.contentHash).not.toBe(detected.contentHash);
    // and the declared one must equal binding the sha alone
    const shaOnly = computeContentBinding(PROFILE, tool({ sha: { type: 'string' } }, 'sha'), { sha: 'abc123' })!;
    expect(declared.contentHash).toBe(shaOnly.contentHash);
  });

  it('declaring a bound field does NOT make the footer append to it', () => {
    // The hazard that made this a separate field. The footer appends a
    // verification line to prose; appending it to a commit SHA would corrupt
    // the value being deployed and ship the wrong thing — or nothing.
    const args = { repo: 'o/r', sha: 'abc123', environment: 'production' };
    const out = appendVerificationFooter(tool(deployProps, 'sha'), args, 'rct_1');
    expect(out.sha).toBe('abc123');
  });
});

/**
 * Regression cover for the SHARED code path. `computeContentBinding` is used by
 * every profile declaring content_binding — publish, email, records, customers
 * — and the `kind:"text"` branch had no test before this change touched it.
 *
 * The property that must hold: a manifest that declares NO contentField behaves
 * exactly as it did before, because that is every existing connector.
 */
describe('existing connectors are unaffected', () => {
  const proseTool = (props: Record<string, { type: string }>) => tool(props);

  it('auto-detection still binds a prose field when nothing is declared', () => {
    const result = computeContentBinding(PROFILE, proseTool({ text: { type: 'string' } }), { text: 'a post' });
    expect(result?.contentHash).toBeTruthy();
  });

  it('binds the same value it did before — detection order is unchanged', () => {
    // body wins over text, text over description, description over content.
    // A reordering would silently change every published post's fingerprint and
    // invalidate receipts issued before the change.
    const all = { body: { type: 'string' }, text: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' } };
    const detected = computeContentBinding(PROFILE, proseTool(all), { body: 'B', text: 'T', description: 'D', content: 'C' })!;
    const bodyOnly = computeContentBinding(PROFILE, proseTool({ body: { type: 'string' } }), { body: 'B' })!;
    expect(detected.contentHash).toBe(bodyOnly.contentHash);
  });

  it('an unrelated extra argument does not change the hash', () => {
    // Only the bound field is hashed. If the whole args object were hashed, an
    // injected receipt_id or footer would change the fingerprint after signing.
    const a = computeContentBinding(PROFILE, proseTool({ text: { type: 'string' } }), { text: 'a post' })!;
    const b = computeContentBinding(PROFILE, proseTool({ text: { type: 'string' } }), { text: 'a post', sha: 'abc123', receipt_id: 'rct_1' })!;
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('an EMPTY prose field still binds — only a DECLARED field refuses', () => {
    // The new empty-check must not leak into the auto-detected path: an empty
    // post body is a legitimate (if odd) thing to bind, and refusing would drop
    // binding from calls that have it today.
    const result = computeContentBinding(PROFILE, proseTool({ text: { type: 'string' } }), { text: '' });
    expect(result?.contentHash).toBeTruthy();
  });
});
