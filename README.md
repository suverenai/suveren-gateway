# HAP Local Gateway

Part of [humanagencyprotocol.com](https://humanagencyprotocol.com) — applying the [Human Agency Protocol](https://humanagencyprotocol.org).

Let your AI agents act — within bounds you control.

The gateway runs on your machine, between your AI agents and the tools they use — payments, email, CRM, deployments, infrastructure. Your agents go through a local policy layer before reaching external services. Nothing executes without authorization.

Works with any MCP-compatible agent. Define and authorize what they're allowed to do. Every action is bounded, time-limited, and traceable to a human decision — so agents can execute safely at scale.

---

## Automatic or Review

Set the threshold. Routine actions execute automatically within the bounds you defined. High-stakes actions pause for your review before the agent acts.

**Automatic** — You commit to specific bounds upfront: max amounts, allowed actions, time windows. The agent executes autonomously within those bounds. Each tool call is verified against your authorization and produces a signed receipt.

**Review each action** — You define bounds but defer full commitment. When the agent proposes an action, you review it in the gateway UI — seeing exactly which tool, which arguments, which context. You approve or reject. Execution only proceeds after your decision.

Both modes are bounded. Both produce receipts. Both create a full audit trail. The difference is whether you trust the bounds enough for autonomous execution, or want to review each action individually.

---

## How It Works

```
Human                                 AI Agent
  |                                       |
  | 1. Define bounds,                     |
  |    articulate direction,              |
  |    commit (or defer)                  |
  v                                       |
Service Provider                          |
  | 2. Sign attestation (Ed25519)         |
  v                                       |
Gateway                                   |
  |              3. Connect via MCP ----->|
  |              4. Tool call <-----------|
  |                                       |
  | 5. Fully committed:                   |
  |    Gatekeeper verifies bounds         |
  |    -> receipt issued, execute         |
  |                                       |
  |    Deferred commitment:               |
  |    -> proposal created                |
  |    -> human reviews in UI             |
  |    -> commit or reject                |
  |    -> execute on commit               |
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
docker run -d --name hap-gateway \
  -p 7400:3000 -p 7430:3030 \
  -v $HOME/.hap:/app/data \
  ghcr.io/humanagencyprotocol/hap-gateway
```

Open `http://localhost:7400`. The MCP server is at `http://localhost:7430`.

### Option B — npm

Requires [Node.js 20+](https://nodejs.org/).

```bash
npm install -g @humanagencyp/hap-gateway
hap-gateway start              # runs in foreground; Ctrl+C stops
# or
hap-gateway start --detach     # runs in the background; data + logs in ~/.hap/
hap-gateway status             # check it's up
hap-gateway stop               # stop a detached run
```

Open `http://localhost:3400`. The MCP server is at `http://localhost:3430`.

To upgrade later: `npm install -g @humanagencyp/hap-gateway@latest && hap-gateway restart`.

### Connecting an MCP client

Either path exposes the same MCP transports — use the port from the path you chose (7430 for Docker, 3430 for npm):

```
Streamable HTTP:  POST http://localhost:<port>/mcp
SSE transport:    GET  http://localhost:<port>/sse
```

### Local development

Running from source gives you hot-reload across all three services:

```bash
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
