/**
 * Verification footer (link-only / Level 1) — pure-logic unit tests.
 *
 * Pins the behavior that's easy to get subtly wrong: the footer applies only
 * to a tool whose manifest declares `message` (never by profile name), goes
 * into the DECLARED text field with the DECLARED verb (Sent/Published),
 * strip-and-replace idempotency (so edits regenerate cleanly), the Gmail
 * `raw` skip, and the one-line footer (ticket link only).
 *
 * NOTE: the assurance wording ("of «name», verified by …") comes from hap-core
 * (deriveIdentityLine). These tests assert the gateway's own contribution
 * (verb, "Ticket:", the "--" line, the /t/<id> link) and stay
 * decoupled from hap-core's exact separator punctuation.
 */
import { describe, it, expect } from 'vitest';
import { appendVerificationFooter, shouldAttachFooter } from '../src/lib/receipt-footer';
import type { MessageGatingDeclaration } from '../src/lib/tool-gating-types';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const HAP_PROMO = 'humanagencyprotocol.org';

/** A tool as the manifest declares it: `message` drives the footer; `null` = no gating at all. */
function tool(
  message: MessageGatingDeclaration | undefined | null,
  props: Record<string, { type?: unknown }>,
  name = 'send_message',
  profile = 'email',
): DiscoveredTool {
  return {
    originalName: name,
    namespacedName: `int__${name}`,
    integrationId: 'int',
    description: '',
    inputSchema: { type: 'object', properties: props },
    gating: message === null ? null : { profile, executionMapping: {}, staticExecution: {}, ...(message ? { message } : {}) },
  } as unknown as DiscoveredTool;
}

const BODY: MessageGatingDeclaration = { text: 'body', to: 'to', cc: 'cc', subject: 'subject', verb: 'Sent' };
const POST: MessageGatingDeclaration = { text: 'text', verb: 'Published' };
const EVENT: MessageGatingDeclaration = { text: 'description', verb: 'Sent' };

