/**
 * The `report` built-in (see ../builtin-integration.ts) — gives the user's own
 * AI the tools to read the evidence a gateway holds and write one
 * evidence-backed report, governed by the `reporting` profile (work-plan
 * "Added 2026-10-05 — evidence-backed reports", steps R2 + R4).
 *
 * Read tools (`list_tickets`, `get_ticket`, `list_cases`, `get_records`) are
 * gated `category: 'read'` against `read_access: unlimited` — the generic read
 * gate in tool-proxy.ts refuses them outright without a matching authorization,
 * the same mechanism every connector's read tools use. None declares
 * `hideUnlessAuthorized`: unlike a setup-only action, a reporting agent should
 * see these tools exist even before it has been granted a mandate, so a
 * missing mandate reads as "refused", never as "this capability does not
 * exist" (`createGatedToolHandler`'s read-gate denial already says why).
 *
 * `write_report` is a write tool gated like any other: `staticExecution: {
 * action_type: 'report' }` maps onto the profile's `report_daily_max`
 * cumulative bound, so the Authority Server enforces how many times per day
 * the report may be replaced, the same receipt-precondition path a connector's
 * write tool goes through (ticket requested pre-flight, `receipt_id` injected
 * via the declared input-schema property — see content-binding.ts).
 *
 * All four tools reuse the SAME resolvers `verify-report.ts` uses to check a
 * placed `sv-*` element (`ticket-resolvers.ts`, `ticket-details.ts`) and the
 * same `ReportSources` (`archive` + `runExport`) the gateway's own
 * `/internal/report` route and `ReportStore` use — no second copy of "what a
 * ticket/case/record looks like".
 *
 * `reference_replies` (the people's actual reference answers — see
 * hap-email-mcp's `cli.ts`: "must never be reachable through any tool call")
 * is excluded by construction in `list_cases`/`get_records`: neither handler
 * ever reads that key off the raw export, and `EMAIL_RECORD_KINDS` below does
 * not list it, so there is no code path that could forward it to the agent.
 */
import { REPORT_BRIEF } from '../report-brief';
import { builtinText, type BuiltinIntegration, type BuiltinTool } from '../builtin-integration';
import {
  buildTicketDetails,
  isEmailExport, isErpExport, isCrmExport,
  type EmailExport, type ErpExport, type CrmExport, type ExportSystem,
  type VerifyReportResult,
} from '../report';
import type { BuiltinDeps, BuiltinFactory } from './index';

/** Refused above this size, before anything is sanitized or verified — the
 *  plan's "size cap (e.g. 512 KB)". Checked on the RAW bytes the AI sent, so
 *  an oversize report never reaches sanitize/verify at all. */
export const MAX_REPORT_HTML_BYTES = 512 * 1024;

const READ_GATE = { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' };

// Tables each simulator's `export` CLI exposes that are safe to hand to the
// report-writing agent as `sv-record` references. Deliberately closed lists —
// adding a system key here is how a future connector's export would be opted
// IN, not something that falls out of spreading the raw export object.
const EMAIL_RECORD_KINDS = ['inbox', 'sent', 'changes', 'refusals'] as const;
const ERP_RECORD_KINDS = ['quotes', 'orders', 'changes', 'refusals'] as const;
const CRM_RECORD_KINDS = ['contacts', 'deals', 'tasks', 'activities', 'changes', 'refusals'] as const;

function errorText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function listTicketsTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'list_tickets',
    description:
      'List tickets (signed executions) from the local receipt archive: id, time, action, action type, ' +
      'profile, authorizationId, the limits used, and whether an approval was archived for it. ' +
      'Optionally filter by since/until (unix seconds). Use the ids with get_ticket for full detail, ' +
      'and with <sv-ticket>, <sv-approval>, <sv-mandate> and <sv-case> in the report.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only tickets timestamped at or after this unix-seconds value.' },
        until: { type: 'number', description: 'Only tickets timestamped at or before this unix-seconds value.' },
      },
    },
    handler: async (args) => {
      const since = typeof args.since === 'number' ? args.since : undefined;
      const until = typeof args.until === 'number' ? args.until : undefined;
      const tickets = deps.reportSources.archive.getReceipts()
        .map((entry) => {
          const r = entry.receipt as Record<string, unknown>;
          const time = typeof r.timestamp === 'number' ? r.timestamp : undefined;
          return {
            id: typeof r.id === 'string' ? r.id : String(r.id ?? ''),
            time,
            action: r.action,
            actionType: r.actionType ?? null,
            profile: r.profileId,
            authorizationId: r.authorizationId,
            limitsUsed: r.limits ?? r.executionContext ?? {},
            hasApproval: Boolean(entry.proposal),
          };
        })
        .filter((t) => t.id !== '')
        .filter((t) => since === undefined || (t.time !== undefined && t.time >= since))
        .filter((t) => until === undefined || (t.time !== undefined && t.time <= until))
        .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      return builtinText(JSON.stringify({ tickets }, null, 2));
    },
  };
}

function getTicketTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'get_ticket',
    description:
      'Full detail for one ticket: the ticket itself (action, time, limits used, public-check link), ' +
      'its archived approval (who approved it, when it was requested and decided, how long it waited), ' +
      'and the mandate it ran under (limits, commitment mode, intent). Each part reports "unverifiable" ' +
      'on its own if it could not be checked — e.g. an automatic-mode ticket has no approval. Use this ' +
      'to decide what a ticket actually proves before referencing it in the report.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The ticket id, as listed by list_tickets.' } },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return errorText('id is required.');
      const details = await buildTicketDetails(deps.reportSources.archive, [id]);
      const detail = details[id];
      if (!detail || detail.ticket.status !== 'verified') {
        return errorText(detail?.ticket.reason ?? `No ticket "${id}" in the local archive.`);
      }
      return builtinText(JSON.stringify({
        ticket: detail.ticket.data,
        approval: detail.approval.status === 'verified'
          ? { verified: true, ...detail.approval.data }
          : { verified: false, reason: detail.approval.reason },
        mandate: detail.mandate.status === 'verified'
          ? { verified: true, ...detail.mandate.data }
          : { verified: false, reason: detail.mandate.reason },
      }, null, 2));
    },
  };
}

function listCasesTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'list_cases',
    description:
      'Loaded business cases from the email simulator, plus every sent mail — so you can define sv-case ' +
      'elements without guessing ids. Returns: when the test package was loaded (simulationLoadedAt); ' +
      'cases (caseId, the starting inbox message id, sender, subject, received time); and sent mails ' +
      '(id, inReplyTo, the receiptId of the ticket that sent it, subject, sentAt) so you can confirm which ' +
      'ticket closed which case. Never includes the team\'s own reference replies — those are not part of ' +
      'this report.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      let exported: unknown;
      try {
        exported = await deps.reportSources.runExport('email');
      } catch (err) {
        return errorText(`Could not read the email simulator export: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isEmailExport(exported)) return errorText('The email simulator export had an unexpected shape.');
      const exp: EmailExport = exported;
      const cases = exp.inbox
        .filter((m) => !!m.case_id)
        .map((m) => ({
          caseId: m.case_id,
          startMessageId: m.id,
          from: m.from_email,
          subject: m.subject,
          receivedAt: m.received_at,
        }));
      const sent = exp.sent.map((m) => ({
        id: m.id,
        inReplyTo: m.in_reply_to ?? null,
        receiptId: m.receipt_id ?? null,
        subject: m.subject,
        sentAt: m.received_at,
      }));
      return builtinText(JSON.stringify({
        simulationLoadedAt: exp.simulation_load?.loaded_at ?? null,
        cases,
        sent,
      }, null, 2));
    },
  };
}

function recordKindsFor(system: ExportSystem): readonly string[] {
  if (system === 'email') return EMAIL_RECORD_KINDS;
  if (system === 'erp') return ERP_RECORD_KINDS;
  return CRM_RECORD_KINDS;
}

function getRecordsTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'get_records',
    description:
      'Rows from one simulator\'s export (email, erp or crm) that you may reference with <sv-record system="..." ref="...">. ' +
      'Optionally narrow to one table via "kind" (email: inbox/sent/changes/refusals; erp: quotes/orders/changes/refusals; ' +
      'crm: contacts/deals/tasks/activities/changes/refusals) — omit it to get every table for that system. ' +
      'Never returns the team\'s own reference replies.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', enum: ['email', 'erp', 'crm'] },
        kind: { type: 'string', description: 'Optional: one table name within the system\'s export.' },
      },
      required: ['system'],
    },
    handler: async (args) => {
      const system = args.system;
      if (system !== 'email' && system !== 'erp' && system !== 'crm') {
        return errorText('system must be one of "email", "erp", "crm".');
      }
      let exported: unknown;
      try {
        exported = await deps.reportSources.runExport(system);
      } catch (err) {
        return errorText(`Could not read the ${system} simulator export: ${err instanceof Error ? err.message : String(err)}`);
      }
      const ok = system === 'email' ? isEmailExport(exported) : system === 'erp' ? isErpExport(exported) : isCrmExport(exported);
      if (!ok) return errorText(`The ${system} simulator export had an unexpected shape.`);

      const allowedKinds = recordKindsFor(system);
      const requestedKind = typeof args.kind === 'string' ? args.kind : undefined;
      if (requestedKind && !allowedKinds.includes(requestedKind)) {
        return errorText(`kind must be one of ${allowedKinds.join(', ')} for system "${system}".`);
      }
      const kinds = requestedKind ? [requestedKind] : allowedKinds;
      const records: Record<string, unknown[]> = {};
      // Indexing by an allow-listed kind name only — reference_replies is not
      // in any allowedKinds list above, so it can never be selected here even
      // if a future export shape adds more tables to the raw JSON.
      const exp = exported as unknown as EmailExport | ErpExport | CrmExport;
      for (const kind of kinds) {
        records[kind] = (exp as unknown as Record<string, unknown[]>)[kind] ?? [];
      }
      return builtinText(JSON.stringify({ system, records }, null, 2));
    },
  };
}

function summarizeWrite(result: VerifyReportResult): string {
  const verified = result.elements.filter((e) => e.status === 'verified');
  const warnings = result.elements.filter((e) => e.status === 'warning');
  const unverifiable = result.elements.filter((e) => e.status === 'unverifiable');
  const lines: string[] = [];
  lines.push(
    `Report stored. ${verified.length} element(s) verified, ${warnings.length} warning(s), ` +
    `${unverifiable.length} not verifiable.`,
  );
  if (warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of warnings) lines.push(`  - ${w.kind} (${w.id}): ${w.reason ?? 'unspecified'}`);
  }
  if (unverifiable.length > 0) {
    lines.push('Not verifiable — fix these references and write again:');
    for (const u of unverifiable) lines.push(`  - ${u.kind} (${u.id}): ${u.reason ?? 'unspecified'}`);
  }
  const cov = result.coverage;
  if (cov.emailExportError) {
    lines.push(`Coverage could not be checked: ${cov.emailExportError}`);
  } else {
    lines.push(`Coverage: ${cov.coveredCases.length} of ${cov.loadedCases.length} loaded case(s) covered.`);
    if (cov.missingCases.length > 0) lines.push(`Missing cases (not defined with sv-case): ${cov.missingCases.join(', ')}`);
    if (cov.ticketsNotReferenced.length > 0) {
      lines.push(`Tickets from the test period not referenced anywhere in the report: ${cov.ticketsNotReferenced.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function writeReportTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'write_report',
    // The brief IS the description — this is how it reaches the AI (R3/R4 plan,
    // the same pattern mail.json's load_simulation uses for its package guide).
    description: REPORT_BRIEF,
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The full report HTML — see the tool description for how to write it.' },
        receipt_id: { type: 'string' },
      },
      required: ['html'],
    },
    handler: async (args) => {
      const html = typeof args.html === 'string' ? args.html : '';
      if (!html.trim()) return errorText('html is required and must be a non-empty string.');
      const bytes = Buffer.byteLength(html, 'utf8');
      if (bytes > MAX_REPORT_HTML_BYTES) {
        return errorText(
          `This report is ${bytes} bytes, over the ${MAX_REPORT_HTML_BYTES}-byte limit. ` +
          `Shorten it (the gateway draws the verifiable elements for you — you do not need to inline ` +
          `their data) and write again.`,
        );
      }
      if (deps.state.reportStore.isLocked()) {
        return errorText('The report store is locked (the vault is not unlocked) — cannot save a report right now.');
      }
      try {
        const stored = await deps.state.reportStore.saveReport(html, deps.reportSources);
        return builtinText(summarizeWrite(stored.result));
      } catch (err) {
        return errorText(`Could not verify and store the report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export const reportBuiltin: BuiltinFactory = (deps) => ({
  id: 'report',
  name: 'Report',
  // Short name — matches the real registration in profile-loader.ts (full id
  // AND short name both registered); profileMatches() accepts either.
  profile: 'reporting',
  // Touches no real system (reads the local archive + each simulator's own
  // read-only export CLI; writes only the local, vault-encrypted report file)
  // — safe during a simulation-mode test.
  simulation: true,
  toolGating: {
    overrides: {
      list_tickets: READ_GATE,
      get_ticket: READ_GATE,
      list_cases: READ_GATE,
      get_records: READ_GATE,
      write_report: { executionMapping: {}, staticExecution: { action_type: 'report' } },
    },
  } as unknown as BuiltinIntegration['toolGating'],
  tools: [
    listTicketsTool(deps),
    getTicketTool(deps),
    listCasesTool(deps),
    getRecordsTool(deps),
    writeReportTool(deps),
  ],
});
