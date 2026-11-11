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
 * `hideUnlessAuthorized`: that flag is for a tool that stays invisible even
 * WITH a matching mandate, until a specific per-action bound is above zero
 * (the `setup` built-in's own case). These five need no such extra check —
 * the group declares `alwaysListed` (since 0.31.1): `report__*` is in
 * `tools/list` with or without a reporting mandate, like connector tools, and
 * the gate refuses a call without one; see builtins-report.test.ts's
 * "tools/list visibility" suite (real MCP server wiring).
 *
 * `write_report` is a write tool gated like any other: `staticExecution: {
 * action_type: 'report' }` maps onto the profile's `report_daily_max`
 * cumulative bound, so the Authority Server enforces how many times per day
 * the report may be replaced, the same ticket-precondition path a connector's
 * write tool goes through (ticket requested pre-flight, `ticket_id` injected
 * via the declared input-schema property — see content-binding.ts).
 *
 * All four tools reuse the SAME resolvers `verify-report.ts` uses to check a
 * placed `sv-*` element (`ticket-resolvers.ts`, `ticket-details.ts`) and the
 * same `ReportSources` (`archive` + `runExport`) the gateway's own
 * `/internal/report` route and `ReportStore` use — no second copy of "what a
 * ticket/case/record looks like".
 *
 * Every tool reads through sources scoped to the REPORTING WINDOW the active
 * reporting mandate sets (`report/window.ts`, work-plan "regular reporting"
 * RR2): a ticket or record from before it is not listed, cannot be opened,
 * and a report reference to it renders "not verifiable — outside the reporting
 * window". What the tools return about a ticket is an allow-list
 * (`report/agent-view.ts`, RR3): what a working agent sees about its own
 * mandates plus approval facts — never user/group/mandate ids, signatures,
 * attestation blobs or owner DIDs.
 *
 * `reference_replies` (the people's actual reference answers — see
 * hap-email-mcp's `cli.ts`: "must never be reachable through any tool call")
 * is excluded by construction in `list_cases`/`get_records`: neither handler
 * ever reads that key off the raw export, and no manifest's `report.tables`
 * lists it (only declared tables are ever shown), so there is no code path
 * that could forward it to the agent.
 *
 * Which systems there are, their tables and how their export is checked come
 * from the connectors' manifests (`report`, report/systems.ts): this file
 * names no system.
 */
import { reportBrief } from '../report-brief';
import { builtinText, type BuiltinIntegration, type BuiltinTool } from '../builtin-integration';
import {
  buildTicketDetails, glossaryUsage,
  isCaseSourceExport, profileShortLabel,
  type CaseSourceExport,
  type VerifyReportResult,
} from '../report';
import { reportSystems, reportSystem, caseSystem, recordKinds, isSystemExport, capitalLabel, type ReportSystem } from '../report/systems';
import { scopeReportSources, reportingMandateRefusal, REPORTING_PROFILE, type ScopeResolution, type ReportWindow } from '../report/window';
import { readSwitchGate } from './read-switch';
import { agentTicketRow, agentTicket, agentApproval, agentMandate } from '../report/agent-view';
import { isSimulationMode } from '../simulation-mode';
import { sanitizeReport } from '../report/sanitize';
import type { BuiltinDeps, BuiltinFactory } from './index';

/** Refused above this size, before anything is sanitized or verified — the
 *  plan's "size cap (e.g. 512 KB)". Checked on the RAW bytes the AI sent, so
 *  an oversize report never reaches sanitize/verify at all. */
export const MAX_REPORT_HTML_BYTES = 512 * 1024;

// The tables each system's `export` CLI exposes that are safe to hand to the
// report-writing agent as `sv-record` references are the ones its manifest
// declares (`report.tables`) — a closed list per connector: a table opts IN by
// being declared, never by appearing in the raw export object.

function errorText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/**
 * Every tool reads through sources scoped to the reporting window the active
 * reporting mandate sets (report/window.ts, RR2) — resolved per call, so a new,
 * changed or expired mandate applies to the very next read.
 */
function scope(deps: BuiltinDeps): Promise<ScopeResolution> {
  return scopeReportSources(deps.reportSources, {
    authorizations: deps.state.getEnrichedAuthorizations(),
    simulation: isSimulationMode(),
  });
}

function windowInfo(w: ReportWindow) {
  return { since: w.label, start: w.start, end: w.end };
}

function listTicketsTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'list_tickets',
    description:
      'List tickets (signed executions) from the local receipt archive inside your reporting window ' +
      '(the number of days back your reporting mandate allows): id, time, action, action type, ' +
      'profile, the limits used, and whether an approval was archived for it. Older tickets are not ' +
      'shown and cannot be used in the report. Optionally narrow further by since/until (unix seconds). ' +
      'Use the ids with get_ticket for full detail, and with <sv-ticket>, <sv-approval>, <sv-mandate> ' +
      'and <sv-case> in the report.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only tickets timestamped at or after this unix-seconds value.' },
        until: { type: 'number', description: 'Only tickets timestamped at or before this unix-seconds value.' },
      },
    },
    handler: async (args) => {
      const scoped = await scope(deps);
      if (!scoped.ok) return errorText(scoped.reason);
      const since = typeof args.since === 'number' ? args.since : undefined;
      const until = typeof args.until === 'number' ? args.until : undefined;
      const tickets = scoped.sources.archive.getReceipts()
        .map((entry) => {
          const r = entry.receipt as Record<string, unknown>;
          return agentTicketRow(r, Boolean(entry.proposal), profileShortLabel(typeof r.profileId === 'string' ? r.profileId : undefined));
        })
        .filter((t) => t.id !== '')
        .filter((t) => since === undefined || (typeof t.time === 'number' && t.time >= since))
        .filter((t) => until === undefined || (typeof t.time === 'number' && t.time <= until))
        .sort((a, b) => ((a.time as number | undefined) ?? 0) - ((b.time as number | undefined) ?? 0));
      return builtinText(JSON.stringify({ window: windowInfo(scoped.window), tickets }, null, 2));
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
      'on its own if it could not be checked — e.g. an automatic-mode ticket has no approval. Only tickets ' +
      'inside your reporting window can be opened. Use this to decide what a ticket actually proves before ' +
      'referencing it in the report.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The ticket id, as listed by list_tickets.' } },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return errorText('id is required.');
      const scoped = await scope(deps);
      if (!scoped.ok) return errorText(scoped.reason);
      const details = await buildTicketDetails(scoped.sources.archive, [id]);
      const detail = details[id];
      if (!detail || detail.ticket.status !== 'verified') {
        return errorText(detail?.ticket.reason ?? `No ticket "${id}" in the local archive.`);
      }
      // Allow-listed projections (report/agent-view.ts, RR3): no user/group/
      // mandate ids, no signatures, no attestation blobs, no owner DIDs.
      return builtinText(JSON.stringify({
        ticket: agentTicket(detail.ticket.data),
        approval: detail.approval.status === 'verified'
          ? { verified: true, ...agentApproval(detail.approval.data) }
          : { verified: false, reason: detail.approval.reason },
        mandate: detail.mandate.status === 'verified'
          ? { verified: true, ...agentMandate(detail.mandate.data) }
          : { verified: false, reason: detail.mandate.reason },
      }, null, 2));
    },
  };
}

function listCasesTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'list_cases',
    description:
      'Loaded business cases from the connected email system, plus every sent mail — so you can define ' +
      'sv-case elements without guessing ids. Returns: when the test data was loaded (testDataLoadedAt); ' +
      'cases (caseId, the starting inbox message id, sender, subject, received time); and sent mails ' +
      '(id, inReplyTo, the receiptId of the ticket that sent it, subject, sentAt) so you can confirm which ' +
      'ticket closed which case. Only records inside your reporting window. Never includes the team\'s own ' +
      'reference replies — those are not part of this report.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const scoped = await scope(deps);
      if (!scoped.ok) return errorText(scoped.reason);
      const source = caseSystem();
      if (!source) return errorText('No connected system holds the loaded cases.');
      let exported: unknown;
      try {
        exported = await scoped.sources.runExport(source.system);
      } catch (err) {
        return errorText(`Could not read ${source.label} records: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isSystemExport(source, exported) || !isCaseSourceExport(exported)) {
        return errorText(`${capitalLabel(source)} records were returned in an unexpected shape.`);
      }
      const exp: CaseSourceExport = exported;
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
        window: windowInfo(scoped.window),
        testDataLoadedAt: exp.simulation_load?.loaded_at ?? null,
        cases,
        sent,
      }, null, 2));
    },
  };
}

/** "a, b or c" */
function orList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** get_records' description, from the declared systems and their tables. */
export function getRecordsDescription(systems: ReportSystem[]): string {
  return (
    `Rows from one connected system (${orList(systems.map(s => s.system))}) that you may reference with <sv-record system="..." ref="...">. ` +
    `Optionally narrow to one table via "kind" (${systems.map(s => `${s.system}: ${recordKinds(s).join('/')}`).join('; ')}) — omit it to get every table for that system. ` +
    'Only rows inside your reporting window. Never returns the team\'s own reference replies.'
  );
}

function getRecordsTool(deps: BuiltinDeps): BuiltinTool {
  const systems = reportSystems();
  return {
    name: 'get_records',
    description: getRecordsDescription(systems),
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', enum: systems.map(s => s.system) },
        kind: { type: 'string', description: 'Optional: one table name within that system\'s records.' },
      },
      required: ['system'],
    },
    handler: async (args) => {
      const declared = reportSystem(args.system);
      if (!declared) {
        return errorText(`system must be one of ${reportSystems().map(s => `"${s.system}"`).join(', ')}.`);
      }
      const system = declared.system;
      const scoped = await scope(deps);
      if (!scoped.ok) return errorText(scoped.reason);
      let exported: unknown;
      try {
        exported = await scoped.sources.runExport(system);
      } catch (err) {
        return errorText(`Could not read ${system} records: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isSystemExport(declared, exported)) return errorText(`${system} records were returned in an unexpected shape.`);

      const allowedKinds = recordKinds(declared);
      const requestedKind = typeof args.kind === 'string' ? args.kind : undefined;
      if (requestedKind && !allowedKinds.includes(requestedKind)) {
        return errorText(`kind must be one of ${allowedKinds.join(', ')} for system "${system}".`);
      }
      const kinds = requestedKind ? [requestedKind] : allowedKinds;
      const records: Record<string, unknown[]> = {};
      // Indexing by a declared kind name only — reference_replies is not in
      // any manifest's tables, so it can never be selected here even if a
      // future export shape adds more tables to the raw JSON.
      for (const kind of kinds) {
        records[kind] = (exported as Record<string, unknown[]>)[kind] ?? [];
      }
      return builtinText(JSON.stringify({ system, window: windowInfo(scoped.window), records }, null, 2));
    },
  };
}

