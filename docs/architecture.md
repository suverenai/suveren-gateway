# Architecture

## System Overview

The Suveren Gateway is a local runtime that sits between AI agents and external tools. It enforces human-defined authorization bounds on every tool call through cryptographic verification and AS-issued receipts.

```
Human (Browser)                              AI Agent (MCP client)
      |                                             |
      v                                             v
+----------------+                          +----------------+
| Control Plane  |--- /internal/* --------->| MCP Server     |
| :3400          |   (loopback only)        | :3430          |
|                |                          |                |
| - Auth (login) |                          | - Gatekeeper   |
| - UI (React)   |                          | - Tool proxy   |
| - Vault        |                          | - Att. cache   |
| - SP proxy     |                          | - Gate store   |
| - Gate content |                          | - Exec. log    |
+----------------+                          +----------------+
      |                                             |
      v                                             v
+----------------+                          +----------------+
| SP (remote)    |                          | Downstream MCP |
| Attestation    |<-- receipts -------------|  (e.g. Mollie) |
| signing,       |                          |                |
| receipts,      |                          | - 28 tools     |
| revocation     |                          | - stdio        |
+----------------+                          +----------------+
```

## Runtime Services

| Port | Service | Package | Responsibility |
|------|---------|---------|----------------|
| **3400** | Control Plane | `apps/control-plane` | Serves UI, handles auth, proxies SP requests, manages vault and gate content, forwards credentials to MCP |
| **3430** | MCP Server | `apps/mcp-server` | Gatekeeper verification, tool proxy, attestation cache, gate store, execution log, agent context |
| — | hap-core | `packages/hap-core` | Shared protocol logic: types, bounds/context hashing, attestation verification, gatekeeper |

## Internal Communication

The control-plane communicates with the MCP server via loopback-only HTTP endpoints:

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `POST /internal/configure` | CP -> MCP | Push session cookie + vault key |
| `POST /internal/gate-content` | CP -> MCP | Push gate content + context (encrypted storage) |
| `POST /internal/resync-gates` | CP -> MCP | Re-sync all stored gates with SP attestations |
| `POST /internal/service-credentials` | CP -> MCP | Push decrypted service credentials (e.g., Mollie access token) |
| `POST /internal/add-integration` | CP -> MCP | Start a downstream MCP server |
| `DELETE /internal/remove-integration/:id` | CP -> MCP | Stop a downstream MCP server |
| `GET /internal/integrations` | CP -> MCP | List running integrations |

These endpoints are restricted to `127.0.0.1` / `::1`. In Docker, both services run in the same container.

## Data Storage

| What | Location | Encrypted | Persists |
|------|----------|-----------|----------|
| Gate content (problem, objective, tradeoffs) | `~/.suveren/gates.json` or `gates.enc.json` | Yes (with vault key) | Yes |
| Execution log (tool call history) | `~/.suveren/execution-log.json` or `.enc.json` | Yes (with vault key) | Yes |
| Integration configs (Mollie, etc.) | `~/.suveren/integrations.json` | No | Yes |
| Service credentials (API keys) | `~/.suveren/vault.enc.json` | Yes (PBKDF2 from SP API key) | Yes |
| Attestation cache | In-memory | No | No (re-synced on login) |
| Context content | In gate store | Yes (with vault key) | Yes |
| Organization context | `~/.suveren/context.md` | No (user-maintained) | Yes |

## Bounds and Context (v0.4)

The v0.3 "frame" is replaced by two concepts:

**Bounds** (`boundsSchema` in profile) — enforceable constraints:
- Sent to SP for storage and receipt enforcement
- Contains: `profile`, `path`, numeric `_max` limits
- Hashed as `bounds_hash` in attestation

**Context** (`contextSchema` in profile) — operational details:
- **Never sent to SP** — only `context_hash` leaves local custody
- Contains: `currency`, `action_type`, `target_env`, `app`, etc.
- Stored locally in gate store, encrypted at rest
- Gatekeeper verifies `context_hash` and enforces enum constraints locally

## Profiles

Profiles define what an authorization controls. Each profile has:
- `boundsSchema` — fields the SP enforces (numeric limits)
- `contextSchema` — fields the gatekeeper enforces locally (enums, operational details)
- `executionContextSchema` — how tool arguments map to verification fields
- `executionPaths` — which domain owners must attest
- `toolGating` — how downstream MCP tools map to execution context

### Spend Profile (spend@0.4)

| | Bounds (-> SP) | Context (local) |
|---|---|---|
| Fields | amount_max, amount_daily_max, amount_monthly_max, transaction_count_daily_max | currency, action_type |
| Enforcement | SP checks in receipts | Gatekeeper checks locally |

| Path | Required Domains | Default TTL |
|------|-----------------|-------------|
| `spend-routine` | finance | 24 hours |
| `spend-reviewed` | finance + compliance | 4 hours |

