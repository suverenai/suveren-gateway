/**
 * A content field that the provider ignores.
 *
 * Gmail's `send_message` accepts `raw` — a complete RFC 2822 message — and its
 * own schema says raw "ignores params.to, cc, bcc, subject, body". So an agent
 * can send an email whose entire content lives in a field the Gatekeeper does
 * not look at, while the field it DOES look at is absent.
 *
 * The failure that matters is not "no binding". It is a binding that looks
 * valid and commits to nothing: a receipt carrying contentHash of the empty
 * string is indistinguishable, to anyone reading the receipt, from one that
 * genuinely binds the message. That is the "verifies but is false" case the
 * protocol exists to prevent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfile } from '@hap/core';
import { computeContentBinding } from '../src/lib/content-binding';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const EMAIL_PROFILE = 'email-raw-test';

/** sha256 of the empty string — what a binding over an absent field produces. */
const HASH_OF_NOTHING = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Gmail's real send_message shape, trimmed to what matters here. */
const sendMessage = {
  inputSchema: {
    properties: {
      to: { type: 'array' },
      cc: { type: 'array' },
      bcc: { type: 'array' },
      subject: { type: 'string' },
      body: { type: 'string' },
      raw: { type: 'string' },
    },
  },
} as unknown as DiscoveredTool;

beforeAll(() => {
  registerProfile(EMAIL_PROFILE, {
    id: EMAIL_PROFILE,
    version: '0.4',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    content_binding: { version: '1', kind: 'text' },
  });
});

describe('a send whose content is in a field we do not bind', () => {
  it('binds the body when the body is what was sent', () => {
    const out = computeContentBinding(EMAIL_PROFILE, sendMessage, {
      to: ['a@example.com'],
      subject: 'Hello',
      body: 'The agreed text.',
    });
    expect(out?.contentHash).toBeDefined();
    expect(out?.contentHash).not.toBe(HASH_OF_NOTHING);
  });

  it('does NOT hand back a binding over nothing when the message is sent as raw', () => {
    const out = computeContentBinding(EMAIL_PROFILE, sendMessage, {
      raw: 'RnJvbTogYUBleGFtcGxlLmNvbQpUbzogdmljdGltQGV4YW1wbGUuY29t',
    });

    // Either refuse to bind, or bind the content that was actually sent.
    // Returning a hash of the empty string is the one unacceptable answer:
    // the receipt would assert content provenance it does not have.
    expect(out?.contentHash).not.toBe(HASH_OF_NOTHING);
  });

  it('two different raw messages must not share a content hash', () => {
    // If both collapse to the empty-string hash, a receipt for one message
    // verifies against the other — the binding stops distinguishing anything.
    const a = computeContentBinding(EMAIL_PROFILE, sendMessage, { raw: 'bWVzc2FnZSBB' });
    const b = computeContentBinding(EMAIL_PROFILE, sendMessage, { raw: 'bWVzc2FnZSBC' });

    // Emitting nothing is the acceptable answer today. Asserting it explicitly
    // rather than skipping: a conditional here would pass vacuously and hide a
    // regression that reintroduced two equal, meaningless hashes.
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });

  it('still binds normally when the content field is genuinely present', () => {
    // The guard must not silently disable binding for ordinary sends.
    const out = computeContentBinding(EMAIL_PROFILE, sendMessage, {
      to: ['a@example.com'],
      body: 'Text that was actually approved.',
    });
    expect(out?.contentBinding).toEqual({ version: '1', kind: 'text' });
    expect(out?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
