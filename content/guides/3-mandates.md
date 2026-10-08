# Mandates

Propose the mandates the setup and the working AI need. You propose with `create_mandate`; the person approves each one on its own; only then is it created.

## Ask first

Before proposing any mandate, ask the person which steps they want to approve themselves. Their answer wins over everything below.

## The standard (when the person has no preference)

- **Steps the customer would see** — replies, sent quotes, orders — start in **review** mode: each one waits for the person's approval.
- **Internal steps** — looking up and noting things in the CRM, drafting quotes, loading test data — run **automatically** within limits.

Apply this to whatever systems are connected: the header above lists each system with its action types and tools. Judge from the action type and its tools whether the customer would see the result. When unsure, ask.

## Rules

- **One mandate per system.** Split a system into several mandates only when the team has different rules for different tasks. A mode applies to a whole mandate, so different modes for different steps of one system mean separate mandates (for example: drafting quotes automatically, sending quotes in review).
- **Setup and work are separate.** Setup mandates allow loading and clearing test data and nothing else. The working AI's mandates allow no loading or clearing (setup limit 0).
- **Start strict.** Where the team has not said otherwise, propose review mode or low caps. The person can loosen a mandate later by replacing it.
- **Limits come from the interview:** amounts, discounts, daily counts, allowed recipients. Do not invent them; ask.
- **Intent:** write why, goal and watch-outs in the person's words, in the language the team uses. It is signed with the mandate and the working AI follows it.
- **Teams:** in a team, the person must be an approver for the profile. `create_mandate` refuses at once if not; tell the person who can fix it (a team admin).
- **Workspace:** without `team`, a mandate goes where the person's Delegation mandate is. If they hold Delegation mandates in several workspaces, ask which one and pass it (`team`: a team's name, or `"personal"`).
- **Reporting:** never propose a `reporting` mandate for the working AI during a run (see **risks**).

## Example (only an example)

- Setup, per system: automatic, setup limit 4–6 per day, everything else 0.
- CRM: automatic, with daily limits.
- Sales, drafting quotes: automatic, within value and discount caps.
- Sales, sending quotes and orders: review.
- Email replies: review, recipients limited to the customers' domains.


<!-- generated: limits -->

Next: **brief**.