### Tool Gating

Tools discovered from downstream MCP servers are classified by the profile's `toolGating`:

| Classification | Example | Behavior |
|----------------|---------|----------|
| **Gated** (explicit override) | `create_payment_link`, `create_refund` | Execution mapping applied, gatekeeper + SP receipt required |
| **Default-gated** | `list_products`, `create_customer` | Default staticExecution applied (e.g., `action_type: "read"`) |
| **Read-only** (null override) | `retrieve_balance`, `list_invoices` | No authorization needed, always available |

## Agent Context (Two-Tier Model)

### Tier 1: Mandate Brief

Loaded as MCP `instructions` when the agent connects. Compact format:

```
[spend-routine] spend@0.4 (45 min remaining)
  Bounds: amount_max: 100, amount_daily_max: 500, ...
  Usage: $234/$500 daily, 8/20 tx
  3 gated tools, 19 read-only — call list-authorizations(domain: "spend") for details
```

### Tier 2: list-authorizations

On-demand detail per domain. Returns: full bounds, live consumption, gate content, capability map (gated/read-only/default-gated tools with execution mappings).

This prevents wasting context tokens on domains irrelevant to the current task.

## Project Structure

```
suveren-gateway/
+-- apps/
|   +-- control-plane/          # Admin server (:3400)
|   |   +-- src/
|   |       +-- index.ts        # Express server, SP proxy, gate-content routing
|   |       +-- routes/
|   |       |   +-- auth.ts     # Login/logout, credential re-sync
|   |       |   +-- vault.ts    # Credential CRUD (AES-256-GCM)
|   |       +-- lib/
|   |           +-- mcp-bridge.ts   # HTTP client to MCP /internal/*
|   |           +-- vault.ts        # Vault encryption (PBKDF2 + AES-256-GCM)
|   |
|   +-- mcp-server/             # MCP Gateway (:3430)
|   |   +-- bin/http.ts         # Express server, SSE + Streamable HTTP, internal endpoints
|   |   +-- src/
|   |       +-- index.ts        # MCP server factory, tool registration, JSON Schema -> Zod
|   |       +-- tools/
|   |       |   +-- authorizations.ts   # list-authorizations (compact + domain detail)
|   |       |   +-- pending.ts          # check-pending-attestations
|   |       +-- lib/
|   |           +-- gatekeeper.ts       # Wraps hap-core verify(), resolves bounds/context
|   |           +-- tool-proxy.ts       # Gated tool handler, SP receipt pre-flight
|   |           +-- sp-client.ts        # SP HTTP client (attestations, receipts, pubkey)
|   |           +-- attestation-cache.ts  # In-memory cache with TTL eviction
|   |           +-- gate-store.ts       # Persistent gate content + context (encrypted)
|   |           +-- execution-log.ts    # Persistent execution history (encrypted)
|   |           +-- shared-state.ts     # Singleton: SP client, cache, gate store, log
|   |           +-- mandate-brief.ts    # Builds compact agent system instructions
|   |           +-- consumption.ts      # Resolves cumulative state from execution log
|   |           +-- context-loader.ts   # Reads ~/.suveren/context.md for org context
|   |           +-- integration-manager.ts  # Spawns/manages downstream MCP servers
|   |           +-- integration-registry.ts # Persists integration configs
|   |           +-- profile-loader.ts   # Loads profiles from hap-profiles directory
|   |
|   +-- ui/                     # React frontend (built, served by control-plane)
|       +-- src/
|           +-- pages/
|           |   +-- AgentNewPage.tsx       # Step 1: profile/path selection
|           |   +-- GateWizardPage.tsx     # Steps 2-5: bounds + context + gate questions
|           |   +-- AgentReviewPage.tsx    # Step 6: review, attest, push gate content
|           +-- components/
|           |   +-- BoundsEditor.tsx       # Renders bounds + context fields from profile schema
|           +-- lib/
|               +-- frame.ts              # Browser-side hashing (SubtleCrypto)
|               +-- sp-client.ts          # API client (proxied through control-plane)
|
+-- packages/
|   +-- hap-core/               # Shared protocol logic (also at github.com/humanagencyprotocol/hap-core)
|       +-- src/
|           +-- types.ts        # All protocol types
|           +-- frame.ts        # Bounds/context canonicalization + SHA-256 hashing
|           +-- attestation.ts  # Ed25519 signing/verification, blob encoding
|           +-- gatekeeper.ts   # Full verification: signature, TTL, domains, hashes, bounds
|           +-- profiles/       # Profile registry
|
+-- docs/                       # This documentation
+-- Dockerfile                  # Two-stage build, tini for PID 1
+-- docker-compose.yml          # Single-container deployment
+-- entrypoint.sh               # Starts both services
```
