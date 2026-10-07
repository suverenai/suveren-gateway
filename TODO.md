# Suveren gateway — TODO

## Security

- [ ] **Just-in-time credential injection** — Credentials are currently decrypted on login and held in MCP server memory for the entire session. Move to decrypting per-call, only after gatekeeper approves the attestation. Fail-safe: a gatekeeper bypass bug should not expose credentials.
- [ ] **Per-service credential scoping** — All configured credentials are available to the MCP server regardless of which service the attestation authorizes. Scope credential decryption to only the service referenced in the validated attestation. (Each connector *process* already receives only its own credentials — `resolveEnvKeys` — and, since 0.19.x, none of the gateway's own secrets: `connector-env.ts`.)
- [ ] **Credential revocation on attestation expiry** — When an attestation expires, integration subprocesses keep running with credentials in env vars. Kill or restart integration processes when their backing attestation expires.
- [ ] **Integration supply-chain risk** — MCP integrations run as subprocesses with their own credentials in `process.env`. A compromised integration can misuse its own system's credential (stated plainly in `docs/security.md`, decided 2026-10-07). Evaluate sandboxing options (seccomp, network policy).

## Architecture

- [ ] **Separate credential lifecycle from session lifecycle** — Currently tied to login/logout. Consider a vault unlock/lock model independent of SP session.

## UX

_(empty — add items as needed)_
