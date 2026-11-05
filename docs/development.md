# Development

## Prerequisites

- **Node.js 22+** — check with `node -v`
- **pnpm 9+** — install with `corepack enable` (built into Node.js) or `npm install -g pnpm`
- **hap-profiles** — must be cloned as a sibling directory (or set `SUVEREN_PROFILES_DIR`)

```
Development/
├── suveren-gateway/ ← you are here
├── hap-profiles/    ← must exist
├── suveren-as/     ← optional, for local AS
└── suveren-e2e/     ← optional, for E2E tests
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
| `SUVEREN_SIMULATION` | `0` | `1` blocks every connector without a manifest `simulation` marker and forces simulated ones into that mode. Normally set by `bundle/server.js` from the CLI's saved config (`suveren-gateway simulation on\|off`), not by hand — see README's "Simulation mode" section. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | (unset) | Corporate proxy, upper or lower case (lower wins if both set). Honoured for every outbound call to the Authority Server, the update checker, and a remote AI assistant endpoint — see `proxy-env.ts` in both apps and README's "Behind a company proxy" section. A loopback target (incl. control-plane ↔ MCP-server, and a local AI assistant) is never proxied, independent of these. |

## Shared sign-in groups

Connectors that are the same account at the same provider (Gmail and Google Calendar are one Google account) declare it explicitly in their manifest:

```json
"oauth": { "signInGroup": { "id": "google", "name": "Google" }, "authUrl": "...", ... }
```

Nothing is inferred from `authUrl` or `clientId`. `id` is a lowercase slug, `name` is what a card will show. `manifest-loader.ts` refuses a manifest whose `signInGroup` is malformed, and refuses a later member whose `authUrl`, `tokenUrl`, `tokenStorage`, `credentialKeys` or `extraParams` differ from the first member's (one sign-in = one provider, one client, one token slot). Scopes may differ: the sign-in requests the union.

Behaviour (control plane, `lib/sign-in-group.ts`):

- **Sign-in.** `GET /auth/oauth/<any member>/start` signs the whole group in with the union of the members' scopes. The redirect URI stays `/auth/oauth/<that member>/callback`, so no URI has to be added in the provider's console. The token is stored once, in the vault entry `sign-in:<groupId>` (client id/secret, token, `_oauthAccount`, `_oauthConnectedAt`, `_oauthScopes` = what the provider granted).
- **Members.** A member runs on its own vault entry with the group's sign-in fields laid over it, once the group holds a token. The MCP server and every `envMapping` are unchanged. `GET /vault/credentials/<member>` and `/auth/oauth/<member>/health` show the same effective view.
- **Refresh.** Each connector process refreshes with the shared client + token exactly as before; the health probe refreshes with the effective credentials.
- **Sign-out.** `POST /auth/oauth/<member>/disconnect` first revokes every distinct token (the group's and the members' own) at the provider's optional `oauth.revokeUrl` (RFC 7009; Google: `https://oauth2.googleapis.com/revoke`), then removes the group token and each member's own token locally, keeps the client settings, and stops the connectors. Revocation is best-effort: local sign-out happens even if the provider refuses. The response says what happened: `{ ok, signedOut: [ids], revoked: boolean, revocation: [{ target, ok, error? }] }`; `revoked` is false when any revocation failed or no `revokeUrl` is declared.
- **Migration.** Nothing is rewritten on upgrade. Until the group holds a token, every member keeps its own client and token, so two separate tokens keep working. The first SUCCESSFUL group sign-in writes the group token and, only after that is stored, removes the members' own tokens and sign-in metadata (their client settings stay). A failed sign-in changes nothing.
- **Changing the group client.** The token was issued to the old client, so saving a different client id/secret for `sign-in:<id>` signs the group out (token and metadata dropped; members have no token left to fall back on). To let the UI warn first: `PUT /vault/credentials/sign-in:<id>?dryRun=1` with the same body saves nothing and answers `{ ok, dryRun: true, signsOut: boolean, members: [ids] }`. The real save answers `{ ok, signedOut: boolean }`.
- **Scope coverage.** `GET /auth/oauth/<member>/health` answers `{ status: "reconnect_needed", missingScopes: [...] }` when the token works but the scopes the provider granted (`_oauthScopes`) do not cover the member's manifest scopes. Google's short names (`email`, `profile`) and long names (`.../auth/userinfo.email`) count as the same scope. A token with no recorded scopes (a legacy per-connector token) is never flagged.
- **UI data.** `GET /mcp/integrations/manifests` returns `signInGroups: [{ id, name, members, scopes }]` next to `manifests`.

Hand test (needs a person in a browser; no automated test covers a real Google sign-in):

1. Upgrade an install that has Gmail and Calendar signed in separately: both still show connected and work, with no sign-in.
2. Start a sign-in from Gmail: Google's consent screen lists Gmail AND Calendar permissions; after consent both connectors run and show the same account.
3. Restart the gateway: both come back signed in. After step 2 the old per-connector tokens are gone from the vault (only the group token remains).
4. Disconnect: both stop, both show "not connected", the response says `revoked: true`, and the gateway no longer appears under the Google account's third-party access; signing in again needs no client id/secret.
4b. Untick Calendar permissions on Google's consent screen when signing in: Gmail shows ok, Calendar shows "reconnect needed" with the missing scope.
4c. Change the group's client id: a dry run says it signs out; after saving, both show "not connected".
5. Fresh install: enter the Google client settings once (`sign-in:google`), sign in once, both connectors work.

## Connector manifests — pinned versions

Every manifest under `content/integrations/` that installs a connector via npm (`npmPackage` set) must also pin the exact tested version via `npmVersion` (e.g. `"0.3.3"`) — no ranges (`^1.2.3`), no dist-tags (`"latest"`), no git/URL/file specs. `manifest-loader.ts` refuses the whole manifest at load time, by name, if the pin is missing or not an exact semver; `manifest-npm-pin.test.ts` lints every shipped manifest so a new one can't ship without it.

On start, `IntegrationManager.ensureInstalled` (`apps/mcp-server/src/lib/integration-manager.ts`) reads the pin from the **current** loaded manifest (never a persisted copy in `integrations.json`) and brings the installed package to exactly that version — older or newer — before the connector runs, logging the change (e.g. `erp-mcp 0.3.0 → 0.3.3 (pinned by manifest)`). If that install fails, the connector does **not** start: a gateway release ships a tested set of connector versions, the same way it ships a tested set of bundled profiles, and running whatever happens to already be on disk when the pinned install fails would defeat that. An integration with no `npmPackage` pin at all (one added manually, outside any manifest) keeps the original install-once-and-never-touch-it behaviour.

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

Run from the [suveren-e2e](https://github.com/suverenai/suveren-e2e) repo:

```bash
cd ../suveren-e2e
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

## Reports page — posting a sample report without an AI

To see the Reports page (`/reports` in the UI) render its six verifiable
elements without wiring up an AI/tool integration first:

```bash
cd apps/mcp-server
pnpm report:post-sample
```

Posts `test/fixtures/sample-report.html` to the running dev MCP server's
`/internal/report`. On a gateway with no matching receipt archive, every
element correctly renders "not verifiable" — that is the fail-closed
behaviour working, not a bug in the fixture. `test/report/sample-report.test.ts`
is where the same fixture is checked against a matching archive/export,
proving what it resolves to when the evidence actually exists.

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
| [suveren-e2e](https://github.com/suverenai/suveren-e2e) | Cross-service E2E test suite |
| [hap-protocol](https://github.com/humanagencyprotocol/hap-protocol) | Protocol specification + website |
