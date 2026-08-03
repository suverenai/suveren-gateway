/**
 * Incoming argument normalization — one spelling for one thing.
 *
 * A content binding hashes an exact string, so two spellings of the same value
 * are two different bindings. For prose that is harmless (nobody writes a body
 * two ways by accident). For an identifier it is fatal:
 *
 *   https://hap-abc123.vercel.app        ← what the approver pasted
 *   https://hap-abc123.vercel.app/       ← what the released page knows
 *
 * Same build, different hash, and the receipt for it can never be found. Worse,
 * the failure is indistinguishable from "these bytes went live without
 * approval" — so a mismatched trailing slash reads as a security incident.
 *
 * WHERE THIS RUNS MATTERS. It is applied at the very start of a gated call,
 * BEFORE the execution context is mapped, before a proposal is created, and
 * before anything is hashed. So the value a human approves, the value bound
 * into the receipt, and the value sent downstream are the same string. Doing it
 * later would bind something the approver never saw — the failure the
 * display-equals-binding rule exists to prevent.
 *
 * Declared per connector, implemented here: the engine owns the normal forms, a
 * manifest names which argument takes which — the same shape as `contentField`,
 * `blockedArgs` and `argEncoding`. The deploy profile is explicit that the
 * artifact identifier "is named by the connector manifest and never by this
 * profile", so its spelling is the connector's business too.
 *
 * A verifier reproducing a hash MUST apply the same rule, which is why the
 * normal form is written down rather than left to whatever `new URL()` happens
 * to do.
 */

import type { DiscoveredTool } from './integration-manager';

/** Normal forms the engine knows. Named by a manifest, per argument. */
export type ArgNormalization = 'url' | 'sha';

/**
 * The stated normal form for a URL that identifies a THING rather than a page:
 * a deployment, an artifact, a build.
 *
 *   1. Trim surrounding whitespace.
 *   2. Add `https://` when no scheme is present, so `x.app` and `https://x.app`
 *      converge — that pair is the whole reason this exists.
 *   3. Lowercase the scheme and host (DNS is case-insensitive; people are not).
 *   4. Drop a default port (`:443` on https, `:80` on http).
 *   5. Drop path, query and fragment — the URL names a build, not a page on it.
 *   6. Drop credentials.
 *   7. No trailing slash.
 *
 * Result: `<scheme>://<host>`.
 *
 * `http` is NOT rewritten to `https`. They are different origins, and silently
 * upgrading one to the other would bind a value that was never used.
 *
 * A string that does not parse as a URL is returned UNCHANGED. Connectors
 * already validate this argument and produce a clear message; failing here
 * would replace it with a worse one.
 */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return value; // not a URL — leave it to the connector's own validation
  }
  if (!url.hostname) return value;

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  const defaultPort = (scheme === 'https' && url.port === '443') || (scheme === 'http' && url.port === '80');
  const port = url.port && !defaultPort ? `:${url.port}` : '';

  return `${scheme}://${host}${port}`;
}

/**
 * A hex digest — a commit sha, an image digest. Lowercased and trimmed.
 *
 * Git renders shas lowercase but accepts either case, so `ABC123…` and
 * `abc123…` name one commit and would otherwise hash to two bindings. Same
 * failure as the trailing slash on a URL: the receipt becomes unfindable, and
 * unfindable reads as never-approved.
 */
export function normalizeSha(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{7,64}$/.test(trimmed) ? trimmed.toLowerCase() : value;
}

const NORMALIZERS: Record<ArgNormalization, (value: string) => string> = {
  url: normalizeUrl,
  sha: normalizeSha,
};

/**
 * Apply the tool's declared `argNormalization` to incoming arguments.
 *
 * Returns `args` unchanged when nothing is declared or nothing changed, so a
 * connector that declares none is untouched and object identity is preserved
 * for the common path.
 */
export function normalizeIncomingArgs(
  tool: DiscoveredTool | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const declared = tool?.gating?.argNormalization;
  if (!declared || !args) return args;

  let out: Record<string, unknown> | null = null;
  for (const [field, form] of Object.entries(declared)) {
    const normalize = NORMALIZERS[form as ArgNormalization];
    if (!normalize) {
      // A manifest naming a form this gateway does not implement. Leave the
      // value alone and say so: silently rewriting an approved identifier is
      // the failure being prevented, and silently skipping is worth knowing.
      console.error(
        `[Suveren MCP] Warning: ${tool?.namespacedName} declares argNormalization "${form}" ` +
          `for "${field}", which this gateway does not implement. Using the value as supplied.`,
      );
      continue;
    }
    const value = args[field];
    if (typeof value !== 'string') continue;
    const normalized = normalize(value);
    if (normalized === value) continue;
    out ??= { ...args };
    out[field] = normalized;
  }
  return out ?? args;
}
