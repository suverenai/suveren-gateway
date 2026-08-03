/**
 * Content binding over a declared field subset (v0.6) — gateway side.
 *
 * The gap this closes: a `kind:"text"` binding hashes the body and nothing
 * else, so a receipt proves "this text was approved" but not "…to these
 * people". An Executor could deliver approved wording elsewhere and the receipt
 * would still verify. These tests pin the three behaviours that make the fix
 * real: recipients move the hash, `bcc` does NOT (or the recipient could never
 * check it), and a call that cannot supply the declared fields is REFUSED
 * rather than quietly issued with a weaker binding.
 *
 * Uses the shipped email@0.5 declaration verbatim, so a profile edit that
 * changes what is bound breaks here rather than in production.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfile, ContentBindingError } from '@hap/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeContentBinding } from '../src/lib/content-binding';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const EMAIL = 'email-v05-test';

/** Field bindings never consult the tool schema — scope comes from the profile. */
const tool = {
  namespacedName: 'gmail__send_message',
  inputSchema: { properties: {} },
} as unknown as DiscoveredTool;

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ??
  join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

const shipped = JSON.parse(
  readFileSync(join(profilesDir, 'email', '0.5.profile.json'), 'utf-8'),
) as { content_binding: Record<string, unknown> };

beforeAll(() => {
  registerProfile(EMAIL, {
    id: EMAIL,
    version: '0.5',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    content_binding: shipped.content_binding as never,
  });
});

const send = (args: Record<string, unknown>) =>
  computeContentBinding(EMAIL, tool, args, 'send');

describe('email@0.5 ships the binding these tests assume', () => {
  it('binds to/cc/subject/body, requires to+body, scoped to send', () => {
    expect(shipped.content_binding).toEqual({
      version: '2',
      kind: 'jcs',
      fields: ['to', 'cc', 'subject', 'body'],
      required_fields: ['to', 'body'],
      appliesTo: ['send'],
    });
  });
});

describe('computeContentBinding — v2 field binding', () => {
  it('records the bound field list on the receipt, so a verifier knows the scope', () => {
    const bound = send({ to: ['a@x.com'], subject: 'Hi', body: 'Hello' });
    expect(bound?.contentBinding).toEqual({
      version: '2',
      kind: 'jcs',
      fields: ['to', 'cc', 'subject', 'body'],
    });
    expect(bound?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('THE FIX: redirecting an approved message moves the hash', () => {
    const approved = send({ to: ['andreas@sublin.app'], body: 'See attached.' });
    const redirected = send({ to: ['attacker@evil.com'], body: 'See attached.' });
    expect(redirected?.contentHash).not.toBe(approved?.contentHash);
  });

  it('adding a cc to approved content moves the hash', () => {
    const approved = send({ to: ['a@x.com'], body: 'Hello' });
    const ccAdded = send({ to: ['a@x.com'], cc: ['attacker@evil.com'], body: 'Hello' });
    expect(ccAdded?.contentHash).not.toBe(approved?.contentHash);
  });

  it('bcc is NOT bound — a recipient cannot see it, so binding it would make the receipt uncheckable', () => {
    const withoutBcc = send({ to: ['a@x.com'], body: 'Hello' });
    const withBcc = send({ to: ['a@x.com'], body: 'Hello', bcc: ['quiet@x.com'] });
    expect(withBcc?.contentHash).toBe(withoutBcc?.contentHash);
  });

  it('the delivered copy reproduces the hash despite CRLF and trailing whitespace', () => {
    const sent = send({ to: ['a@x.com'], body: 'Line one\nLine two' });
    const delivered = send({ to: ['a@x.com'], body: 'Line one\r\nLine two  \r\n\r\n' });
    expect(delivered?.contentHash).toBe(sent?.contentHash);
  });

  it('an absent cc is not a fault — most emails have none', () => {
    expect(() => send({ to: ['a@x.com'], body: 'Hello' })).not.toThrow();
  });
});

describe('computeContentBinding — v2 refuses rather than binding less', () => {
  it('throws when a required field is absent', () => {
    expect(() => send({ to: ['a@x.com'], subject: 'Hi' })).toThrow(ContentBindingError);
  });

  it('throws on the gmail `raw` bypass, where the message travels unbound', () => {
    try {
      send({ raw: 'base64url-rfc2822' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ContentBindingError);
      expect((err as ContentBindingError).code).toBe('MISSING_REQUIRED_FIELD');
    }
  });
});

describe('computeContentBinding — appliesTo scopes the binding', () => {
  it('does not apply to a delete, which carries an id and no content', () => {
    expect(computeContentBinding(EMAIL, tool, { id: 'abc123' }, 'delete')).toBeUndefined();
  });

  it('does not apply when the manifest declares no action_type (and warns)', () => {
    expect(computeContentBinding(EMAIL, tool, { id: 'abc123' }, undefined)).toBeUndefined();
  });

  it('a contentless action is skipped, NOT refused — no exception either way', () => {
    expect(() => computeContentBinding(EMAIL, tool, { id: 'abc' }, 'delete')).not.toThrow();
  });
});
