/**
 * The shipped Files manifest loads (the loader refuses a malformed one), its
 * `file` kind is flagged as AI-supplied, the read behind it is internal, and its
 * profile exists with the bound the manifest gates on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import { loadManifests, getManifest, invalidManifestDocumentsReason, invalidManifestAttachmentsReason } from '../src/lib/manifest-loader';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');

describe('files manifest', () => {
  beforeAll(() => { loadManifests(join(ROOT, 'content', 'integrations')); });

  it('loads, and offers files:file as an AI-supplied attachment source', () => {
    const m = getManifest('files');
    expect(m).toBeDefined();
    expect(m!.documents!.file).toMatchObject({ tool: 'get_file', aiSupplied: true });
    expect(m!.credentials.envMapping).toEqual({ FILES_FOLDER: 'sharedFolder' });
  });

  it('refuses a non-boolean aiSupplied and an empty title', () => {
    const base = { toolGating: { overrides: { get_file: { internal: true } } } } as never;
    const doc = (extra: object) => ({ ...(base as object), documents: { file: { tool: 'get_file', args: {}, ...extra } } }) as never;
    expect(invalidManifestDocumentsReason(doc({ aiSupplied: 'yes' }))).toMatch(/aiSupplied/);
    expect(invalidManifestDocumentsReason(doc({ title: '' }))).toMatch(/title/);
    expect(invalidManifestDocumentsReason(doc({ aiSupplied: true, title: 'a', description: 'b' }))).toBeNull();
  });

  it('runs with simulation mode on and off (it touches only this computer)', () => {
    const im = new IntegrationManager(new Map());
    const prev = process.env.SUVEREN_SIMULATION;
    try {
      process.env.SUVEREN_SIMULATION = '1';
      expect(im.modeBlock('files')).toBeUndefined();
      expect(im.isSimulationSafe('files')).toBe(true);
      // A real system stays blocked in simulation mode: the rule did not loosen for others.
      expect(im.modeBlock('records')).toBe('simulation');
      delete process.env.SUVEREN_SIMULATION;
      expect(im.modeBlock('files')).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SUVEREN_SIMULATION; else process.env.SUVEREN_SIMULATION = prev;
    }
  });

  it('gates the tools on bounds the files profile declares', () => {
    const file = join(PROFILES_DIR, 'files', '0.1.profile.json');
    expect(existsSync(file), `profile not found at ${file}`).toBe(true);
    const fields = JSON.parse(readFileSync(file, 'utf8')).boundsSchema.fields;
    const o = getManifest('files')!.toolGating!.overrides as Record<string, any>;
    expect(fields[o.list_files.boundField]).toBeDefined();
    expect(fields.save_daily_max.appliesTo).toContain(o.save_file.staticExecution.action_type);
    expect(o.get_file.internal).toBe(true);
  });
});

describe('maxAttachmentBytes', () => {
  beforeAll(() => { loadManifests(join(ROOT, 'content', 'integrations')); });
  const manifest = (overrides: object) => ({ attachments: { transport: 'field', arg: 'attachments' }, toolGating: { overrides } }) as never;

  it('the shipped email tool declares 18,000,000 bytes', () => {
    const o = getManifest('mail')!.toolGating!.overrides as Record<string, any>;
    expect(o.send_message.attachmentsArg).toBe('attachments');
    expect(o.send_message.maxAttachmentBytes).toBe(18_000_000);
  });

  it('every shipped tool that takes attachments declares a limit', () => {
    for (const id of ['mail']) {
      const o = getManifest(id)!.toolGating!.overrides as Record<string, any>;
      for (const entry of Object.values(o)) {
        if (entry?.attachmentsArg) expect(entry.maxAttachmentBytes).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a manifest whose tool takes attachments with no limit (fail closed, no default)', () => {
    expect(invalidManifestAttachmentsReason(manifest({ send: { attachmentsArg: 'attachments' } }))).toMatch(/maxAttachmentBytes/);
  });

  it.each([[0], [-1], [1.5], ['18000000'], [null]])('refuses a limit of %j', (value) => {
    expect(invalidManifestAttachmentsReason(manifest({ send: { attachmentsArg: 'attachments', maxAttachmentBytes: value } }))).toMatch(/maxAttachmentBytes/);
  });

  it('refuses a limit on a tool that takes no attachments', () => {
    expect(invalidManifestAttachmentsReason(manifest({ send: { maxAttachmentBytes: 100 } }))).toMatch(/without "attachmentsArg"/);
  });

  it('accepts a declared positive whole number', () => {
    expect(invalidManifestAttachmentsReason(manifest({ send: { attachmentsArg: 'attachments', maxAttachmentBytes: 100 } }))).toBeNull();
  });
});
