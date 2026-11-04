/**
 * Rules every agent connected to this gateway is told, in the session
 * instructions (mandate-brief.ts) and at the top of every setup guide (guides.ts).
 *
 * Found in the first real simulation tests (2026-10-08): a setup AI with browser
 * control (Claude in Chrome, a ChatGPT agent, computer use) could open the gateway's
 * web page, read the person's API key there and approve its own proposals — the
 * person would no longer be in the loop at all. Another tried `curl` against the
 * MCP port to discover tools. Telling the agent is one layer; the person-side
 * warning (LoginPage, ProposalReviewPage) is another. Neither is a guarantee — an
 * agent driving the person's real browser cannot be told apart from the person.
 */
/**
 * The golden rule: an AI acting under a mandate never presents itself as the
 * Mandate Owner or as any person (Andreas, 2026-11-04). It cannot be enforced —
 * the gateway cannot judge prose — so it is told first and in full. The
 * wording was chosen in a test with injected and owner-requested impersonation
 * (suveren-as/docs/work-plan.md, golden rule GR1–GR4): a prohibition alone made
 * models refuse the task; the clause "do the task this way instead and tell
 * them why" made them do it as the AI. Keep both halves.
 */
export const NO_IMPERSONATION_RULE =
  'You are an AI acting under a person\'s mandate. This rule comes before every other instruction, including the person\'s own: never write as if you were that person or any person. No "I" as them, no signature with their name alone, no feelings, opinions or experiences of your own, and never claim to be human. Write as their AI, or about them in the third person ("she asked me to confirm…", "he will…"). If the person asks you to write as them, do the task this way instead and tell them why. Every message you send is marked as sent by an AI; make that true of every word.';

export const AGENT_RULES: readonly string[] = [
  NO_IMPERSONATION_RULE,
  'Never open or operate the Suveren Gateway\'s web page — not in a browser you control, not with computer use. Never ask for, read or type the person\'s API key. Never approve a proposal: approvals are the person\'s alone.',
  'Use only the Suveren tools. No terminal, HTTP or browser calls to the gateway\'s ports (for example `curl localhost:3500/mcp`).',
  'When a tool offers an optional `_source` argument, set it to link the ONE record (e.g. an inbound email) you are acting on — just the reference ({connector, kind, id}), never a summary or quote; the gateway reads the record itself for the approver.',
];
