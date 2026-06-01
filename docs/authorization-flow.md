# Authorization Flow

## Overview

An authorization is created through the UI gate wizard and involves three systems. Each handles different data according to the privacy model.

**Systems involved:**
- **Browser UI** — human enters bounds, context, and gate content; computes hashes
- **SP (Service Provider)** — signs attestations, stores bounds + hashes, enforces limits at runtime
- **MCP Server** — stores gate content + context locally (encrypted), serves tools to agents

**Privacy rule:** The SP sees bounds (enforceable limits) and hashes. It never sees context content or gate content plaintext.

## Data Flow

```
Step  Browser UI                   SP (remote)              MCP Server (local)
----  ----------                   ----------               ------------------

 1    Human sets bounds            .                        .
      Human sets context           .                        .
      Human writes gate content    .                        .
                                   .                        .
 2    Compute:                     .                        .
      - bounds_hash                .                        .
      - context_hash               .                        .
      - gate_content_hashes        .                        .
                                   .                        .
 3    POST /api/sp/attest -------> Validate:                .
      sends:                       - gates closed           .
      - bounds (plaintext)         - domain authorized      .
      - bounds_hash                - group membership       .
      - context_hash               Sign attestation         .
      - gate_content_hashes        Store bounds + hashes    .
                                   .                        .
      <-- attestation blob ------- Return signed blob       .
                                   .                        .
 4    POST /gate-content ---------------------------------> Receive:
      sends:                                                - gate content (plaintext)
      - boundsHash                                          - context (plaintext)
      - contextHash                                         - boundsHash, contextHash
      - context (plaintext)                                 .
      - gateContent (plaintext)                             Sync attestation from SP
                                                            Store gate content + context
                                                            (encrypted at rest)
                                                            Refresh agent tools
```

**Order matters:** Step 3 (attest) must complete before step 4 (push gate content). The MCP server syncs the attestation from the SP during step 4 — the attestation must exist first.

## What Goes Where

| Data | Browser | SP | MCP Server |
|------|---------|-----|------------|
| Bounds (amount_max, daily limits) | Entered by human | Stored, enforced in receipts | Cached from SP |
| Bounds hash | Computed (SHA-256) | In attestation payload | Verified by gatekeeper |
| Context (currency, action_type, target_env) | Entered by human | **Never sent** (hash only) | Stored locally, encrypted |
| Context hash | Computed (SHA-256) | In attestation payload | Verified by gatekeeper |
| Gate content (problem, objective, tradeoffs) | Written by human | **Never sent** (hashes only) | Stored locally, encrypted |
| Gate content hashes | Computed (SHA-256) | In attestation payload | Verified against plaintext |
| Attestation blob | Received from SP | Stored (Ed25519 signed) | Cached in memory |

## The Gate Wizard

### Step 1: Profile & Path

The human selects:
- **Profile** — what type of action: `spend@0.4`, `ship@0.4`, `data@0.4`, `publish@0.4`, `provision@0.4`
- **Execution path** — which domains must attest: e.g., `spend-routine` (finance only) or `spend-reviewed` (finance + compliance)
- **Group** — which organization this authorization belongs to (determines domain membership)

### Step 2: Bounds + Context

The profile defines two schemas that the UI renders as form fields:

**Bounds** (`boundsSchema`) — enforceable limits, sent to SP:
- `profile`, `path` — structural (auto-filled)
- Numeric limits: `amount_max`, `amount_daily_max`, `amount_monthly_max`, `transaction_count_daily_max`
- Fields with an `enum` array in the profile render as dropdowns

**Context** (`contextSchema`) — operational details, stays local:
- `currency`, `action_type` (for spend)
- `target_env`, `app`, `branch` (for ship)
- Fields with an `enum` array render as dropdowns
- Context is optional — spend profiles have context fields, but some profiles may have empty context

### Steps 3-5: Gate Questions

Three structured questions capture the human's direction:

| Gate | Question |
|------|----------|
| **Problem** | Why is this authorization needed? What problem does it solve? |
| **Objective** | What should the agent achieve? What does success look like? |
| **Tradeoffs** | What risks are you accepting? What constraints limit exposure? |

