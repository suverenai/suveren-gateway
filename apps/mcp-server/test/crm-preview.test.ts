/**
 * AU3 approval preview for the CRM, against the real content/integrations/crm.json.
 *
 * Writes on a record with a revision (contact, deal, task) declare a version
 * block — the connector itself refuses a stale revision. log_activity,
 * create_deal and create_task read the linked contact without a version, so
 * they get the AU4 fallback (re-read before running; any change → nothing runs).
 *
 * create_task's contact_id is optional: a task without a contact has nothing
 * to preview, and the approval card must show no preview box — not an error.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'node:path';
import { loadManifests, invalidManifestPreviewReason, getManifest } from '../src/lib/manifest-loader';
import { buildInternalPreview, computeSubmissionPreviewHash, getToolPreviewConfig } from '../src/lib/preview';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

beforeAll(() => {
  loadManifests(MANIFESTS_DIR);
});

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', title: 'Contact ID' },
    name: { type: 'string', title: 'Name' },
    company: { type: ['string', 'null'], title: 'Company' },
    type: { type: 'string', title: 'Type' },
    revision: { type: 'number', title: 'Revision' },
  },
};

/** A CRM connector whose contact c-1 is currently at `current`. */
function crm(current = 2) {
  const callTool = vi.fn().mockImplementation(async (_i: string, tool: string, args: Record<string, unknown>) => {
    if (tool !== 'get_contact') return { content: [{ type: 'text', text: 'ok' }] };
    if (args.id !== 'c-1') return { isError: true, content: [{ type: 'text', text: `Contact not found: ${String(args.id)}` }] };
    const revision = args.revision ?? current;
    return {
      content: [{ type: 'text', text: `Contact c-1 r${String(revision)}` }],
      structuredContent: { id: 'c-1', name: 'Maria Huber', company: 'Huber Agrar', type: 'customer', revision },
    };
  });
  const tools = [
    { originalName: 'get_contact', namespacedName: 'crm__get_contact', integrationId: 'crm', description: '', inputSchema: { type: 'object' }, outputSchema: CONTACT_SCHEMA, gating: null },
  ] as unknown as DiscoveredTool[];
  return { im: { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager, callTool };
}

/** A bare manager — enough for getToolPreviewConfig to read the real crm manifest (DL1: it now checks `isBuiltin` first). */
const NOT_BUILTIN = { isBuiltin: () => false } as unknown as IntegrationManager;

describe('crm.json — approval preview', () => {
  it('passes the loader’s preview check', () => {
    expect(invalidManifestPreviewReason(getManifest('crm')!)).toBeNull();
  });

  it('every write on a record with a revision previews that record with a version block', () => {
    const expected: Record<string, string> = {
      update_contact: 'get_contact', delete_contact: 'get_contact', restore_contact: 'get_contact', convert_contact: 'get_contact',
      update_deal: 'get_deal', complete_task: 'get_task',
    };
    for (const [tool, read] of Object.entries(expected)) {
      expect(getToolPreviewConfig(NOT_BUILTIN, 'crm', tool), tool).toMatchObject({
        tool: read, args: { id: 'id', revision: 'revision' }, version: { arg: 'revision', field: 'revision' },
      });
    }
  });

  it('activity, deal and task creation preview the linked contact, without a version', () => {
    for (const tool of ['log_activity', 'create_deal', 'create_task']) {
      const p = getToolPreviewConfig(NOT_BUILTIN, 'crm', tool);
      expect(p, tool).toMatchObject({ tool: 'get_contact', args: { id: 'contact_id' } });
      expect(p!.version, tool).toBeUndefined();
    }
  });

  it('update_contact on an old revision shows stale with the current record', async () => {
    const { im } = crm(3);
    const r = await buildInternalPreview(im, 'crm', 'update_contact', { id: 'c-1', revision: 2, contact_type: 'customer', notes: 'x' });
    expect(r).toMatchObject({ status: 'ok', version: { approved: 2, current: 3, stale: true } });
  });

  // Walkthrough 2026-11-11: an update's card showed the contact as it is, not the
  // change. The card can only show old → new when it knows the read IS the record
  // being changed — the manifest says so by declaring a version on it.
  it('a versioned read is marked as the record the action changes; a linked-contact read is not', async () => {
    const { im } = crm(1);
    const upd = await buildInternalPreview(im, 'crm', 'update_contact', { id: 'c-1', revision: 1, contact_type: 'customer', name: 'Maria Huber-Berger' });
    expect(upd).toMatchObject({ status: 'ok', target: true, versionArg: 'revision', body: { structured: { name: 'Maria Huber' } } });
    expect((upd as { describesProposal?: unknown }).describesProposal).toBeUndefined();
    const act = await buildInternalPreview(im, 'crm', 'create_task', { title: 'Call back', contact_id: 'c-1', contact_type: 'customer' });
    expect(act).toMatchObject({ status: 'ok' });
    expect((act as { target?: unknown }).target).toBeUndefined();
  });

  it('create_task WITH a contact previews that contact', async () => {
    const { im, callTool } = crm();
    const r = await buildInternalPreview(im, 'crm', 'create_task', { title: 'Call back', contact_id: 'c-1', contact_type: 'customer' });
    expect(r).toMatchObject({ status: 'ok', body: { structured: { name: 'Maria Huber' } }, fields: ['name', 'company', 'type'] });
    expect(callTool).toHaveBeenCalledWith('crm', 'get_contact', { id: 'c-1' });
  });

  it('create_task WITHOUT a contact shows no preview — no read, no error card', async () => {
    const { im, callTool } = crm();
    const r = await buildInternalPreview(im, 'crm', 'create_task', { title: 'Order paper', contact_type: 'customer' });
    expect(r).toEqual({ status: 'none', reason: 'no_target' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('create_task WITHOUT a contact takes no AU4 snapshot, so it can run once approved', async () => {
    const { im, callTool } = crm();
    const hash = await computeSubmissionPreviewHash(im, 'crm', 'create_task', { title: 'Order paper', contact_type: 'customer' });
    expect(hash).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
  });
});

// Andreas 2026-11-11: ERP updates must get the same old → new card. Their
// previews are lists of reads; the read that declares `version` is the record
// changed — marked the same way, never by tool name.
describe('erp.json — a versioned read inside a preview list is the target', () => {
  beforeAll(() => { loadManifests(MANIFESTS_DIR); });
  it('update_item_price: the versioned get_item section carries target; an unversioned read does not', async () => {
    const callTool = vi.fn().mockImplementation(async (_i: string, tool: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: tool === 'get_item' ? { id: args.id, name: 'Paper', list_price: 10, vat_rate: 20, revision: 1 } : { duplicates: [] },
    }));
    const tools = ['get_item', 'get_customer', 'check_customer_duplicates'].map((t) => ({ originalName: t, namespacedName: `erp__${t}`, integrationId: 'erp', description: '', inputSchema: { type: 'object' }, gating: null }));
    const im = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
    const r = await buildInternalPreview(im, 'erp', 'update_item_price', { id: 'i-1', revision: 1, list_price: 12 });
    expect(r).toMatchObject({ status: 'ok', reads: [{ tool: 'get_item', attach: 'id', target: true, versionArg: 'revision' }] });
    const c = await buildInternalPreview(im, 'erp', 'update_customer', { id: 'c-1', revision: 1, email: 'a@b.at', crm_contact_id: 'x' });
    const reads = (c as { reads: Array<{ tool: string; target?: true }> }).reads;
    expect(reads.find((s) => s.tool === 'get_customer')?.target).toBe(true);
    expect(reads.find((s) => s.tool === 'check_customer_duplicates')?.target).toBeUndefined();
  });
});
