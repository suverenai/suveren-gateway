# Development

## Prerequisites

- **Node.js 20+** — check with `node -v`
- **pnpm 9+** — install with `corepack enable` (built into Node.js) or `npm install -g pnpm`
- **hap-profiles** — must be cloned as a sibling directory (or set `SUVEREN_PROFILES_DIR`)

```
Development/
├── suveren-gateway/ ← you are here
├── hap-profiles/    ← must exist
├── suveren-as/     ← optional, for local AS
└── hap-e2e/         ← optional, for E2E tests
```

## First-Time Setup

```bash
cd suveren-gateway
pnpm install
pnpm build
```

## Running Locally

### One command (recommended)

```bash
pnpm dev
```

This starts all three services concurrently with auto-reload:

| Service | Port | What it does |
|---------|------|-------------|
| UI | 3401 | Vite dev server with hot module replacement |
| Control Plane | 3402 | Auth, vault, AS proxy — auto-restarts on file changes |
| MCP Server | 3431 | Gatekeeper, tool proxy — auto-restarts on file changes |

Open `http://localhost:3401` for the dev UI (proxies API calls to the control plane).

Dev ports are deliberately offset by +1 from the npm-installed CLI's ports (3400/3430) so both can run in parallel — npm CLI on `:3400` + dev on `:3401`. The npm CLI's port set is reserved as the "official" install path.

### Individual services

If you only need to work on one part:

```bash
pnpm dev:ui        # UI only (port 3401, HMR)
pnpm dev:control   # Control plane only (port 3402, auto-restart)
pnpm dev:mcp       # MCP server only (port 3431, auto-restart)
```

### With local AS

To run against a local Authority Server instead of production:

```bash
# Terminal 1 — start local AS
cd ../suveren-as && pnpm dev

# Terminal 2 — start gateway pointing to local AS
SUVEREN_AS_URL=http://localhost:4100 pnpm dev
```

### With live AS

By default, the gateway connects to `https://www.suveren.ai`. Just run `pnpm dev` and log in with your AS API key.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SUVEREN_AS_URL` | `https://www.suveren.ai` | Authority Server URL |
| `SUVEREN_CP_PORT` | `3402` (dev) / `3400` (npm CLI) | Control Plane port |
| `SUVEREN_MCP_PORT` | `3431` (dev) / `3430` (npm CLI) | MCP Server port |
| `SUVEREN_MCP_INTERNAL_URL` | `http://127.0.0.1:3431` (dev) / `:3430` (npm CLI) | MCP internal endpoint (Control Plane → MCP) |
| `SUVEREN_INTERNAL_SECRET` | (empty = skip check) | Shared secret for internal endpoints |
| `HAP_UI_DIST` | `../../ui/dist` | Path to built UI assets |
| `SUVEREN_DATA_DIR` | `~/.suveren` | Persistent storage directory |
| `SUVEREN_PROFILES_DIR` | `../../hap-profiles` (relative to cwd) | HAP profiles directory |
| `SUVEREN_MANIFESTS_DIR` | `content/integrations` (resolved from repo) | Integration manifest JSON directory (read-only source) |
| `SUVEREN_INTEGRATIONS_DIR` | `~/.suveren/integrations` | Runtime install target for on-demand MCP npm packages. Must NOT be the manifest dir — the installer writes `package.json` and `node_modules/` here. |

## Testing

```bash
# All tests
pnpm test

# Specific package
pnpm --filter @hap/core test
pnpm --filter @suveren/mcp-server test

# Watch mode
pnpm --filter @suveren/mcp-server test:watch
```

| Package | Tests | What |
|---------|-------|------|
| `hap-core` | 84 | Bounds/context hashing, gatekeeper verification, attestation encoding, hash determinism, profile loading |
| `mcp-server` | 78 | Tool handlers, mandate brief, consumption tracking, gate store encryption, session restore, SP receipt integration |

### Cross-service E2E tests

Run from the [hap-e2e](https://github.com/humanagencyprotocol/hap-e2e) repo:

```bash
cd ../hap-e2e
MOLLIE_TEST_KEY=test_xxx pnpm test
```

## Docker

Docker is for testing production builds, not day-to-day development.

```bash
docker compose up --build
```

Or manually:

```bash
docker build -t suveren-gateway .
docker run -p 7400:3000 -p 7430:3030 \
  -e SUVEREN_AS_URL=https://www.suveren.ai \
  -v $HOME/.suveren:/app/data \
  suveren-gateway
```

## Login Re-sync

After restarting services, a single login in the UI restores the full state:

1. Pushes SP session cookie and vault key to the MCP server
2. Re-pushes all stored service credentials (Mollie access token, etc.)
3. Re-syncs all stored gate content with the SP attestation cache

## Related Repositories

| Repo | Purpose |
|------|---------|
| [hap-core](https://github.com/humanagencyprotocol/hap-core) | Shared protocol types, hashing, verification |
| [hap-sp](https://github.com/humanagencyprotocol/hap-sp) | Suveren Authority Server (attestation signing, receipts, groups) — local dir: `suveren-as/`, GitHub repo not yet renamed |
| [hap-profiles](https://github.com/humanagencyprotocol/hap-profiles) | Profile definitions (spend, ship, data, publish, provision) |
| [hap-e2e](https://github.com/humanagencyprotocol/hap-e2e) | Cross-service E2E test suite |
| [hap-protocol](https://github.com/humanagencyprotocol/hap-protocol) | Protocol specification + website |
