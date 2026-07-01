/**
 * Verification footer (link-only / Level 1) — pure-logic unit tests.
 *
 * Pins the behavior that's easy to get subtly wrong: Category-A gating,
 * content-field auto-detection (body → text → description), strip-and-replace
 * idempotency (so edits regenerate cleanly), the Gmail `raw` skip, the verb by
 * profile (Sent/Published), and the two-line footer (Receipt + HAP promo).
 *
 * NOTE: the assurance wording ("of «name», verified by …") comes from hap-core
 * (deriveIdentityLine). These tests assert the gateway's own contribution
 * (verb, "Receipt:", the "--" lines, the HAP line, the /r/<id> link) and stay
 * decoupled from hap-core's exact separator punctuation.
 */
import { describe, it, expect } from 'vitest';
import { appendVerificationFooter, shouldAttachFooter, verbForProfile } from '../src/lib/receipt-footer';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const HAP_LINE =
  '-- Suveren is an implementation of the Human Agency Protocol (HAP), an open protocol ' +
  'to delegate execution to AI agents under human authority. https://www.humanagencyprotocol.org/';

function tool(profile: string | null, props: Record<string, { type?: unknown }>, name = 'send_message'): DiscoveredTool {
  return {
    originalName: name,
    namespacedName: `int__${name}`,
    integrationId: 'int',
    description: '',
    inputSchema: { type: 'object', properties: props },
    gating: profile ? { profile, executionMapping: {}, staticExecution: {} } : null,
  } as unknown as DiscoveredTool;
}

const STRING = { type: 'string' };
/** Count footers (verb-agnostic) to detect stacking. */
const footerCount = (s: string) => (s.match(/by an AI agent/g) ?? []).length;

describe('verbForProfile', () => {
  it('is "Published" for publish, "Sent" for email/calendar', () => {
    expect(verbForProfile('publish')).toBe('Published');
    expect(verbForProfile('email')).toBe('Sent');
    expect(verbForProfile('calendar')).toBe('Sent');
  });
});

