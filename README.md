# Suveren Gateway

> **HAP is the protocol. Suveren is an implementation of it.**
>
> The Human Agency Protocol (HAP) is the open standard for bounded AI-agent
> authority — it defines the roles (**Authority Server**, **Gatekeeper**,
> **Executor**) and the concepts (profiles, gates, attestations, bounds,
> context, receipts). **Suveren** implements them: this repo is the **Gateway**,
> and [`suveren-as`](https://www.suveren.ai) is the **Authority Server**. The
> protocol is open — anyone can build their own compliant gateway.

This repository is the **Suveren Gateway** — Suveren's implementation of the HAP
**Gatekeeper + Executor** roles. It runs locally and verifies every tool call
against its authorization before the call reaches an external service. (The
`@hap/core` library inside this repo keeps its HAP name because it re-exports the
open protocol library — "HAP-compliant" and spec references describe the open
standard, not the Suveren brand.)

Part of [suveren.ai](https://www.suveren.ai).

Let your AI agents act — within bounds you control.

The gateway runs on your machine, between your AI agents and the tools they use — payments, email, CRM, deployments, infrastructure. Your agents go through a local policy layer before reaching external services. Nothing executes without authorization.

Works with any MCP-compatible agent. Define and authorize what they're allowed to do. Every action is bounded, time-limited, and traceable to a human decision — so agents can execute safely at scale.

---

## Automatic or Review

Set the threshold. Routine actions execute automatically within the bounds you defined. High-stakes actions pause for your review before the agent acts.

**Automatic** — You commit to specific bounds upfront: max amounts, allowed actions, time windows. The agent executes autonomously within those bounds. For each tool call the gateway verifies your authorization and requests a receipt from the Authority Server, which issues the signed receipt before the call runs — no receipt, no execution.

**Review each action** — You define bounds but defer full commitment. When the agent proposes an action, you review it in the gateway UI — seeing exactly which tool, which arguments, which context. You approve or reject. Execution only proceeds after your decision.

Both modes are bounded. In both, the Authority Server issues a signed receipt before the action runs — no receipt, no execution — and that signed history is a full audit trail. The difference is whether you trust the bounds enough for autonomous execution, or want to review each action individually.

---

## How It Works

```
Human                                 AI Agent
  |                                       |
  | 1. Define bounds,                     |
  |    articulate direction,              |
  |    commit (or defer)                  |
  v                                       |
Authority Server                          |
  | 2. Sign attestation (Ed25519)         |
  v                                       |
Gateway                                   |
  |              3. Connect via MCP ----->|
  |              4. Tool call <-----------|
  |                                       |
  | 5. Fully committed:                   |
  |    Gatekeeper checks bounds, asks AS  |
  |    -> AS issues receipt, execute      |
  |                                       |
  |    Deferred commitment:               |
  |    -> proposal created                |
  |    -> human reviews in UI             |
  |    -> commit or reject                |
  |    -> on commit: AS receipt, execute  |
```

The agent never holds credentials or signing authority. It acts within the bounds you set — high autonomy without losing accountability.

---

## What the Agent Sees

When an agent connects, it receives a compact authority brief — active authorizations with bounds, live consumption, and available tools:

```
=== ACTIVE AUTHORITIES ===

[spend-routine] charge@0.4 (45 min remaining)
  Bounds: amount_max: 100, currency: USD, action_type: charge
  Usage: $234/$500 daily, $1280/$5000 monthly, 8/20 tx
  Intent: Enable automated purchasing for business operations.
  4 gated tools, 19 read-only
```

No credentials. No signing keys. Just the scope of what the agent is allowed to do — and the human's stated reason for granting it.

---

## Quick Start

Pick whichever you have on hand — both produce the same gateway.

### Option A — Docker

Requires [Docker](https://docs.docker.com/get-docker/).

```bash
docker run -d --name suveren-gateway \
  -p 7400:3000 -p 7430:3030 \
  -v $HOME/.suveren:/app/data \
  ghcr.io/humanagencyprotocol/suveren-gateway
```

Open `http://localhost:7400`. The MCP server is at `http://localhost:7430`.

### Option B — npm

Requires [Node.js 20.18.1+](https://nodejs.org/).

```bash
npm install -g @suveren/gateway
suveren-gateway start              # runs in foreground; Ctrl+C stops
# or
suveren-gateway start --detach     # runs in the background; data + logs in ~/.suveren/
suveren-gateway status             # check it's up
suveren-gateway stop               # stop a detached run
```

Open `http://localhost:3400`. The MCP server is at `http://localhost:3430`.

To upgrade later, run these two commands:

```
npm install -g @suveren/gateway@latest
suveren-gateway restart
```

(Written as two lines on purpose: `&&` is not a valid separator in Windows
PowerShell 5.1, which is what ships with Windows. Use `;` there if you want
them on one line.)

### Connecting an MCP client

Either path exposes the same MCP transports — use the port from the path you chose (7430 for Docker, 3430 for npm):

```
Streamable HTTP:  POST http://localhost:<port>/mcp
SSE transport:    GET  http://localhost:<port>/sse
```

### Local development

Running from source gives you hot-reload across all three services:

```bash
cd suveren-gateway
pnpm install
pnpm dev          # UI on :3400, control plane on :3402, MCP on :3430
```

See [`docs/development.md`](docs/development.md) for environment variables, testing, and per-service dev commands.

---

## Pinning the Authority Server's TLS certificate

Opt-in, for self-hosted Authority Servers with a stable signing key — not needed against the hosted `suveren.ai`, and off by default.

The gateway already verifies the Authority Server can *sign* under the right key before it ever sends an API key or session cookie. What that alone does not cover: something sitting on the network path between the gateway and the Authority Server, presenting its own TLS certificate, that a locally-trusted CA (e.g. a custom `--ca-file`) would otherwise accept. TLS certificate pinning closes that gap by pinning the Authority Server's certificate public key (SPKI, SHA-256) — every connection after that must present the same key, or the gateway refuses it and locks.

**Pinning only protects from the moment the fingerprint has actually been checked over a second channel** — a phone call, a video call, a separate trusted connection. That is why enabling it requires `--expect-fingerprint`: not an optional confirmation step, but the check itself. Recommended: enable it once, right after pairing, from a network you already trust.

```bash
# Get the Authority Server's own fingerprint independently — ask the operator,
# or run this yourself on a trusted network:
openssl s_client -connect your-as-host:443 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256

# Compare it against what you were told out-of-band, THEN enable:
suveren-gateway config set pin-tls on --expect-fingerprint <the-sha256-you-just-confirmed>
suveren-gateway restart
```

A few things worth knowing before turning it on:

- **Certificate renewal with the SAME key keeps the pin working** — nothing to do. Renew with the same key where your tooling supports it (e.g. `certbot renew --reuse-key`).
- **A renewal under a NEW key locks the gateway** (`as-tls-mismatch`) until an operator re-pairs — this is deliberate fail-closed behavior, not a bug. Re-pairing means clearing `<dataDir>/as-pairing.json` and signing in again.
- Pinned connections trust Node's own bundled root certificates plus `--ca-file` / `NODE_EXTRA_CA_CERTS` — **not** your operating system's trust store.
- `suveren-gateway config set pin-tls off` disables enforcement at any time; the stored fingerprint stays on file, so turning it back on later with the SAME `--expect-fingerprint` value succeeds immediately (it is still required every time — stating it again is cheap, and the command refuses outright if it doesn't match what's on file).

See `suveren-gateway config help` for the full command reference.

---

## Simulation mode — block every real system

A mandate is bound to a *profile* (e.g. "sales"), not to a specific connector. If a real
connector (e.g. a live ERP account) and a simulated one (the built-in ERP/CRM/email
simulators) share a profile on one gateway, a mandate meant only for testing also
authorizes the real connector — nothing about the mandate says which one it's for.

Simulation mode closes that gap gateway-wide: turn it on and **every connector without a
manifest `simulation` marker is refused to even start** (the built-in ERP, CRM, and email
simulators all declare one; a connected Gmail or live ERP account does not), and every
connector that does declare one has its mode forced to `simulation`, overriding whatever
credential value is on file. Mandates and profiles are completely unaffected, and the
Authority Server never learns this is on — it's a purely local, gateway-side switch.

```bash
# Start fresh with real systems blocked:
suveren-gateway start --simulation

# Or flip it on an existing install (takes effect on the next start/restart):
suveren-gateway simulation on
suveren-gateway restart

# Check the mode (the SAVED setting and, if the gateway is running, the LIVE one):
suveren-gateway simulation status

# Turning it off makes real systems reachable again, so it requires typed
# confirmation (or --confirm live for scripts) — turning it ON does not:
suveren-gateway simulation off
suveren-gateway restart
```

`suveren-gateway status` also shows the current mode. See `suveren-gateway simulation help`
for the full command reference.

---

## Technical Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | System overview, services, data storage, project structure |
| [Authorization Flow](docs/authorization-flow.md) | Data flow, gate wizard, tool execution, agent context |
| [Security Model](docs/security.md) | Enforcement layers, verification, encryption, fail-closed design |
| [Development](docs/development.md) | Local setup, env vars, Docker, testing |

---

Protocol specification: [humanagencyprotocol.org](https://humanagencyprotocol.org)

## License

MIT — see [LICENSE](LICENSE).
