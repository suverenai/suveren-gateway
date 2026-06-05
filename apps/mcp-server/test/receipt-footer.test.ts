/**
 * Verification footer (link-only / Level 1) — pure-logic unit tests.
 *
 * Pins the behavior that's easy to get subtly wrong: Category-A gating,
 * content-field auto-detection (body → text → description), strip-and-replace
 * idempotency (so edits regenerate cleanly), and the Gmail `raw` skip.
 */
import { describe, it, expect } from 'vitest';
import { appendVerificationFooter, shouldAttachFooter } from '../src/lib/receipt-footer';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const MARKER = '— Sent by an AI agent via Suveren';

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
const markerCount = (s: string) => (s.match(/— Sent by an AI agent via Suveren/g) ?? []).length;

describe('appendVerificationFooter', () => {
  it('appends to `body` for the email profile with a /r/<id> link', () => {
    const out = appendVerificationFooter(tool('email', { body: STRING, subject: STRING }), { body: 'Hi' }, 'rcpt-1');
    expect(out.body).toBe('Hi\n\n— Sent by an AI agent via Suveren. Verify: https://www.suveren.ai/r/rcpt-1');
  });

  it('appends to `text` for the publish profile', () => {
    const out = appendVerificationFooter(tool('publish', { text: STRING }, 'create_post'), { text: 'Hello world' }, 'r2');
    expect(out.text).toContain(`${MARKER}. Verify: https://www.suveren.ai/r/r2`);
  });

  it('appends to `description` for the calendar profile', () => {
    const out = appendVerificationFooter(tool('calendar', { summary: STRING, description: STRING }, 'create_event'), { description: 'Sync' }, 'r3');
    expect(out.description).toContain('/r/r3');
  });

  it('prefers `text` over `description` (detection order)', () => {
    const out = appendVerificationFooter(tool('publish', { text: STRING, description: STRING }, 'create_article_post'), { text: 'Post', description: 'Article blurb' }, 'r4');
    expect(out.text).toContain(MARKER);
    expect(out.description).toBe('Article blurb'); // untouched
  });

  it('falls back to `content` when no body/text/description (publish under a content-field tool)', () => {
    const out = appendVerificationFooter(tool('publish', { content: STRING, title: STRING }, 'create_record'), { content: 'Body', title: 'T' }, 'r4b');
    expect(out.content).toContain(`${MARKER}. Verify: https://www.suveren.ai/r/r4b`);
    expect(out.title).toBe('T'); // untouched
  });

  it('is idempotent — re-applying does not stack footers', () => {
    const t = tool('email', { body: STRING }, 'send_message');
    const once = appendVerificationFooter(t, { body: 'Hi' }, 'r5');
    const twice = appendVerificationFooter(t, once, 'r5');
    expect(markerCount(twice.body as string)).toBe(1);
    expect(twice.body).toBe(once.body);
  });

  it('strip-and-replace — an edit swaps the old receipt for the new one', () => {
    const t = tool('email', { body: STRING });
    const first = appendVerificationFooter(t, { body: 'Draft' }, 'old-id');
    const edited = appendVerificationFooter(t, { ...first, body: `${first.body}` /* simulate carried-over footer */ }, 'new-id');
    expect(markerCount(edited.body as string)).toBe(1);
    expect(edited.body).toContain('/r/new-id');
    expect(edited.body).not.toContain('old-id');
    expect(edited.body).toContain('Draft');
  });

  it('does NOT footer non-Category-A profiles (records/customers/charge)', () => {
    for (const p of ['records', 'customers', 'charge']) {
      const args = { description: 'a record', text: 'x' };
      const out = appendVerificationFooter(tool(p, { description: STRING, text: STRING }, 'create'), args, 'r6');
      expect(out).toBe(args); // unchanged reference
    }
  });

  it('does not special-case Gmail `raw` — footer still appends to body (harmless: downstream ignores body when raw is set)', () => {
    const out = appendVerificationFooter(tool('email', { raw: STRING, body: STRING }), { raw: 'BASE64RFC822', body: 'hi' }, 'r7');
    expect(out.body).toContain(MARKER);
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