describe('appendVerificationFooter', () => {
  it('appends the two-line footer to `body` for email (Sent + Receipt + HAP line)', () => {
    const out = appendVerificationFooter(tool('email', { body: STRING, subject: STRING }), { body: 'Hi' }, 'rcpt-1');
    expect(out.body).toBe(
      `Hi\n\n-- Sent by an AI agent via Suveren. Receipt: https://www.suveren.ai/r/rcpt-1\n\n${HAP_LINE}`,
    );
  });

  it('uses "Published" for the publish profile', () => {
    const out = appendVerificationFooter(tool('publish', { text: STRING }, 'create_post'), { text: 'Hello world' }, 'r2');
    expect(out.text).toContain('-- Published by an AI agent via Suveren. Receipt: https://www.suveren.ai/r/r2');
    expect(out.text).toContain(HAP_LINE);
  });

  it('appends to `description` for the calendar profile', () => {
    const out = appendVerificationFooter(tool('calendar', { summary: STRING, description: STRING }, 'create_event'), { description: 'Sync' }, 'r3');
    expect(out.description).toContain('-- Sent by an AI agent');
    expect(out.description).toContain('/r/r3');
  });

  it('prefers `text` over `description` (detection order)', () => {
    const out = appendVerificationFooter(tool('publish', { text: STRING, description: STRING }, 'create_article_post'), { text: 'Post', description: 'Article blurb' }, 'r4');
    expect(out.text).toContain('by an AI agent');
    expect(out.description).toBe('Article blurb'); // untouched
  });

  it('falls back to `content` when no body/text/description', () => {
    const out = appendVerificationFooter(tool('publish', { content: STRING, title: STRING }, 'create_record'), { content: 'Body', title: 'T' }, 'r4b');
    expect(out.content).toContain('by an AI agent');
    expect(out.content).toContain('/r/r4b');
    expect(out.title).toBe('T'); // untouched
  });

  it('links use full plain https URLs (no HTML anchors) — works across email/calendar/publish', () => {
    const out = appendVerificationFooter(tool('email', { body: STRING }), { body: 'Hi' }, 'r-links');
    expect(out.body).toContain('Receipt: https://www.suveren.ai/r/r-links');
    expect(out.body).toContain('https://www.humanagencyprotocol.org/');
    expect(out.body).not.toContain('<a '); // no HTML
  });

  it('is idempotent — re-applying does not stack footers', () => {
    const t = tool('email', { body: STRING }, 'send_message');
    const once = appendVerificationFooter(t, { body: 'Hi' }, 'r5');
    const twice = appendVerificationFooter(t, once, 'r5');
    expect(footerCount(twice.body as string)).toBe(1);
    expect(twice.body).toBe(once.body);
  });

  it('strip-and-replace — an edit swaps the old receipt for the new one', () => {
    const t = tool('email', { body: STRING });
    const first = appendVerificationFooter(t, { body: 'Draft' }, 'old-id');
    const edited = appendVerificationFooter(t, { ...first }, 'new-id');
    expect(footerCount(edited.body as string)).toBe(1);
    expect(edited.body).toContain('/r/new-id');
    expect(edited.body).not.toContain('old-id');
    expect(edited.body).toContain('Draft');
  });

  it('strips a legacy em-dash footer too (back-compat)', () => {
    const t = tool('email', { body: STRING });
    const legacy = 'Draft\n\n— Sent by an AI agent via Suveren. Verify: https://www.suveren.ai/r/old';
    const out = appendVerificationFooter(t, { body: legacy }, 'new-id');
    expect(footerCount(out.body as string)).toBe(1);
    expect(out.body).toContain('Draft');
    expect(out.body).not.toContain('old');
    expect(out.body).toContain('Receipt: https://www.suveren.ai/r/new-id');
  });

  it('does NOT footer non-Category-A profiles (records/customers/charge)', () => {
    for (const p of ['records', 'customers', 'charge']) {
      const args = { description: 'a record', text: 'x' };
      const out = appendVerificationFooter(tool(p, { description: STRING, text: STRING }, 'create'), args, 'r6');
      expect(out).toBe(args); // unchanged reference
    }
  });

  it('does not special-case Gmail `raw` — footer still appends to body', () => {
    const out = appendVerificationFooter(tool('email', { raw: STRING, body: STRING }), { raw: 'BASE64RFC822', body: 'hi' }, 'r7');
    expect(out.body).toContain('by an AI agent');
    expect(out.raw).toBe('BASE64RFC822'); // raw untouched
  });

  it('no footer when there is no detectable content field (e.g. send_draft)', () => {
    const args = { draftId: 'abc' };
    const out = appendVerificationFooter(tool('email', { draftId: STRING }, 'send_draft'), args, 'r8');
    expect(out).toBe(args);
  });

  it('no footer when the tool has no profile gating', () => {
    const args = { body: 'Hi' };
    expect(appendVerificationFooter(tool(null, { body: STRING }), args, 'r9')).toBe(args);
  });
});

describe('shouldAttachFooter', () => {
  it('is on for everyone in v1 (free-tier default)', () => {
    expect(shouldAttachFooter()).toBe(true);
  });
});

// ── v0.6 Identity Assurance — footer identity line ────────────────────────────

import type { Subject } from '@hap/core';

describe('appendVerificationFooter — identity (v0.6)', () => {
  const asVouched: Subject = {
    did: 'did:key:a', assurance: 'high', method: 'as_vouched', trust_root: 'as',
    verifier: 'did:web:suveren.ai', disclose: { name: 'Andreas Schadauer' },
  };

  it('high/as_vouched footer discloses the name + operator (separator owned by hap-core)', () => {
    const out = appendVerificationFooter(tool('email', { body: STRING }), { body: 'Hi' }, 'rid', asVouched);
    expect(out.body).toContain('of Andreas Schadauer');
    expect(out.body).toContain('verified by Suveren');
  });

  it('no subject → "Sent by an AI agent via Suveren", no name', () => {
    const out = appendVerificationFooter(tool('email', { body: STRING }), { body: 'Hi' }, 'rid');
    expect(out.body).toContain('Sent by an AI agent via Suveren');
    expect(out.body).not.toContain('agent of'); // no name disclosed
  });

  it('strip-and-replace works on a high footer too (no stacking)', () => {
    const t = tool('email', { body: STRING });
    const once = appendVerificationFooter(t, { body: 'Hi' }, 'r1', asVouched);
    const twice = appendVerificationFooter(t, once, 'r2', asVouched);
    expect(footerCount(twice.body as string)).toBe(1);
  });
});
