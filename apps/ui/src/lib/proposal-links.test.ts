import { describe, it, expect } from 'vitest';
import { resolveProposalLinks } from './proposal-links';

/**
 * These links exist because the protocol says it "verifies commitment, not
 * comprehension". It cannot check that the human understood what they approved,
 * which puts the whole burden here: an approval screen showing only an opaque
 * identifier produces a signature, not a decision.
 *
 * So the failure that matters is not "a link is missing" — it is "a link is
 * present and wrong", because that teaches people to approve without clicking.
 */
const LINKS = [
  { label: 'Open this build', template: '{deployment_url}' },
  { label: 'View repository', template: 'https://github.com/{repo}' },
];

describe('resolveProposalLinks', () => {
  it('substitutes arguments into templates', () => {
    const out = resolveProposalLinks(LINKS, {
      deployment_url: 'https://app-abc123.vercel.app',
      repo: 'humanagencyprotocol/hap-protocol',
    });
    expect(out.map(l => l.href)).toEqual([
      'https://app-abc123.vercel.app',
      'https://github.com/humanagencyprotocol/hap-protocol',
    ]);
  });

  it('DROPS a link whose argument is missing, rather than half-filling it', () => {
    // `https://github.com/{repo}` looks clickable and goes nowhere. A broken
    // link on an approval screen is worse than no link: it trains the reviewer
    // to stop clicking, which removes the only inspection step there is.
    const out = resolveProposalLinks(LINKS, { deployment_url: 'https://app-abc123.vercel.app' });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Open this build');
  });

  it('drops anything that is not http(s)', () => {
    // A manifest is data. An agent that could influence it must not be able to
    // put javascript:, data: or file: URLs in front of the person approving.
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://host/x']) {
      expect(resolveProposalLinks([{ label: 'x', template: bad }], {})).toEqual([]);
    }
  });

  it('drops a template with a leftover placeholder', () => {
    expect(resolveProposalLinks([{ label: 'x', template: 'https://h/{a}/{b}' }], { a: '1' })).toEqual([]);
  });

  it('ignores non-string argument values', () => {
    // An object or array would stringify to junk like [object Object].
    expect(resolveProposalLinks([{ label: 'x', template: 'https://h/{o}' }], { o: { a: 1 } })).toEqual([]);
    expect(resolveProposalLinks([{ label: 'x', template: 'https://h/{a}' }], { a: [1, 2] })).toEqual([]);
  });

  it('accepts numbers, which are legitimate ids', () => {
    const out = resolveProposalLinks([{ label: 'x', template: 'https://h/{id}' }], { id: 5711436571 });
    expect(out[0].href).toBe('https://h/5711436571');
  });

  it('returns nothing when a manifest declares no links', () => {
    expect(resolveProposalLinks(undefined, { repo: 'a/b' })).toEqual([]);
    expect(resolveProposalLinks([], { repo: 'a/b' })).toEqual([]);
  });

  it('carries the description through for the link title', () => {
    const out = resolveProposalLinks(
      [{ label: 'Open', template: 'https://h/x', description: 'Look at what would go live' }], {},
    );
    expect(out[0].description).toBe('Look at what would go live');
  });
});