function summarizeWrite(result: VerifyReportResult, rawHtml: string): string {
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
  // Two-tag rule (RR6): say exactly what was dropped, so the AI can fix it.
  const n = result.sanitizeNotes;
  if (n) {
    if (n.droppedBlocks > 0) lines.push(`dropped: ${n.droppedBlocks} block(s) outside sv-ai — put your own content inside <sv-ai>…</sv-ai>; only gateway elements, sv-row and one sv-glossary may stand outside it.`);
    if (n.droppedSvInsideAi > 0) lines.push(`dropped: ${n.droppedSvInsideAi} sv-* element(s) inside sv-ai — place gateway elements outside sv-ai blocks.`);
    if (n.droppedStyles > 0) lines.push(`dropped: ${n.droppedStyles} <style> block(s) — use inline style="…" attributes inside sv-ai.`);
    if (n.extraGlossaries > 0) lines.push(`dropped: ${n.extraGlossaries} extra sv-glossary — one per report.`);
  }
  const g = glossaryUsage(rawHtml, result.elements);
  if (g) {
    lines.push(`Glossary: ${g.applied.length} term(s) shown as translation (when the reader switches it on).`);
    for (const r of g.rejected) lines.push(`  - ignored "${r.key}": ${r.reason}`);
  }
  const cov = result.coverage;
  if (cov.window) lines.push(`Reporting window: ${cov.window.label}. Evidence from before it is not verifiable in this report.`);
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

/**
 * What makes this call impossible regardless of who/what approves it — empty
 * or oversize html. Used BOTH as `validate` (checked by
 * `IntegrationManager.precheckBuiltin` before any proposal or ticket — see
 * builtin-integration.ts) and re-checked inside the handler itself, since
 * `validate` only ever sees the args at call time and the handler must not
 * assume nothing has changed by the time it actually runs.
 */
function writeReportRefusal(args: Record<string, unknown>): string | undefined {
  const html = typeof args.html === 'string' ? args.html : '';
  if (!html.trim()) return '`html` must be a non-empty string.';
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_REPORT_HTML_BYTES) {
    return (
      `the report is ${bytes} bytes, over the ${MAX_REPORT_HTML_BYTES}-byte limit. ` +
      `Shorten it (the gateway draws the verifiable elements for you — you do not need to inline ` +
      `their data) and write again.`
    );
  }
  // Two-tag rule (RR6): a report where every block would be dropped shows
  // NOTHING — refuse it before any ticket, instead of storing an empty
  // report (simulation finding 2026-10-16: 5 blocks, all outside sv-ai).
  const { html: kept, notes } = sanitizeReport(html);
  if (!/<sv-(ai|ticket|approval|mandate|record|case|metric|row)\b/i.test(kept)) {
    const lost: string[] = [];
    if (notes.droppedBlocks > 0) lost.push(`${notes.droppedBlocks} block(s) outside sv-ai`);
    if (notes.droppedSvInsideAi > 0) lost.push(`${notes.droppedSvInsideAi} sv-* element(s) inside sv-ai`);
    if (notes.droppedStyles > 0) lost.push(`${notes.droppedStyles} <style> block(s)`);
    return (
      `nothing in this report would be shown${lost.length ? ` (dropped: ${lost.join(', ')})` : ''}. ` +
      `A report is a flat sequence of top-level blocks: your own content inside <sv-ai>…</sv-ai>, ` +
      `gateway elements (sv-ticket, sv-approval, sv-mandate, sv-record, sv-case, sv-metric, optionally in sv-row) ` +
      `and at most one sv-glossary. Write it again in that form; nothing was stored and no ticket was used.`
    );
  }
  return undefined;
}

