# Managed settings (IT policy)

Lets a company's IT preset gateway settings centrally so an employee cannot
change them locally. This is the reference for the mechanism; the full IT
setup guide (Windows installer track) links here rather than duplicating it.

## Policy sources, highest precedence first

1. **Windows registry** — `HKLM\SOFTWARE\Policies\Suveren\Gateway`, then
   `HKCU\SOFTWARE\Policies\Suveren\Gateway` (HKLM wins over HKCU). Read via
   `reg query` (child_process) — no native modules. Skipped entirely on
   non-Windows.
2. **A JSON policy file**:
   - Windows: `%ProgramData%\Suveren\gateway-policy.json`
   - macOS: `/Library/Application Support/Suveren/gateway-policy.json`
   - Linux: `/etc/suveren/gateway-policy.json`
   - Overridable for tests/automation via the `SUVEREN_POLICY_FILE` env var
     (any platform).

Registry value names = JSON file keys (PascalCase):

| Key | Type | Meaning |
|---|---|---|
| `AsUrl` | string | Authority Server URL |
| `CaFile` | string | Path to a CA bundle for internal TLS |
| `PinTls` | DWORD 0/1 or boolean | TLS certificate pinning |
| `Simulation` | DWORD 0/1 or boolean | Simulation mode (blocks real connectors) |
| `InstallMethod` | string | Only `"managed"` is recognized |

A key present in **either** source is **locked**: nothing running on that
machine can override it — not a CLI flag, not an env var, not a saved
`config.json`, not even setting `SUVEREN_SIMULATION` directly in the shell.

## Overall precedence

```
IT policy  >  env var  >  saved config.json  >  built-in default
```

A policy value is validated with the exact same rules as `config set` (e.g.
`AsUrl` must be `https://`, or `http://localhost`/`http://127.0.0.1`) —
an invalid policy value makes every process refuse to start, loudly, naming
the key, the bad value, and which source it came from (registry hive or file
path). This is deliberate: an IT-pushed typo must be obvious immediately,
not silently ignored.

## Where this is enforced

Three mirrored implementations (no shared runtime package between the CLI
and the two apps — see `bundle/lib/config.mjs`'s doc comment for the
established pattern):

- `bundle/lib/policy.mjs` (+ `policy.d.mts`) — used by the CLI
  (`bundle/bin/suveren-gateway.js`) and `bundle/server.js`
- `apps/mcp-server/src/lib/policy.ts`
- `apps/control-plane/src/lib/policy.ts`

Wired into every settings resolver: `resolveAsUrl`, `resolveCaFile`,
`resolvePinTls` (`as-config.ts` / `config.mjs`), and `resolveSimulation` /
`isSimulationMode` (`config.mjs` / `simulation-mode.ts` in both apps).

## What the employee sees

- `suveren-gateway config get` shows `(set by your IT)` next to a locked
  value.
- `suveren-gateway config set as-url|ca-file|pin-tls …` and
  `suveren-gateway simulation on|off` refuse outright on a locked key,
  naming the policy value, before any validation or write.
- The control-plane's `/health` reports `policyLocked` (an array of locked
  setting keys) and, for a managed install, `installMethod: "managed"` —
  the signal the update banner uses to skip the `npm install -g …` command
  (an employee on a managed install has no permission to run it) and say
  instead that updates come from the company's IT. `/as-pairing` reports
  `asUrlLockedByPolicy` / `pinTlsLockedByPolicy` for the Settings page.

## Install method

An install counts as `managed` when either is true:

- env var `SUVEREN_INSTALL_METHOD=managed`
- policy `InstallMethod=managed`

This pre-empts the normal Docker/npm/dev auto-detection (`detectInstallMethod`
in `apps/control-plane/src/index.ts`) and `managed` compares against the npm
registry the same way `npm` does — an IT-provisioned install is still
physically an npm install underneath; only the banner text differs.

## Test-only env vars — never set these in production

- `SUVEREN_POLICY_REGISTRY=off` disables the registry source entirely
  (returns nothing, without even spawning `reg`). Set globally for every
  test file via each app's `vitest.setup.ts`, so a real IT policy already
  present on the machine running the suite — or another workspace package's
  test writing to the registry at the same time, since `pnpm -r test` runs
  every package in parallel — cannot change what a unit test observes.
- `SUVEREN_POLICY_REGISTRY_KEY` overrides the registry base key (default:
  the documented `SOFTWARE\Policies\Suveren\Gateway`). Used only by
  `gateway-policy-windows-registry.test.ts`, which points it at a unique
  per-test key so its real `reg add`/`reg delete` calls can never collide
  with the real documented key, or with themselves across parallel runs.

Neither variable is part of the policy contract above — the production
defaults (HKLM then HKCU at the documented path) are covered by their own
test asserting exactly that.

## Testing

- `apps/control-plane/src/__tests__/gateway-policy.test.ts` — precedence,
  per-key locking, invalid-value refusal, registry-output parsing (against
  captured fixture text), and that `registryKeyPath()` defaults to the
  documented path when no test override is set.
- `apps/control-plane/src/__tests__/gateway-policy-windows-registry.test.ts`
  — the real `reg add` / `reg query` / `reg delete` path, against a unique
  per-test registry key; skipped on non-Windows, runs on
  `.github/workflows/bundle-smoke.yml`'s `unit` job (windows-latest leg).
- `apps/control-plane/src/__tests__/gateway-cli-managed-settings.test.ts` —
  spawns the real CLI to prove the refusals end to end.
- `apps/*/src/lib/__tests__/as-config.test.ts` /
  `simulation-mode.test.ts` — policy-locked precedence for each resolver.
