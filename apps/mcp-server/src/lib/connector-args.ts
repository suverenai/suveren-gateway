/**
 * The command-line arguments a connector is spawned with — and the rule that
 * no credential ever ends up in them.
 *
 * A program's arguments are not private: on macOS and Linux every user on the
 * computer can read them (`ps`), on Windows the same user and administrators
 * can. A program's environment is readable only by the same user (and root).
 * So a connector's credentials travel in its environment, never in its
 * arguments.
 *
 * Some connector programs need a credential INSIDE an argument (mcp-remote's
 * `--header "Authorization: Bearer ${TOKEN}"`). Such a program can replace
 * `${VAR}` itself, from its own environment (mcp-remote 0.14.3 does this for
 * every `--header` value). Its manifest says so with
 * `mcp.expandsEnvInArgs: true`; the gateway then leaves the placeholder in the
 * argument and hands the value over in the environment only.
 *
 * Without that declaration a placeholder that names a vault-supplied variable
 * is refused, and — as a second, independent check — a connector whose final
 * arguments contain the VALUE of a secret is refused too. Both errors name the
 * connector and the variable, never the value.
 *
 * `resolvedArgs` (every placeholder replaced in memory, exactly as the gateway
 * did before) exists only for the remote-auth preflight, which must send the
 * real header itself. It is never spawned and never logged.
 */

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class CredentialInArgsError extends Error {
  constructor(
    readonly connectorId: string,
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialInArgsError';
  }
}

export interface SpawnArgsInput {
  connectorId: string;
  /** The configured arguments, with `${VAR}` placeholders as written. */
  args: readonly string[];
  /** Values the vault resolved for this connector (credentials and settings). */
  vaultEnv: Readonly<Record<string, string>>;
  /** Every variable the vault supplies to this connector, resolved or not. */
  vaultVarNames: ReadonlySet<string>;
  /** The subset of `vaultVarNames` whose values are secrets. */
  secretVarNames: ReadonlySet<string>;
  /** The connector's inherited (allowlisted, non-secret) environment. */
  inherited: Readonly<Record<string, string>>;
  /** The manifest's `mcp.expandsEnvInArgs`. */
  connectorExpandsEnv: boolean;
}

export interface SpawnArgs {
  /** What the process is spawned with. Never contains a vault value. */
  spawnArgs: string[];
  /** In memory only, for the remote-auth preflight. Never spawn or log this. */
  resolvedArgs: string[];
}

export function buildSpawnArgs(input: SpawnArgsInput): SpawnArgs {
  const { connectorId, args, vaultEnv, vaultVarNames, secretVarNames, inherited, connectorExpandsEnv } = input;

  // Unchanged from before: vault first, then the inherited allowlist, else ''.
  const resolvedArgs = args.map((a) =>
    a.replace(PLACEHOLDER_RE, (_m, name: string) => vaultEnv[name] ?? inherited[name] ?? ''),
  );

  const spawnArgs = args.map((a) =>
    a.replace(PLACEHOLDER_RE, (match, name: string) => {
      // The program expands every placeholder itself, from the environment
      // the gateway gives it (which holds the vault values AND the inherited
      // allowlist) — leave them all in place.
      if (connectorExpandsEnv) return match;
      if (vaultVarNames.has(name)) {
        throw new CredentialInArgsError(
          connectorId,
          name,
          `${connectorId}: not started — its arguments would carry the credential \${${name}}, ` +
            `and a program's arguments can be read by other programs on this computer. ` +
            `Only a connector whose program reads \${${name}} from its own environment may name it in its ` +
            `arguments; its manifest then declares mcp.expandsEnvInArgs.`,
        );
      }
      return inherited[name] ?? '';
    }),
  );

  // Second, independent check: the VALUE of a secret must not appear in any
  // argument, however it got there (a saved config with a pasted token, a
  // custom connector, a future manifest).
  for (const name of secretVarNames) {
    const value = vaultEnv[name];
    if (!value) continue;
    if (spawnArgs.some((a) => a.includes(value))) {
      throw new CredentialInArgsError(
        connectorId,
        name,
        `${connectorId}: not started — the value of the credential ${name} appears in its arguments, ` +
          `where other programs on this computer can read it. Remove it from the arguments; ` +
          `the connector receives it in its environment.`,
      );
    }
  }

  return { spawnArgs, resolvedArgs };
}

/**
 * Replace every known secret value in `text` with `[redacted]`. For any text
 * the gateway shows or logs that a connector or its start-up produced (error
 * messages, captured stderr). Longest values first, so a value that contains
 * another is not left half-visible.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const values = [...new Set([...secrets].filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('[redacted]');
  return out;
}
