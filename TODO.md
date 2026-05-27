# Suveren gateway — TODO

## Security

- [ ] **Just-in-time credential injection** — Credentials are currently decrypted on login and held in MCP server memory for the entire session. Move to decrypting per-call, only after gatekeeper approves the attestation. Fail-safe: a gatekeeper bypass bug should not expose credentials.
- [ ] **Per-service credential scoping** — All configured credentials are available to the MCP server regardless of which service the attestation authorizes. Scope credential decryption to only the service referenced in the validated attestation.
- [ ] **Credential revocation on attestation expiry** — When an attestation expires, integration subprocesses keep running with credentials in env vars. Kill or restart integration processes when their backing attestation expires.
- [ ] **Integration supply-chain risk** — MCP integrations run as subprocesses with credentials in `process.env`. A compromised integration can read and exfiltrate secrets. Evaluate sandboxing options (seccomp, network policy, read-only env).

## Architecture

- [ ] **Separate credential lifecycle from session lifecycle** — Currently tied to login/logout. Consider a vault unlock/lock model independent of SP session.

## UX

_(empty — add items as needed)_
