/**
 * Resolves `sv-record system="email|crm|erp" ref="RECORD_ID"` against each
 * simulator's own `export` (connector-export.ts). "for changes the causing
 * ticket" (plan): when `ref` names a row in the connector's own `changes`
 * table rather than a primary record, the resolved data carries the
 * `receipt_id` that produced it, which is exactly what that table exists for
 * (see each connector's `db.ts` comment: "the effect each ticket produced").
 */
import type { CrmExport, EmailExport, ErpExport, ExportSystem } from './types';

export interface RecordLookupResult {
  status: 'verified' | 'unverifiable';
  reason?: string;
  data?: Record<string, unknown>;
}

function findById<T extends { id: string }>(rows: T[], id: string): T | undefined {
  return rows.find(r => r.id === id);
}

export function resolveEmailRecord(exportData: EmailExport, ref: string): RecordLookupResult {
  const inInbox = findById(exportData.inbox, ref);
  if (inInbox) return { status: 'verified', data: { kind: 'message', folder: 'inbox', ...inInbox } };
  const inSent = findById(exportData.sent, ref);
  if (inSent) return { status: 'verified', data: { kind: 'message', folder: 'sent', ...inSent } };
  const change = findById(exportData.changes, ref);
  if (change) return { status: 'verified', data: { kind: 'change', causingReceiptId: change.receipt_id ?? null, ...change } };
  const refusal = findById(exportData.refusals, ref);
  if (refusal) return { status: 'verified', data: { kind: 'refusal', ...refusal } };
  return { status: 'unverifiable', reason: `No email record "${ref}" in the simulator export.` };
}

export function resolveErpRecord(exportData: ErpExport, ref: string): RecordLookupResult {
  const quote = findById(exportData.quotes, ref) ?? exportData.quotes.find(q => q.number === ref);
  if (quote) return { status: 'verified', data: { kind: 'quote', ...quote } };
  const order = findById(exportData.orders, ref) ?? exportData.orders.find(o => o.number === ref);
  if (order) return { status: 'verified', data: { kind: 'order', ...order } };
  const change = findById(exportData.changes, ref);
  if (change) return { status: 'verified', data: { kind: 'change', causingReceiptId: change.receipt_id ?? null, ...change } };
  const refusal = findById(exportData.refusals, ref);
  if (refusal) return { status: 'verified', data: { kind: 'refusal', ...refusal } };
  return { status: 'unverifiable', reason: `No ERP record "${ref}" in the simulator export.` };
}

export function resolveCrmRecord(exportData: CrmExport, ref: string): RecordLookupResult {
  for (const [kind, rows] of [
    ['contact', exportData.contacts],
    ['deal', exportData.deals],
    ['task', exportData.tasks],
    ['activity', exportData.activities],
  ] as const) {
    const row = findById(rows, ref);
    if (row) return { status: 'verified', data: { kind, ...row } };
  }
  const change = findById(exportData.changes, ref);
  if (change) return { status: 'verified', data: { kind: 'change', causingReceiptId: change.receipt_id ?? null, ...change } };
  const refusal = findById(exportData.refusals, ref);
  if (refusal) return { status: 'verified', data: { kind: 'refusal', ...refusal } };
  return { status: 'unverifiable', reason: `No CRM record "${ref}" in the simulator export.` };
}

export function resolveRecord(system: ExportSystem, exportData: unknown, ref: string): RecordLookupResult {
  if (system === 'email') return resolveEmailRecord(exportData as EmailExport, ref);
  if (system === 'erp') return resolveErpRecord(exportData as ErpExport, ref);
  return resolveCrmRecord(exportData as CrmExport, ref);
}
