# Security Model

## Enforcement Layers

Every gated tool call passes through multiple verification layers before execution:

```
Tool call arrives
  |
  v
1. Attestation verification (local)
   - Ed25519 signature valid against SP public key?
   - TTL not expired?
   - All required domains attested?
   - bounds_hash matches computed hash of stored bounds?
   - context_hash matches computed hash of stored context?
  |
  v
2. Bounds checking (local)
   - Numeric constraints: amount <= amount_max
   - Enum constraints: currency, action_type match context values
  |
  v
3. SP receipt (remote, pre-flight)
   - Per-transaction: amount <= bounds.amount_max
   - Daily cumulative: total <= bounds.amount_daily_max
   - Monthly cumulative: total <= bounds.amount_monthly_max
   - Transaction count: count <= bounds.transaction_count_daily_max
   - Group limits (optional): bounds <= org policy
   - Revocation check: attestation not revoked
  |
  v
4. Tool execution (downstream MCP server)
```

If any layer rejects, the tool call is blocked. The gateway is **fail-closed**: if the SP is unreachable, tool calls are blocked.

## What Is Verified

| Check | Where | What it prevents |
|-------|-------|-----------------|
| Ed25519 signature | Gatekeeper (local) | Forged or tampered attestations |
| TTL expiry | Gatekeeper (local) | Use of expired authorizations |
| Domain coverage | Gatekeeper (local) | Execution without required domain owner approval |
| Bounds hash | Gatekeeper (local) | Modification of bounds after attestation |
| Context hash | Gatekeeper (local) | Modification of context after attestation |
| Per-tx limits | SP (receipt) | Individual transactions exceeding authorized ceiling |
| Cumulative limits | SP (receipt) | Total spend exceeding daily/monthly bounds |
| Revocation | SP (receipt) | Continued use of revoked authorization |
| Group limits | SP (receipt, optional) | Authorization bounds exceeding org policy |

## Privacy Model

### What the SP sees

The SP receives and stores:
- **Bounds** — numeric limits and structural identifiers (`amount_max: 100`, `profile`, `path`)
- **Bounds hash** — SHA-256 of canonical bounds
- **Context hash** — SHA-256 of canonical context (hash only, never content)
- **Gate content hashes** — SHA-256 of problem/objective/tradeoffs (hashes only)
- **Attestation** — signed blob with all hashes
- **Execution receipts** — amount, action, cumulative state per tool call

### What the SP never sees

- **Context content** — `currency: USD`, `action_type: charge`, `target_env: staging.acme.internal`
- **Gate content plaintext** — the human's problem statement, objective, tradeoff assessment
- **Tool call details** — what specific tool was called, what arguments were passed (beyond amount/action)
- **Agent conversation** — what the agent discussed with the human before the call

### What stays local (MCP server)

Stored on disk at `~/.suveren/` (or `$SUVEREN_DATA_DIR`), encrypted with vault key when available:

- Gate content plaintext (problem, objective, tradeoffs)
- Context content (currency, action_type, target_env, etc.)
- Execution log (tool call history for cumulative tracking)
- Service credentials (Mollie access token, etc.)

The vault key is derived from the human's SP API key via PBKDF2 (100,000 iterations, SHA-256). It exists in memory only while the session is active.

## Encryption at Rest

| File | Contents | Encryption |
|------|----------|------------|
| `gates.json` / `gates.enc.json` | Gate content + context | AES-256-GCM (with vault key) |
| `execution-log.json` / `.enc.json` | Execution history | AES-256-GCM (with vault key) |
| `vault.enc.json` | Service credentials (API keys) | AES-256-GCM (PBKDF2 derived key) |
| `integrations.json` | Integration configs (no secrets) | Plaintext |
| `context.md` | Organization context (human-maintained) | Plaintext |

When a vault key is set, plaintext files are migrated to encrypted versions and the plaintext is deleted.

## Internal Endpoint Protection

The MCP server exposes `/internal/*` endpoints for the control-plane:

- **Loopback only** — restricted to `127.0.0.1`, `::1`, `::ffff:127.0.0.1`
- **Shared secret** (optional) — `HAP_INTERNAL_SECRET` env var, validated via `X-Internal-Secret` header
- In Docker, both services run in the same container — loopback is sufficient

## Authentication

The gateway does not authenticate agents directly. Authentication flows through the SP:

1. Human enters SP API key in the control-plane UI
2. Control-plane validates key against SP, gets session cookie
3. Control-plane derives vault key from API key (PBKDF2)
4. Session cookie + vault key pushed to MCP server via `/internal/configure`
5. MCP server uses session cookie for SP API calls (attestation sync, receipts)

The SP API key never reaches the browser after login. The control-plane holds it server-side.

## Fail-Closed Design

The system is designed to fail closed — if any component is unavailable, execution stops:

| Failure | Result |
|---------|--------|
| SP unreachable | Tool calls blocked (no receipt) |
| SP rejects receipt | Tool call blocked |
| Attestation expired | Tool hidden from agent, calls rejected |
| Attestation revoked | Tool calls blocked (SP returns REVOKED) |
| Wrong vault key | Gate content unreadable, stored gates empty |
| No authorization | Gated tools disabled in MCP tool list |

There is no degraded mode. Execution without proof is execution without accountability.
