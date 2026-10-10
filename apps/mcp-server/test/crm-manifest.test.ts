/**
 * The CRM manifest after revisions (hap-crm-mcp feat/crm-revisions): a write on a
 * contact declares the contact type it acts on — the gatekeeper checks the
 * declaration against the mandate's scope, the connector checks it against the
 * record's real type. Before, every write carried a fixed "customer" from the
 * manifest, so a "customers only" mandate also covered leads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const crm = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'crm.json'), 'utf8'));
const o = crm.toolGating.overrides as Record<string, { executionMapping?: Record<string, string>; staticExecution?: Record<string, string>; category?: string }>;

describe('crm.json — the contact type is declared per call, not fixed', () => {
  it('writes on a contact map contact_type from the call and carry no fixed value', () => {
    for (const t of ['create_contact', 'update_contact', 'delete_contact', 'restore_contact', 'convert_contact', 'log_activity', 'create_deal', 'update_deal', 'create_task', 'complete_task']) {
      const g = o[t];
      expect(g, t).toBeDefined();
      expect(Object.values(g.executionMapping ?? {}), t).toContain('contact_type');
      expect(g.staticExecution?.contact_type, t).toBeUndefined();
    }
    expect(crm.toolGating.default.staticExecution.contact_type).toBeUndefined();
  });
  it('archive and restore share the delete action type; convert is a write', () => {
    expect(o.delete_contact.staticExecution?.action_type).toBe('delete');
    expect(o.restore_contact.staticExecution?.action_type).toBe('delete');
    expect(o.convert_contact.staticExecution?.action_type).toBe('write');
  });
  it('the reads by id are read tools under read_access', () => {
    for (const t of ['get_contact', 'get_deal', 'get_task']) expect(o[t]).toMatchObject({ category: 'read', boundField: 'read_access', requiredValue: 'unlimited' });
  });
});
