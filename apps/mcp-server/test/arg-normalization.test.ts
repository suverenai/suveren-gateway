/**
 * Argument normalization — one spelling for one thing.
 *
 * These vectors are effectively frozen. A content binding hashes an exact
 * string, so changing what normalization produces changes every hash it ever
 * produced, and receipts already issued stop being findable. Treat a change
 * here as a breaking profile change, not a tidy-up.
 *
 * The failure being prevented: `https://x.app` and `https://x.app/` name one
 * build and hash differently, so the receipt for a release can never be found —
 * and "no receipt for this content" is indistinguishable from "these bytes went
 * live without approval". A trailing slash reading as a security incident is
 * the outcome this exists to stop.
 */
import { describe, it, expect } from 'vitest';
import { normalizeUrl, normalizeIncomingArgs } from '../src/lib/arg-normalization';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const toolWith = (argNormalization?: Record<string, string>) =>
  ({ namespacedName: 'deploy-github__release', gating: { profile: 'deploy', argNormalization } }) as unknown as DiscoveredTool;

const CANONICAL = 'https://hap-abc123.vercel.app';

describe('normalizeUrl — the stated normal form', () => {
  it.each([
    ['already canonical',      'https://hap-abc123.vercel.app'],
    ['trailing slash',         'https://hap-abc123.vercel.app/'],
    ['uppercase host',         'https://HAP-abc123.VERCEL.app'],
    ['no scheme',              'hap-abc123.vercel.app'],
    ['no scheme, trailing /',  'hap-abc123.vercel.app/'],
    ['surrounding whitespace', '  https://hap-abc123.vercel.app  '],
    ['a path on it',           'https://hap-abc123.vercel.app/en/docs'],
    ['query and fragment',     'https://hap-abc123.vercel.app/?ref=x#top'],
    ['default port',           'https://hap-abc123.vercel.app:443'],
    ['credentials',            'https://user:pw@hap-abc123.vercel.app'],
  ])('%s → the same string', (_label, input) => {
    expect(normalizeUrl(input)).toBe(CANONICAL);
  });

  it('keeps a non-default port — it is part of the address', () => {
    expect(normalizeUrl('https://staging.internal:8443/x')).toBe('https://staging.internal:8443');
  });

  it('does NOT upgrade http to https — different origins', () => {
    expect(normalizeUrl('http://legacy.internal/')).toBe('http://legacy.internal');
    expect(normalizeUrl('http://legacy.internal')).not.toBe('https://legacy.internal');
  });

  it('is idempotent — normalizing twice cannot drift', () => {
    for (const input of [
      'HTTPS://X.APP/a/b?q=1', 'x.app/', '  https://x.app:443  ', 'http://x.app',
    ]) {
      expect(normalizeUrl(normalizeUrl(input))).toBe(normalizeUrl(input));
    }
  });

  it('leaves a non-URL alone, so the connector can give its own error', () => {
    expect(normalizeUrl('not a url at all')).toBe('not a url at all');
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('   ');
  });

  it('distinct builds stay distinct — normalization must not collapse them', () => {
    expect(normalizeUrl('https://hap-abc123.vercel.app'))
      .not.toBe(normalizeUrl('https://hap-def456.vercel.app'));
  });
});

describe('normalizeIncomingArgs — declared per connector', () => {
  it('normalizes only the declared field', () => {
    const out = normalizeIncomingArgs(toolWith({ deployment_url: 'url' }), {
      deployment_url: 'HAP-abc123.vercel.app/',
      repo: 'humanagencyprotocol/hap-protocol',
      environment: 'Production',
    });
    expect(out.deployment_url).toBe(CANONICAL);
    expect(out.repo).toBe('humanagencyprotocol/hap-protocol');
    expect(out.environment).toBe('Production'); // untouched — not declared
  });

  it('returns the SAME object when nothing is declared', () => {
    const args = { deployment_url: 'x.app/' };
    expect(normalizeIncomingArgs(toolWith(undefined), args)).toBe(args);
  });

  it('returns the SAME object when nothing changed', () => {
    const args = { deployment_url: CANONICAL };
    expect(normalizeIncomingArgs(toolWith({ deployment_url: 'url' }), args)).toBe(args);
  });

  it('does not mutate the caller\'s args', () => {
    const args = { deployment_url: 'x.app/' };
    normalizeIncomingArgs(toolWith({ deployment_url: 'url' }), args);
    expect(args.deployment_url).toBe('x.app/');
  });

  it('ignores an absent or non-string field', () => {
    expect(normalizeIncomingArgs(toolWith({ deployment_url: 'url' }), { repo: 'r' }))
      .toEqual({ repo: 'r' });
    expect(normalizeIncomingArgs(toolWith({ deployment_url: 'url' }), { deployment_url: 42 }))
      .toEqual({ deployment_url: 42 });
  });

  it('uses the value as supplied when the form is unknown, rather than guessing', () => {
    const args = { deployment_url: 'x.app/' };
    expect(normalizeIncomingArgs(toolWith({ deployment_url: 'sha256ish' }), args).deployment_url)
      .toBe('x.app/');
  });
});

describe('the shipped deploy manifest declares it', () => {
  it('release normalizes deployment_url — the field its receipt binds', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const manifest = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'deploy-github.json'), 'utf-8',
    ));
    const release = manifest.toolGating.overrides.release;
    expect(release.argNormalization).toEqual({ deployment_url: 'url' });
    // The normalized field MUST be the bound one, or approval and binding drift.
    expect(release.contentField).toBe('deployment_url');
  });
});
