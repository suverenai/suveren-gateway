/**
 * The report brief — how the user's AI writes a report (work-plan "regular
 * reporting", decision 5 + RR6; originally "evidence-backed reports", R3).
 *
 * Fixed text shipped with the gateway (later: per company), delivered as the
 * description of `write_report`, so the AI has it exactly when it writes.
 *
 * The block syntax here is a contract with sanitize.ts (what survives),
 * verify-report.ts (what is checked) and render-report.ts (what is drawn) —
 * change them together.
 */

/** The fixed, verifiable elements the AI may place, in the order the brief lists them. */
export const REPORT_ELEMENTS = [
  'sv-ticket',
  'sv-approval',
  'sv-mandate',
  'sv-record',
  'sv-case',
  'sv-metric',
] as const;

/** The report format's structural blocks (not verified, not elements). */
export const REPORT_BLOCKS = ['sv-ai', 'sv-row', 'sv-glossary', 'sv-term'] as const;

export const REPORT_BRIEF = `How to write a report

Purpose: regular reports on what you did in your reporting window — this week, this test, this month — for managers who are not technical. Plain words, short sentences, the result first. Each write replaces the previous report.

Your window: the reporting mandate sets how many days back you may report. list_tickets returns it ("window"), and write_report repeats it. Tickets and records from before it cannot be used.

The format — only these blocks, one after another. Anything else is dropped (write_report tells you how much):

1. <sv-ai>…</sv-ai> — your own content: headings, text, tables, inline SVG charts, your assessment. Any HTML inside, styled with inline style="…" attributes only (no <style> blocks, no JavaScript, no external files or links). The gateway draws it in a grey frame labelled "AI analysis — not verified".
2. Verified elements — you give a reference, the gateway checks it and draws the box. You never write their content:
   - <sv-ticket ref="TICKET_ID" variant="compact"></sv-ticket> — one action: action + time. variant="full" shows every signed field (incl. its mandate and approval) and the public check link.
   - <sv-approval ticket="TICKET_ID"></sv-approval> — when the approval was asked and decided, and by whom.
   - <sv-mandate ticket="TICKET_ID"></sv-mandate> — the authority the action ran under: limits, mode, intent.
   - <sv-record system="email|crm|erp" ref="RECORD_ID"></sv-record> — an email, CRM entry, quote or order.
   - <sv-case start="email:MESSAGE_ID" goal="ticket:TICKET_ID" steps="TICKET_ID TICKET_ID"></sv-case> — one business case from its start email to the ticket that completed it.
   - <sv-metric kind="KIND" cases="all"></sv-metric> — a number the gateway computes over your cases. KIND: completed, median-time, average-time, without-approval, approvals, median-approval-wait, tickets, refusals. cases is "all" or case ids, e.g. cases="C1 C3".
3. <sv-row>…</sv-row> — puts verified elements side by side (they stack on a phone). Only verified elements inside.
4. <sv-glossary lang="de"><sv-term key="erp__create_quote">Angebot erstellt</sv-term></sv-glossary> — optional, once per report. Translates field names and fixed words that appear in the verified boxes (action names, profile, mode, field names such as value_max). Words only: never numbers, amounts, times or ids; plain text, at most 60 characters. The reader sees it small above the raw value, only when they switch translation on. Unknown keys are ignored.

Example:
<sv-ai><h1>Week 41: three requests answered</h1><p>One quote needed an approval.</p></sv-ai>
<sv-row><sv-metric kind="completed" cases="all"></sv-metric><sv-metric kind="approvals" cases="all"></sv-metric></sv-row>
<sv-ai><p>The quote for Huber went out 9 minutes after the request.</p></sv-ai>
<sv-ticket ref="rcpt_123" variant="full"></sv-ticket>

Rules:
1. Nothing verified inside sv-ai: an sv-* element there is removed, and class names starting with "sv-" are removed from your HTML. Do not imitate the green boxes — your content always sits in the grey frame.
2. Verified boxes show only signed field names and raw values. Explain them in plain words in the sv-ai block next to them.
3. Use sv-metric for every headline number. Numbers you compute yourself stay "AI analysis — not verified".
4. A wrong or unknown reference is shown as "not verifiable". Do not guess IDs — read them first (list_tickets, get_ticket, list_cases, get_records).
5. Never claim more than the boxes prove. Say plainly what went wrong or waited for a person.

Cases and coverage apply only when test data is loaded (list_cases shows it):
- Define every case you worked on with sv-case. The gateway shows how many of the loaded cases your report covers, names the missing ones, and lists every ticket from the window that your report does not reference — so name every step.
- A case's goal must be what actually completed it — for an email reply, the reply to the start email. A case is timed from when its email reached the test (the test data may date its emails earlier — the gateway uses the later of the two).

Layout: it must read well on a phone, in a narrow side panel (about 360 pixels) and on a large screen. Inside sv-ai use fluid widths, wrapping flex/grid, tables that scroll, and SVG charts with a viewBox.

Suggested structure: the result in one sentence (sv-ai) → 3–4 sv-metric in an sv-row → each case (sv-case, then the tickets and approvals that explain it, each with a short sv-ai caption) → what was stopped or waited for a person → your assessment (sv-ai).`;
