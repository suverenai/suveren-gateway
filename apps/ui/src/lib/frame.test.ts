/**
 * The UI's canonicalizer against the spec's answer key.
 *
 * `lib/frame.ts` is a duplicate of hap-core's canonicalization, kept because
 * the @hap/core bundle imports node:crypto and cannot run in the browser. The
 * UI signs a bounds_hash and a context_hash; the Authority Server recomputes
 * both with hap-core and refuses a mismatch. So a one-character disagreement
 * between the two implementations does not degrade anything — it means nothing
 * the human authorizes in this UI can ever be verified, and it stays invisible
 * until the two meet.
 *
 * Testing the two against each other would only prove they agree. These cases
 * read the third party both must match:
 * content/0.7/vectors/canonical-bounds-and-scope.json — 10 cases and 2 refusals
 * from protocol.md → *Bounds & Scope Canonicalization*.
 *
 * Vocabulary note: the vector file is v0.7, which renamed "context" to
 * "scope". The implementation is still on the v0.6 wire vocabulary, so
 * `kind: "scope"` cases run through computeContextHashBrowser and the refusal
 * code SCOPE_INVALID_VALUE is asserted as CONTEXT_INVALID_VALUE. The bytes and
 * hashes — what the vectors actually pin — are unaffected by the rename.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentProfile, AgentBoundsParams, AgentContextParams } from '@hap/core';
import {
  computeBoundsHashBrowser,
  computeContextHashBrowser,
  CanonicalValueError,
} from './frame';

const VECTORS_PATH = fileURLToPath(
  new URL('../../../../../content/0.7/vectors/canonical-bounds-and-scope.json', import.meta.url),
);

interface VectorCase {
  id: string;
  note?: string;
  kind: 'bounds' | 'scope';
  key_order: string[];
  values: Record<string, string | number>;
  canonical?: string;
  hash?: string;
  expected_error?: string;
}

interface VectorFile {
  spec_version: string;
  cases: VectorCase[];
  must_refuse: VectorCase[];
}

/** Minimal profile whose schema is exactly the vector's key_order. */
function profileFromCase(vc: VectorCase): AgentProfile {
  const fields: Record<string, { type: 'string' | 'number'; required: false }> = {};
  for (const key of vc.key_order) {
    const value = vc.values[key];
    fields[key] = { type: typeof value === 'number' ? 'number' : 'string', required: false };
  }
  const base = {
    id: `vector/${vc.id}`,
    version: '0.7',
    description: `Synthetic profile for conformance vector ${vc.id}`,
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 3600, max: 86400 },
    retention_minimum: 0,
  } as unknown as AgentProfile;

  return vc.kind === 'bounds'
    ? { ...base, boundsSchema: { keyOrder: vc.key_order, fields } } as AgentProfile
    : { ...base, contextSchema: { keyOrder: vc.key_order, fields } } as AgentProfile;
}

/** v0.7 vector code → the code this (v0.6-vocabulary) implementation throws. */
function expectedCode(vc: VectorCase): string {
  return vc.expected_error === 'SCOPE_INVALID_VALUE'
    ? 'CONTEXT_INVALID_VALUE'
    : String(vc.expected_error);
}

const haveVectors = existsSync(VECTORS_PATH);

if (!haveVectors) {
  console.warn(
    '\n' + '='.repeat(78) +
    '\n!! CONFORMANCE VECTORS NOT FOUND — the UI canonicalizer is UNVERIFIED in this run.' +
    `\n!! Expected: ${VECTORS_PATH}` +
    '\n!! Without them nothing checks that this browser copy hashes bounds and context' +
    '\n!! the way the Authority Server does. Restore the spec checkout before trusting' +
    '\n!! a green suite.\n' + '='.repeat(78) + '\n',
  );
}