function writeReportTool(deps: BuiltinDeps): BuiltinTool {
  return {
    name: 'write_report',
    // The brief IS the description — this is how it reaches the AI (R3/R4 plan,
    // the same pattern mail.json's load_simulation uses for its package guide).
    // Its system names come from the manifests' report declarations.
    description: reportBrief(reportSystems()),
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The full report HTML — see the tool description for how to write it.' },
        ticket_id: { type: 'string' },
      },
      required: ['html'],
    },
    // Empty/oversize html, or no reporting window to check it against, is
    // refused here, BEFORE the gate requests a ticket (precheckBuiltin) — a
    // refused write must not consume report_daily_max.
    validate: async (args) => {
      const refusal = writeReportRefusal(args);
      if (refusal) return refusal;
      const scoped = await scope(deps);
      return scoped.ok ? undefined : scoped.reason;
    },
    handler: async (args) => {
      // automatic mode means no human-approval delay, but the handler still
      // checks again rather than trust validate's earlier pass blindly.
      const refusal = writeReportRefusal(args);
      if (refusal) return errorText(`Refused: ${refusal}`);
      const html = args.html as string;
      if (deps.state.reportStore.isLocked()) {
        return errorText('The report store is locked (the vault is not unlocked) — cannot save a report right now.');
      }
      const scoped = await scope(deps);
      if (!scoped.ok) return errorText(`Refused: ${scoped.reason}`);
      try {
        const stored = await deps.state.reportStore.saveReport(html, scoped.sources);
        return builtinText(summarizeWrite(stored.result, html));
      } catch (err) {
        return errorText(`Could not verify and store the report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export const reportBuiltin: BuiltinFactory = (deps) => {
  // The read tools' gate: the read switch the Report built-in's own profile declares.
  const READ_GATE = readSwitchGate(REPORTING_PROFILE);
  return {
    id: 'report',
    name: 'Report',
    evidenceOnly: true,
    // Short name — matches the real registration in profile-loader.ts (full id
    // AND short name both registered); profileMatches() accepts either. Declared
    // once, in report/window.ts (the reporting window reads the same mandates).
    profile: REPORTING_PROFILE,
    // Touches no real system (reads the local archive + each simulator's own
    // read-only export CLI; writes only the local, vault-encrypted report file)
    // — safe during a simulation-mode test.
    simulation: true,
    // Listed without a mandate, like connector tools: an AI client that ignores
    // tools/list_changed (ChatGPT) otherwise never sees report__* after the
    // reporting mandate is signed mid-chat (simulation finding, 2026-10-16).
    // Listing authorizes nothing — the gate still refuses a call without one.
    alwaysListed: true,
    // The same predicate the reporting window uses to refuse a mandate
    // (reporting@0.1, or no window set): the gate never selects such a mandate
    // for ANY report tool — so write_report is never ticketed under (and never
    // charges report_daily_max of) a mandate every read tool refuses (RR7).
    mandateRefusal: (auth) => reportingMandateRefusal(auth),
    toolGating: {
      overrides: {
        list_tickets: READ_GATE,
        get_ticket: READ_GATE,
        list_cases: READ_GATE,
        get_records: READ_GATE,
        write_report: { executionMapping: {}, staticExecution: { action_type: 'report' }, actionLabel: 'Report written' },
      },
    } as unknown as BuiltinIntegration['toolGating'],
    tools: [
      listTicketsTool(deps),
      getTicketTool(deps),
      listCasesTool(deps),
      getRecordsTool(deps),
      writeReportTool(deps),
    ],
  };
};
