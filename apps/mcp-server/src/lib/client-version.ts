/**
 * Who is calling the Authority Server.
 *
 * The AS had no way to tell which gateway was talking to it. That made a
 * question unanswerable that matters every time the wire contract tightens:
 * *how many deployed gateways would this break, and what do we tell them?*
 * A version the client volunteers cannot be trusted for authorization — and
 * is not used for any — but it is exactly what is needed for compatibility
 * reporting and for an error message that says "upgrade to X" instead of
 * rejecting a request opaquely.
 *
 * Two versions are reported, because they answer different questions:
 *
 *  - the **gateway** version — what the operator installed, the thing an
 *    upgrade instruction can name;
 *  - the **hap-core** version — the shared wire contract (canonicalization,
 *    hashing, types). This is the one that can make two conformant
 *    implementations disagree about bytes, so it is worth seeing directly
 *    rather than inferring from the product version.
 *
 * Resolution never throws: an unknown version must degrade to "unknown", never
 * to a failed AS call.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UNKNOWN = 'unknown';

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The distributed gateway version — NOT this workspace package's version,
 * which is an internal `0.1.0` and would be meaningless to a server operator.
 *
 * Install modes differ and all three have to work:
 *  - npm bundle: `@suveren/gateway` package.json sits a few levels above dist
 *  - dev monorepo: the root `suveren-gateway` package.json
 *  - Docker: no meaningful npm version; the image stamps a git SHA
 */
function detectGatewayVersion(): string {
  const override = process.env.SUVEREN_GATEWAY_VERSION;
  if (override) return override;

  const start = import.meta.dirname ?? process.cwd();
  let dir = start;
  for (let up = 0; up < 6; up++) {
    const pkg = readJson(join(dir, 'package.json'));
    const name = pkg?.name;
    const version = pkg?.version;
    if (typeof version === 'string' && (name === '@suveren/gateway' || name === 'suveren-gateway')) {
      return version;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Docker stamps the source SHA; it is not a semver but it identifies a build
  // exactly, which is what the AS needs for reporting.
  return process.env.HAP_BUILD_SHA ?? UNKNOWN;
}

/**
 * The resolved `@humanagencyp/hap-core` version actually loaded at runtime.
 *
 * Two layouts, and only `@hap/core` exists in both:
 *
 *  - **npm bundle**: `@hap/core` is an npm *alias* for the published package
 *    (`"@hap/core": "npm:@humanagencyp/hap-core@…"`), so the manifest found at
 *    that specifier already IS hap-core's own.
 *  - **dev workspace**: `@hap/core` is the thin wrapper package, which merely
 *    re-exports hap-core — so one more hop is needed, resolved from the
 *    wrapper's own location because the app itself does not depend on the
 *    published name and cannot resolve it directly.
 *
 * Getting this wrong is invisible in tests run from source (where the hoisted
 * workspace root happens to resolve the published name) and silently reports
 * "unknown" from `dist/`, which is where it actually runs.
 */
function findPackageVersion(entry: string, wantName: string): string | null {
  let dir = join(entry, '..');
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = readJson(candidate);
      if (typeof pkg?.version === 'string' && (pkg.name === wantName || pkg.name === '@hap/core')) {
        // In the bundle the alias means name === '@humanagencyp/hap-core'
        // already; in dev the wrapper answers to '@hap/core' and is handled
        // by the caller's second hop.
        return pkg.name === wantName ? pkg.version : null;
      }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectHapCoreVersion(): string {
  const CORE = '@humanagencyp/hap-core';
  let req: NodeRequire;
  try {
    req = createRequire(import.meta.url);
  } catch {
    return UNKNOWN;
  }

  // 1. Directly resolvable (hoisted install, or the AS-style layout).
  try {
    const v = findPackageVersion(req.resolve(CORE), CORE);
    if (v) return v;
  } catch { /* not resolvable from here */ }

  // 2. Via `@hap/core` — the alias in the bundle, the wrapper in dev.
  try {
    const wrapperEntry = req.resolve('@hap/core');
    const v = findPackageVersion(wrapperEntry, CORE);
    if (v) return v;

    // Dev: hop from the wrapper's own location to what it depends on.
    const wrapperReq = createRequire(wrapperEntry);
    const v2 = findPackageVersion(wrapperReq.resolve(CORE), CORE);
    if (v2) return v2;
  } catch { /* fall through */ }

  return UNKNOWN;
}

/** Resolved once — these cannot change while the process is running. */
export const GATEWAY_VERSION = detectGatewayVersion();
export const HAP_CORE_VERSION = detectHapCoreVersion();

/**
 * Headers sent on every Authority Server call.
 *
 * `x-` names rather than a parsed User-Agent: the AS should not have to
 * pattern-match a free-form string to answer a compatibility question, and
 * intermediaries rewrite User-Agent more readily than they invent headers.
 */
export function clientVersionHeaders(): Record<string, string> {
  return {
    'x-suveren-gateway-version': GATEWAY_VERSION,
    'x-hap-core-version': HAP_CORE_VERSION,
  };
}