const STRING = { type: 'string' };
/** Count footers (verb- and wording-agnostic: v1 "by an AI agent", v1.1 "'s AI agent") to detect stacking. */
const footerCount = (s: string) => (s.match(/(?:by an AI agent|'s AI agent)/g) ?? []).length;

describe('appendVerificationFooter', () => {
  it('appends the two-line footer to `body` for email (Sent + Ticket + HAP line)', () => {
    const out = appendVerificationFooter(tool(BODY, { body: STRING, subject: STRING }), { body: 'Hi' }, 'rcpt-1');
    expect(out.body).toBe(
      `Hi\n\n-- Sent by an AI agent via Suveren. Ticket: https://www.suveren.ai/t/rcpt-1`,
    );
  });

  it('uses the declared verb — "Published" for a post', () => {
    const out = appendVerificationFooter(tool(POST, { text: STRING }, 'create_post', 'publish'), { text: 'Hello world' }, 'r2');
    expect(out.text).toContain('-- Published by an AI agent via Suveren. Ticket: https://www.suveren.ai/t/r2');
    expect(out.text).not.toContain(HAP_PROMO); // one-line footer: no HAP promotion line
  });

  it('appends to the declared field — `description` for a calendar event', () => {
    const out = appendVerificationFooter(tool(EVENT, { summary: STRING, description: STRING }, 'create_event', 'calendar'), { description: 'Sync' }, 'r3');
    expect(out.description).toContain('-- Sent by an AI agent');
    expect(out.description).toContain('/t/r3');
  });

  it('touches only the declared field, never another prose-looking one', () => {
    const out = appendVerificationFooter(tool(POST, { text: STRING, description: STRING }, 'create_article_post', 'publish'), { text: 'Post', description: 'Article blurb' }, 'r4');
    expect(out.text).toContain('by an AI agent');
    expect(out.description).toBe('Article blurb'); // untouched
  });

  it('any declared field name works — nothing is guessed from a fixed vocabulary', () => {
    const out = appendVerificationFooter(tool({ text: 'content', verb: 'Published' }, { content: STRING, title: STRING }, 'create_record', 'publish'), { content: 'Body', title: 'T' }, 'r4b');
    expect(out.content).toContain('by an AI agent');
    expect(out.content).toContain('/t/r4b');
    expect(out.title).toBe('T'); // untouched
  });

  it('links use full plain https URLs (no HTML anchors) — works across email/calendar/publish', () => {
    const out = appendVerificationFooter(tool(BODY, { body: STRING }), { body: 'Hi' }, 'r-links');
    expect(out.body).toContain('Ticket: https://www.suveren.ai/t/r-links');
    expect(out.body).not.toContain(HAP_PROMO);
    expect(out.body).not.toContain('<a '); // no HTML
  });

  it('is idempotent — re-applying does not stack footers', () => {
    const t = tool(BODY, { body: STRING }, 'send_message');
    const once = appendVerificationFooter(t, { body: 'Hi' }, 'r5');
    const twice = appendVerificationFooter(t, once, 'r5');
    expect(footerCount(twice.body as string)).toBe(1);
    expect(twice.body).toBe(once.body);
  });

  it('strip-and-replace — an edit swaps the old receipt for the new one', () => {
    const t = tool(BODY, { body: STRING });
    const first = appendVerificationFooter(t, { body: 'Draft' }, 'old-id');
    const edited = appendVerificationFooter(t, { ...first }, 'new-id');
    expect(footerCount(edited.body as string)).toBe(1);
    expect(edited.body).toContain('/t/new-id');
    expect(edited.body).not.toContain('old-id');
    expect(edited.body).toContain('Draft');
  });

  it('strips a legacy em-dash footer too (back-compat)', () => {
    const t = tool(BODY, { body: STRING });
    const legacy = 'Draft\n\n— Sent by an AI agent via Suveren. Verify: https://www.suveren.ai/r/old';
    const out = appendVerificationFooter(t, { body: legacy }, 'new-id');
    expect(footerCount(out.body as string)).toBe(1);
    expect(out.body).toContain('Draft');
    expect(out.body).not.toContain('old');
    expect(out.body).toContain('Ticket: https://www.suveren.ai/t/new-id');
  });

  it('no `message` declared → no footer, whatever the area (never decided by profile name)', () => {
    for (const p of ['email', 'calendar', 'publish', 'records']) {
      const args = { body: 'Hi', description: 'a record', text: 'x' };
      const out = appendVerificationFooter(tool(undefined, { body: STRING, description: STRING, text: STRING }, 'create', p), args, 'r6');
      expect(out).toBe(args); // unchanged reference
    }
  });

  it('a declared `message` gets the footer in any area — the declaration is what counts', () => {
    const out = appendVerificationFooter(tool({ text: 'note', verb: 'Sent' }, { note: STRING }, 'create', 'records'), { note: 'n' }, 'r6b');
    expect(out.note).toContain('/t/r6b');
  });

  it('does not special-case Gmail `raw` — footer still appends to body', () => {
    const out = appendVerificationFooter(tool(BODY, { raw: STRING, body: STRING }), { raw: 'BASE64RFC822', body: 'hi' }, 'r7');
    expect(out.body).toContain('by an AI agent');
    expect(out.raw).toBe('BASE64RFC822'); // raw untouched
  });

  it('no footer for a tool that declares no message (e.g. send_draft)', () => {
    const args = { draftId: 'abc' };
    const out = appendVerificationFooter(tool(undefined, { draftId: STRING }, 'send_draft'), args, 'r8');
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
    const out = appendVerificationFooter(tool(BODY, { body: STRING }), { body: 'Hi' }, 'rid', asVouched);
    expect(out.body).toContain("Andreas Schadauer's AI agent"); // v1.1 wording
    expect(out.body).toContain('verified by Suveren');
  });

  it('no subject → "Sent by an AI agent via Suveren", no name', () => {
    const out = appendVerificationFooter(tool(BODY, { body: STRING }), { body: 'Hi' }, 'rid');
    expect(out.body).toContain('Sent by an AI agent via Suveren');
    expect(out.body).not.toContain('agent of'); // no name disclosed
  });

  it('strip-and-replace works on a high footer too (no stacking)', () => {
    const t = tool(BODY, { body: STRING });
    const once = appendVerificationFooter(t, { body: 'Hi' }, 'r1', asVouched);
    const twice = appendVerificationFooter(t, once, 'r2', asVouched);
    expect(footerCount(twice.body as string)).toBe(1);
  });
});
