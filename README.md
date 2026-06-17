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

Requires [Node.js 20+](https://nodejs.org/).

```bash
npm install -g @suveren/gateway
suveren-gateway start              # runs in foreground; Ctrl+C stops
# or
suveren-gateway start --detach     # runs in the background; data + logs in ~/.suveren/
suveren-gateway status             # check it's up
suveren-gateway stop               # stop a detached run
```

Open `http://localhost:3400`. The MCP server is at `http://localhost:3430`.

To upgrade later: `npm install -g @suveren/gateway@latest && suveren-gateway restart`.

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
