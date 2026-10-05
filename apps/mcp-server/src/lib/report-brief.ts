/**
 * The report brief — how the user's AI should build the evidence-backed
 * report (work-plan "Added 2026-10-05 — evidence-backed reports", step R3).
 *
 * Fixed text shipped with the gateway for now (later: per company). It is
 * delivered to the AI in the description of the report tool (R4), the same
 * way load_simulation carries its package guide, so the AI has it exactly
 * when it writes a report.
 *
 * The element names and attributes here are a contract with the report
 * widget (R5), which resolves and verifies them — change both together.
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

export const REPORT_BRIEF = `How to write the report

Purpose: show the company's management what the AI achieved in this test — case by case, from the request that started it to the goal that completed it — with proof for every fact that matters.

Who reads it: managers who are not technical. Plain words, short sentences, the result first.

What you write: one HTML page (HTML, CSS and inline SVG only — no JavaScript, no external files or links except the check links the gateway adds). The layout, headings, charts, tables and your assessment are yours.

What you cannot write yourself: facts that need proof. Place these elements instead; the gateway looks the data up, checks it and draws the element. You give references, never the content:

- <sv-ticket ref="TICKET_ID"></sv-ticket> — one action you took, with its signed ticket.
- <sv-approval ticket="TICKET_ID"></sv-approval> — who approved that action, when, and how long it waited.
- <sv-mandate ticket="TICKET_ID"></sv-mandate> — the authority the action ran under: limits, mode, intent.
- <sv-record system="email|crm|erp" ref="RECORD_ID"></sv-record> — an email, CRM entry, quote or order.
- <sv-case start="email:MESSAGE_ID" goal="ticket:TICKET_ID" steps="TICKET_ID TICKET_ID"></sv-case> — one business case: the incoming email that started it, the ticket that completed it, and the tickets in between.
- <sv-metric kind="KIND" cases="all"></sv-metric> — a number the gateway computes over the cases you defined. KIND: completed, median-time, average-time, without-approval, approvals, median-approval-wait, tickets, refusals.

Rules:
1. Define every case you worked on with sv-case — also the ones that did not reach their goal (omit goal, or say why in your text). The gateway shows management how many of the loaded cases your report covers and names the missing ones.
2. Use sv-metric for every headline number. Numbers you compute yourself are shown as "AI analysis — not verified".
3. A case's goal must be what actually completed it — for an email reply, the reply to the start email. The gateway checks this link.
4. A wrong or unknown reference is shown as "not verifiable". Do not guess IDs — read them first.
5. Never claim more than the elements prove. Say plainly what went wrong or waited for a person.

Suggested structure:
1. The result in one sentence, then 3–4 sv-metric figures (completed, median time, share without approval, approvals).
2. All cases at a glance — a table with one row per case, linked to its sv-case below.
3. Each case: sv-case, then the sv-ticket and sv-approval elements that explain it.
4. What was stopped or needed a person, and why (sv-approval, refusals).
5. Your assessment: what worked, what slowed things down, what a different mandate would change — marked as your view.

Update the report whenever cases progress; each write replaces the previous report.`;