These are Direction State. The plaintext stays local (MCP server only). Only SHA-256 hashes go to the SP.

### Step 6: Review & Commit

The human reviews all inputs and clicks "Commit — Sign Attestation." This triggers:

1. Browser computes `bounds_hash`, `context_hash`, and `gate_content_hashes` using SHA-256
2. Browser calls SP `POST /api/sp/attest` with bounds (plaintext) + all hashes
3. SP validates gates are closed, domain is authorized, signs attestation with Ed25519
4. Browser calls gateway `POST /gate-content` with gate content + context (plaintext) + hashes
5. MCP server syncs attestation from SP using `boundsHash` as lookup key
6. MCP server stores gate content + context (encrypted if vault key is set)
7. MCP server enables gated tools and refreshes agent sessions

## Tool Execution (after authorization exists)

When an agent calls a gated tool:

```
Agent calls tool (e.g., create_payment_link)
  |
  v
Gateway builds execution context
  - Maps tool arguments to execution fields
  - e.g., unit_amount / 100 -> amount, currency -> currency
  |
  v
Gatekeeper verifies locally
  - Ed25519 signature valid?
  - TTL not expired?
  - All required domains attested?
  - bounds_hash matches?
  - context_hash matches?
  - Enum constraints (currency, action_type) match context?
  |
  v
Gateway requests SP receipt (pre-flight, fail-closed)
  - SP checks: per-transaction bounds (amount <= amount_max)
  - SP checks: cumulative bounds (daily amount, monthly amount, tx count)
  - SP checks: group limits (optional, org policy)
  - SP checks: not revoked
  |
  v
SP returns signed receipt + consumption state
  - daily: { amount: 234, count: 8 }
  - monthly: { amount: 1280, count: 42 }
  |
  v
Gateway proxies tool call to downstream MCP server
  |
  v
Result returned to agent
```

If the SP rejects (limit exceeded, revoked) or is unreachable, the tool call is blocked. **No receipt, no execution.**

## What the Agent Sees

### Tier 1: Mandate Brief (loaded on connect)

```
You are connected to Suveren — the gateway that gates every privileged tool call you make.
Suveren implements the bounded-authority model from the open Human Agency Protocol (HAP).
You have bounded authorities granted by human decision owners.

=== ACTIVE AUTHORITIES ===

[spend-routine] spend@0.4 (28 min remaining)
  Bounds: amount_max: 100, amount_daily_max: 500, transaction_count_daily_max: 20
  Usage: $234/$500 daily, $1280/$5000 monthly, 8/20 tx
  Problem: Monthly supplier invoices need timely processing.
  3 gated tools, 19 read-only — call list-authorizations(domain: "spend") for details
```

Each tool description includes a gating tag:
- `[HAP: ungated]` — no authorization needed
- `[HAP: spend — charge, amount, currency checked]` — gated with specific checks
- `[HAP: spend — no active authorization]` — gated but unavailable

### Tier 2: list-authorizations (on demand)

The agent calls `list-authorizations(domain: "spend")` to get full detail:
- Bounds with all parameters
- Live consumption (daily/monthly amounts and counts from SP receipts)
- Gate content (problem, objective, tradeoffs)
- Capability map (which tools are gated, read-only, or default-gated)

## Revocation

A human can revoke an authorization at any time through the SP interface. After revocation:
- The SP refuses to issue execution receipts for the revoked attestation
- The next tool call is blocked with a `REVOKED` error
- The attestation remains cryptographically valid for audit purposes
- No TTL waiting — revocation is immediate

## Login Re-sync

After an MCP server restart, a single login through the control-plane UI restores the full state:

1. Control-plane pushes SP session cookie + vault key to MCP server
2. Control-plane re-pushes all stored service credentials (e.g., Mollie access token)
3. Control-plane triggers gate re-sync — MCP server re-fetches attestations from SP using stored gate entries

No need to re-create authorizations or re-enter credentials.
