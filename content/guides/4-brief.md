# Brief

Propose the agent brief — the standing instructions the working AI starts every session with. You propose with `set_agent_brief`; the person approves; it applies from the working AI's next session.

## What goes in

From the interview:

- **Who the AI works for:** the company, the team, the person.
- **The job:** which requests it handles and what a good outcome is.
- **The process:** the steps in order, including the order of systems from the interview, written as a rule (for example: "Always look up the customer in the CRM before preparing a quote.").
- **House rules:** tone, language, discounts, credit, what to escalate and to whom.
- **Hard lines:** what it must never do, even where a mandate would allow it.
- **When unsure, ask:** a missing rule or an unclear step goes to the person, never to a guess.

Write the brief in the language the team uses.

## What stays out

- Anything that reveals a test: no "simulation", "test case", "expected reply" or similar words.
- The real replies from the cases.
- Secrets, passwords, keys.

## Limits

- At most 16 KB.
- It replaces the whole brief each time — always write the complete brief, not a change.
- The person approves every version.

Next: **agent-process**.
