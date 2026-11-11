/**
 * The attachment-source field on the web page: recognised by its declared
 * format (`connector:kind`), never by its name. A made-up profile calls it
 * `may_include_documents`; the selector's lines, the approval lines and the
 * change card must read it exactly as they read email@0.9's field — including
 * the card's "empty means nothing" sentence, whose rule comes from
 * @hap/core/scope-rules through computeMandateDiff.
 */
import { describe, it, expect } from 'vitest';
import { computeMandateDiff, type ChangeProfile } from '@hap/core/mandate-change';
import type { AgentProfile } from '@hap/core';
import { isAttachmentSourceField, type SourceManifestLike } from './attachment-sources';
import { formatScopeFieldValue } from './scope-labels';
import { profileFieldLines } from './approval-view';
import { rowLabel, rowMeaning } from './mandate-change-view';

const FIELD = 'may_include_documents';
const DEF = { displayName: 'Documents it may include', format: 'connector:kind', constraint: { enforceable: ['subset'] } };
const PROFILE = { id: 'example.org/test/hap-profiles/bulletin@0.1', scopeSchema: { keyOrder: [FIELD], fields: { [FIELD]: DEF } } };
const DOCS: SourceManifestLike = { id: 'files', name: 'Files', documents: { file: { label: 'saved file {id}', title: 'Saved files' } } };

const side = (scope: Record<string, string>) => ({
  profile: PROFILE as unknown as ChangeProfile, bounds: {}, scope, intent: 'Why.', mode: 'review', expiresAt: 1000,
});

describe('a connector:kind field under another name', () => {
  it('is shown as document sources wherever a scope value is shown', () => {
    expect(isAttachmentSourceField(DEF)).toBe(true);
    expect(formatScopeFieldValue(FIELD, 'files:file', DEF, [DOCS])).toBe('Saved files');
    expect(formatScopeFieldValue(FIELD, '', DEF, [DOCS])).toBe('None: text only');
    expect(profileFieldLines({ [FIELD]: 'files:file' }, PROFILE as unknown as AgentProfile, 'scope', [DOCS])[0].value).toBe('Saved files');
  });

  it('the change card names it as the form does and says that empty means text only', () => {
    const drop = computeMandateDiff({ before: side({ [FIELD]: 'files:file' }), after: side({}) }).rows.find((r) => r.field === FIELD)!;
    expect(drop.tag).toBe('Less');
    expect(rowLabel(drop)).toBe('What the AI may attach');
    expect(rowMeaning(drop, [DOCS])).toBe('From now on, emails under this mandate carry text only.');
    const add = computeMandateDiff({ before: side({}), after: side({ [FIELD]: 'files:file' }) }).rows.find((r) => r.field === FIELD)!;
    expect(add.tag).toBe('More');
    expect(rowMeaning(add, [DOCS])).toBe('From now on, emails under this mandate may also carry: Saved files.');
  });
});
