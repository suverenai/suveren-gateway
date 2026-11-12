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
 * `${VAR}` itself, from its own environment — but only in the arguments it
 * says it does (mcp-remote 0.14.3: the value after every `--header`). The
 * manifest names exactly those:
 *
 *   "expandsEnvInArgs": { "afterOption": ["--header"] }
 *
 * = "the program fills in `${VAR}` in the argument that directly follows
 * `--header`". There, the gateway leaves every placeholder in place and hands
 * the values over in the environment only.
 *
 * Everywhere else (and in every argument of a manifest without the field):
 *   - a placeholder naming a vault-supplied variable refuses the start (and
 *     the manifest loader refuses such a manifest — `vaultPlaceholderOutsideReason`);
 *   - a placeholder naming any other variable is filled in by the gateway
 *     from the inherited allowlist, as always.
 * Independently, a connector whose final arguments contain the VALUE of a
 * secret is refused. Every error names the connector and the variable, never
 * the value.
 *
 * `resolvedArgs` (every placeholder replaced in memory, exactly as the gateway
 * did before) exists only for the remote-auth preflight, which must send the
 * real header itself. It is never spawned and never logged.
 */

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The manifest's `mcp.expandsEnvInArgs`. */
export interface ExpandsEnvInArgs {
  /** Options whose following argument the program itself fills `${VAR}` into. */
  afterOption: string[];
}

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

/** Indexes of the arguments the program expands itself: each one right after a declared option. */
export function programExpandedPositions(args: readonly string[], expands: ExpandsEnvInArgs | undefined): Set<number> {
  const out = new Set<number>();
  if (!expands) return out;
  for (let i = 1; i < args.length; i++) {
    if (expands.afterOption.includes(args[i - 1])) out.add(i);
  }
  return out;
}

function placeholderNames(arg: string): string[] {
  return [...arg.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * For the manifest loader: the first vault placeholder in `args` that sits
 * outside the positions the program expands itself, as a refusal reason —
 * or null. `vaultVarNames` = the manifest's `credentials.envMapping` keys.
 */
export function vaultPlaceholderOutsideReason(
  args: readonly string[],
  vaultVarNames: ReadonlySet<string>,
  expands: ExpandsEnvInArgs | undefined,
): string | null {
  const expanded = programExpandedPositions(args, expands);
  for (const [i, arg] of args.entries()) {
    if (expanded.has(i)) continue;
    const name = placeholderNames(arg).find((n) => vaultVarNames.has(n));
    if (name) {
      return `mcp.args[${i}] names the credential \${${name}}, but a credential may only appear in an argument ` +
        `the program fills in itself (declared in mcp.expandsEnvInArgs.afterOption) — otherwise it would be ` +
        `written into the command line, which other programs on the computer can read`;
    }
  }
  return null;
}

/** Shape check for the manifest loader. */
export function invalidExpandsEnvInArgsShapeReason(raw: unknown): string | null {
  if (raw === undefined) return null;
  const shape = 'mcp.expandsEnvInArgs must be { "afterOption": ["--option", ...] }';
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return shape;
  const extra = Object.keys(raw).find((k) => k !== 'afterOption');
  if (extra) return `${shape} — unknown key "${extra}"`;
  const opts = (raw as { afterOption?: unknown }).afterOption;
  if (!Array.isArray(opts) || opts.length === 0) return shape;
  for (const o of opts) {
    if (typeof o !== 'string' || !/^-{1,2}[A-Za-z0-9][\w-]*$/.test(o)) {
      return `${shape} — ${JSON.stringify(o)} is not an option name like "--header"`;
    }
  }
  return null;
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
  /** The manifest's `mcp.expandsEnvInArgs`, if any. */
  expandsEnvInArgs: ExpandsEnvInArgs | undefined;
}

export interface SpawnArgs {
  /** What the process is spawned with. Never contains a vault value. */
  spawnArgs: string[];
  /** In memory only, for the remote-auth preflight. Never spawn or log this. */
  resolvedArgs: string[];
}

export function buildSpawnArgs(input: SpawnArgsInput): SpawnArgs {
  const { connectorId, args, vaultEnv, vaultVarNames, secretVarNames, inherited, expandsEnvInArgs } = input;

  // Unchanged from before: vault first, then the inherited allowlist, else ''.
  const resolvedArgs = args.map((a) =>
    a.replace(PLACEHOLDER_RE, (_m, name: string) => vaultEnv[name] ?? inherited[name] ?? ''),
  );

  const expanded = programExpandedPositions(args, expandsEnvInArgs);
  const spawnArgs = args.map((a, i) => {
    // The program fills this argument in itself, from the environment the
    // gateway gives it (vault values AND the inherited allowlist).
    if (expanded.has(i)) return a;
    return a.replace(PLACEHOLDER_RE, (_match, name: string) => {
      if (vaultVarNames.has(name)) {
        throw new CredentialInArgsError(
          connectorId,
          name,
          `${connectorId}: not started — its arguments would carry the credential \${${name}}, ` +
            `and a program's arguments can be read by other programs on this computer. ` +
            `A credential may only appear in an argument the program fills in itself, from its own ` +
            `environment; the connector's manifest names those in mcp.expandsEnvInArgs.afterOption.`,
        );
      }
      return inherited[name] ?? '';
    });
  });

  // Second, independent check: the VALUE of a secret must not appear in any
  // argument, however it got there (a saved config with a pasted token, a
  // custom connector, a future manifest). No minimum length: a short secret
  // in the arguments is still a leak, and a refusal is visible and explained
  // while a skipped check is silent. The message says a match may be a
  // coincidence — without the value or its length.
  for (const name of secretVarNames) {
    const value = vaultEnv[name];
    if (!value) continue;
    if (spawnArgs.some((a) => a.includes(value))) {
      throw new CredentialInArgsError(
        connectorId,
        name,
        `${connectorId}: not started — the value of the credential ${name} appears in its arguments, ` +
          `where other programs on this computer can read it. If that value is very short, this may be a ` +
          `coincidence (it happens to occur in an address or option). Either way, remove it from the arguments ` +
          `(the connector receives ${name} in its environment), or use a longer ${name}.`,
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