describe.skipIf(!haveVectors)('UI canonicalizer — spec conformance vectors', () => {
  const vectors: VectorFile = haveVectors
    ? JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))
    : { spec_version: '', cases: [], must_refuse: [] };

  it('loaded a vector set with cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(vectors.must_refuse.length).toBeGreaterThan(0);
  });

  describe('hash matches the answer key', () => {
    for (const vc of vectors.cases) {
      it(`${vc.id} (${vc.kind})`, async () => {
        const profile = profileFromCase(vc);
        const hash = vc.kind === 'bounds'
          ? await computeBoundsHashBrowser(vc.values as AgentBoundsParams, profile)
          : await computeContextHashBrowser(vc.values as AgentContextParams, profile);

        expect(hash).toBe(vc.hash);
      });
    }
  });

  describe('must_refuse', () => {
    for (const vc of vectors.must_refuse) {
      it(`${vc.id} → ${vc.expected_error}`, async () => {
        // A refusal, not an encoding: hashing silently-stripped input would
        // commit the signature to something the human did not write.
        const profile = profileFromCase(vc);
        let thrown: unknown;
        try {
          if (vc.kind === 'bounds') {
            await computeBoundsHashBrowser(vc.values as AgentBoundsParams, profile);
          } else {
            await computeContextHashBrowser(vc.values as AgentContextParams, profile);
          }
        } catch (err) {
          thrown = err;
        }

        expect(thrown, 'canonicalization should have refused this value').toBeInstanceOf(
          CanonicalValueError,
        );
        expect((thrown as CanonicalValueError).code).toBe(expectedCode(vc));
      });
    }
  });
});

describe('the rules the wizard hits every day', () => {
  // These duplicate two vector cases on purpose: the vectors are skipped when
  // the spec checkout is absent, and these two rules are the ones this UI can
  // break on its own — it hides optional bounds, and it lets a human type into
  // a scope field.
  const emailish = {
    id: 'email@0.6',
    version: '0.6',
    description: '',
    boundsSchema: {
      keyOrder: ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'],
      fields: {},
    },
    contextSchema: { keyOrder: ['allowed_recipients', 'allowed_domains'], fields: {} },
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 3600, max: 86400 },
    retention_minimum: 0,
  } as unknown as AgentProfile;

  it('omits a bound the UI never showed the human, instead of hashing "undefined"', async () => {
    // read_max_age_days / read_daily_max are hidden by the wizard, so they are
    // absent from the bounds object. Rendering them as the literal string
    // "undefined" would commit the signature to a value nobody entered — and
    // to a JavaScript artifact no other implementation produces.
    const hash = await computeBoundsHashBrowser(
      { profile: 'email@0.6', recipient_max: 5, send_daily_max: 20 } as AgentBoundsParams,
      emailish,
    );

    expect(hash).toBe('sha256:ebcb36c5f4a268a6ab8af05f163add1ff4dd28bb681d4c1302d40e3d514d4ed9');
  });

  it('refuses a pasted multi-line scope value rather than signing a forged record', async () => {
    // A raw LF inside a value would inject an extra `key=value` record into the
    // canonical string the human's signature covers.
    await expect(
      computeContextHashBrowser(
        { allowed_recipients: 'a@x.com\nallowed_domains=evil.example', allowed_domains: 'x.com' } as AgentContextParams,
        emailish,
      ),
    ).rejects.toThrow(CanonicalValueError);
  });

  it('percent-encodes `=` so a value cannot forge a record either', async () => {
    const withEquals = await computeContextHashBrowser(
      { allowed_recipients: 'a=b', allowed_domains: 'x.com' } as AgentContextParams,
      emailish,
    );
    const encodedLiterally = await computeContextHashBrowser(
      { allowed_recipients: 'a%3Db', allowed_domains: 'x.com' } as AgentContextParams,
      emailish,
    );

    // `a=b` must hash as `a%3Db`; and because `%` is itself encoded, a human
    // who literally typed `a%3Db` gets a DIFFERENT hash (the encoding is
    // self-inverse rather than ambiguous).
    expect(withEquals).not.toBe(encodedLiterally);
  });
});
