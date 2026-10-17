/**
 * Content binding over the "attachments" field (email/0.9's content_binding,
 * item 2 of "emails carry documents by reference"): binds
 * `[{filename, sha256}]` per attachment — never bytes — driven by the
 * `_attachmentsSealed` meta attachment-resolution.ts attaches, regardless of
 * whether the wire argument of the same name happens to carry embedded
 * bytes (a "field"-transport connector, once finalized) or doesn't exist at
 * all (a "mime-raw" connector folds it into `raw`).
 *
 * Fetches email/0.9's REAL (not yet merged) content_binding declaration via
 * `git show`, same discipline as content-binding-fields.test.ts uses for the
 * shipped 0.5 one — a profile edit that changes what is bound breaks here.
 * Also pins the regression: a plain send (no attachments) or a call under
 * the OLDER, already-shipped email@0.5 binding hashes exactly as before —
 * the override only ever activates when the profile's own `fields` list
 * names "attachments".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { registerProfile, ContentBindingError } from '@hap/core';
import { join } from 'node:path';
import { computeContentBinding } from '../src/lib/content-binding';
import { ATTACHMENTS_SEALED_META_KEY } from '../src/lib/attachment-resolution';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const EMAIL_09 = 'email-v09-test';
const HAP_PROFILES_REPO = join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

const tool = { namespacedName: 'mail__send_message', inputSchema: { properties: {} } } as unknown as DiscoveredTool;
const send09 = (args: Record<string, unknown>) => computeContentBinding(EMAIL_09, tool, args, 'send');

let contentBinding09: Record<string, unknown> | undefined;

beforeAll(() => {
  try {
    const raw = execFileSync('git', ['-C', HAP_PROFILES_REPO, 'show', 'origin/feat/email-0.9:email/0.9.profile.json'], { encoding: 'utf8' });
    contentBinding09 = (JSON.parse(raw) as { content_binding: Record<string, unknown> }).content_binding;
  } catch (err) {
    console.error(`[test] could not fetch email@0.9's content_binding (no git / no network?) — skipping: ${err}`);
    return;
  }
  registerProfile(EMAIL_09, {
    id: EMAIL_09,
    version: '0.9',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    content_binding: contentBinding09 as never,
  });
}, 15_000);

describe('email@0.9 ships the binding this file assumes', () => {
  it('binds to/cc/subject/body/attachments, requires to+body, scoped to send', () => {
    if (!contentBinding09) return;
    expect(contentBinding09).toEqual({
      version: '2',
      kind: 'jcs',
      fields: ['to', 'cc', 'subject', 'body', 'attachments'],
      required_fields: ['to', 'body'],
      appliesTo: ['send'],
    });
  });
});

describe('computeContentBinding — "attachments" field, item 2', () => {
  it('a plain send (no attachments, no sealed meta) carries no "attachments" key in the bound object', () => {
    if (!contentBinding09) return;
    const bound = send09({ to: ['a@x.com'], body: 'Hello' });
    expect(bound?.boundContent).toMatchObject({ to: ['a@x.com'], body: 'Hello' });
    expect((bound?.boundContent as Record<string, unknown>).attachments).toBeUndefined();
  });

  it('a plain send under 0.9 hashes IDENTICALLY to the same call under 0.5 (no attachments ⇒ the extra declared field changes nothing)', () => {
    if (!contentBinding09) return;
    const EMAIL_05 = 'email-v05-regression-test';
    registerProfile(EMAIL_05, {
      id: EMAIL_05, version: '0.5', description: 'test',
      executionContextSchema: { fields: {} }, requiredGates: [], ttl: { default: 1, max: 1 }, retention_minimum: 1,
      content_binding: { version: '2', kind: 'jcs', fields: ['to', 'cc', 'subject', 'body'], required_fields: ['to', 'body'], appliesTo: ['send'] } as never,
    });
    const args = { to: ['a@x.com'], subject: 'Hi', body: 'Hello' };
    const under09 = send09(args);
    const under05 = computeContentBinding(EMAIL_05, tool, args, 'send');
    expect(under09?.contentHash).toBe(under05?.contentHash);
  });

  it('binds the SEALED fingerprint list — [{filename, sha256}] — never bytes, even when the wire arg of the same name carries them', () => {
    if (!contentBinding09) return;
    const sealed = { attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', sha256: 'abc123', bytes: 48000 }], inserts: [] };
    // Simulates a "field"-transport connector AFTER finalize — the wire arg
    // actually carries embedded bytes under the SAME key name.
    const args = {
      to: ['buchhaltung@drautal.at'], subject: 'Rechnung 2026-0003', body: 'Anbei die Rechnung.',
      attachments: [{ filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', contentBase64: 'SGVsbG8gd29ybGQ=' }],
      [ATTACHMENTS_SEALED_META_KEY]: sealed,
    };
    const bound = send09(args);
    expect(bound?.boundContent).toMatchObject({
      attachments: [{ filename: 'Rechnung-2026-0003.pdf', sha256: 'abc123' }],
    });
    expect(JSON.stringify(bound?.boundContent)).not.toContain('SGVsbG8gd29ybGQ=');
  });

  it('binds the SEALED fingerprint list even when the wire arg is ABSENT (a "mime-raw" connector folds it into `raw`)', () => {
    if (!contentBinding09) return;
    const sealed = { attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'invoice.pdf', contentType: 'application/pdf', sha256: 'def456', bytes: 100 }], inserts: [] };
    const args = {
      to: ['a@x.com'], subject: 'S', body: 'B',
      raw: 'c29tZS1iYXNlNjR1cmwtbWltZQ', // the real downstream payload lives here, not under "attachments"
      [ATTACHMENTS_SEALED_META_KEY]: sealed,
    };
    const bound = send09(args);
    expect(bound?.boundContent).toMatchObject({ attachments: [{ filename: 'invoice.pdf', sha256: 'def456' }] });
  });

  it('changing the sealed fingerprint moves the hash', () => {
    if (!contentBinding09) return;
    const base = { to: ['a@x.com'], subject: 'S', body: 'B' };
    const sealedA = { attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'x.pdf', contentType: 'application/pdf', sha256: 'aaa', bytes: 1 }], inserts: [] };
    const sealedB = { attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'x.pdf', contentType: 'application/pdf', sha256: 'bbb', bytes: 1 }], inserts: [] };
    const boundA = send09({ ...base, [ATTACHMENTS_SEALED_META_KEY]: sealedA });
    const boundB = send09({ ...base, [ATTACHMENTS_SEALED_META_KEY]: sealedB });
    expect(boundA?.contentHash).not.toBe(boundB?.contentHash);
  });

  it('zero sealed attachments (an insert-only call) hashes the same as no sealed meta at all', () => {
    if (!contentBinding09) return;
    const base = { to: ['a@x.com'], body: 'B' };
    const withEmptySealed = send09({ ...base, [ATTACHMENTS_SEALED_META_KEY]: { attachments: [], inserts: [] } });
    const withNoSealed = send09(base);
    expect(withEmptySealed?.contentHash).toBe(withNoSealed?.contentHash);
  });

  it('still refuses (ContentBindingError) when a required field is absent, same as 0.5', () => {
    if (!contentBinding09) return;
    expect(() => send09({ to: ['a@x.com'] })).toThrow(ContentBindingError);
  });
});
