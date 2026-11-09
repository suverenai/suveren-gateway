/**
 * The shipped Documents manifest loads (the loader refuses a malformed one), its
 * `file` kind is flagged as AI-supplied, the read behind it is internal, and its
 * profile exists with the bound the manifest gates on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifests, getManifest, invalidManifestDocumentsReason } from '../src/lib/manifest-loader';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');

describe('documents manifest', () => {
  beforeAll(() => { loadManifests(join(ROOT, 'content', 'integrations')); });

  it('loads, and offers documents:file as an AI-supplied attachment source', () => {
    const m = getManifest('documents');
    expect(m).toBeDefined();
    expect(m!.documents!.file).toMatchObject({ tool: 'get_document', aiSupplied: true });
    expect(m!.credentials.envMapping).toEqual({ DOCUMENTS_FOLDER: 'sharedFolder' });
  });

  it('refuses a non-boolean aiSupplied and an empty title', () => {
    const base = { toolGating: { overrides: { get_document: { internal: true } } } } as never;
    const doc = (extra: object) => ({ ...(base as object), documents: { file: { tool: 'get_document', args: {}, ...extra } } }) as never;
    expect(invalidManifestDocumentsReason(doc({ aiSupplied: 'yes' }))).toMatch(/aiSupplied/);
    expect(invalidManifestDocumentsReason(doc({ title: '' }))).toMatch(/title/);
    expect(invalidManifestDocumentsReason(doc({ aiSupplied: true, title: 'a', description: 'b' }))).toBeNull();
  });

  it('gates the tools on bounds the documents profile declares', () => {
    const file = join(PROFILES_DIR, 'documents', '0.1.profile.json');
    expect(existsSync(file), `profile not found at ${file}`).toBe(true);
    const fields = JSON.parse(readFileSync(file, 'utf8')).boundsSchema.fields;
    const o = getManifest('documents')!.toolGating!.overrides as Record<string, any>;
    expect(fields[o.list_documents.boundField]).toBeDefined();
    expect(fields.save_daily_max.appliesTo).toContain(o.save_document.staticExecution.action_type);
    expect(o.get_document.internal).toBe(true);
  });
});
