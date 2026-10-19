/**
 * `message` — a tool's own manifest declaration of which arguments carry a
 * human-readable message (tool-gating-types.ts `MessageGatingDeclaration`).
 * It replaced three hardcoded spots: the footer's profile allowlist + field
 * guessing (receipt-footer.ts), the mime-raw builder's literal to/cc/subject/
 * body (attachment-resolution.ts). These tests pin the validation and that
 * every shipped tool that had a footer before declares the SAME text field —
 * a different field would change existing tickets' content hashes.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidMessageReason, invalidManifestMessageReason } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

describe('invalidMessageReason', () => {
  it('absent → fine', () => {
    expect(invalidMessageReason('t', {})).toBeNull();
  });
  it('text + verb → fine; to/cc/subject optional', () => {
    expect(invalidMessageReason('t', { message: { text: 'body', verb: 'Sent' } })).toBeNull();
    expect(invalidMessageReason('t', { message: { text: 'body', to: 'to', cc: 'cc', subject: 'subject', verb: 'Published' } })).toBeNull();
  });
  it('refuses a missing text, an unknown verb, an empty optional field', () => {
    expect(invalidMessageReason('t', { message: { verb: 'Sent' } })).toMatch(/text/);
    expect(invalidMessageReason('t', { message: { text: 'body', verb: 'Posted' } })).toMatch(/verb/);
    expect(invalidMessageReason('t', { message: { text: 'body', verb: 'Sent', to: '' } })).toMatch(/\.to/);
  });
});

describe('shipped manifests', () => {
  const manifests = readdirSync(MANIFESTS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => [f, JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8'))] as const);

  it('every manifest\'s message declarations are valid', () => {
    for (const [f, m] of manifests) expect(invalidManifestMessageReason(m), f).toBeNull();
  });

  it('exactly the tools that had a ticket link before declare one — with the same text field', () => {
    // The field the old name-guessing picked from each tool's real schema
    // (2026-10-18, listed from the installed connectors).
    const expected: Record<string, { text: string; verb: string }> = {
      'mail.json/send_message': { text: 'body', verb: 'Sent' },
      'gmail.json/send_message': { text: 'body', verb: 'Sent' },
      'gmail.json/create_draft': { text: 'body', verb: 'Sent' },
      'calendar.json/create_event': { text: 'description', verb: 'Sent' },
      'calendar.json/update_event': { text: 'description', verb: 'Sent' },
      'linkedin.json/create_post': { text: 'text', verb: 'Published' },
      'linkedin.json/create_image_post': { text: 'text', verb: 'Published' },
      'linkedin.json/create_article_post': { text: 'text', verb: 'Published' },
    };
    const declared: Record<string, { text: string; verb: string }> = {};
    for (const [f, m] of manifests) {
      for (const [tool, entry] of Object.entries(m.toolGating?.overrides ?? {}) as [string, { message?: { text: string; verb: string } }][]) {
        if (entry.message) declared[`${f}/${tool}`] = { text: entry.message.text, verb: entry.message.verb };
      }
    }
    expect(declared).toEqual(expected);
  });

  it('a mime-raw connector declares to + text on every tool that takes attachments', () => {
    for (const [f, m] of manifests) {
      if (m.attachments?.transport !== 'mime-raw') continue;
      for (const [tool, entry] of Object.entries(m.toolGating?.overrides ?? {}) as [string, { attachmentsArg?: string; message?: { to?: string; text?: string } }][]) {
        if (!entry.attachmentsArg) continue;
        expect(entry.message?.to, `${f}/${tool}`).toBeTruthy();
        expect(entry.message?.text, `${f}/${tool}`).toBeTruthy();
      }
    }
  });
});
