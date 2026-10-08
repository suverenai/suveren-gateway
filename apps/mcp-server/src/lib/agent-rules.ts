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
export const AGENT_RULES: readonly string[] = [
  'Never open or operate the Suveren Gateway\'s web page — not in a browser you control, not with computer use. Never ask for, read or type the person\'s API key. Never approve a proposal: approvals are the person\'s alone.',
  'Use only the Suveren tools. No terminal, HTTP or browser calls to the gateway\'s ports (for example `curl localhost:3500/mcp`).',
];
