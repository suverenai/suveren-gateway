/**
 * Who is calling the Authority Server — the control plane's login request.
 *
 * Mirrors `apps/mcp-server/src/lib/client-version.ts` (same detection logic,
 * duplicated because the two apps are separate published bundles with no
 * shared internal package). Keep the two in step if either changes.
 *
 * This exists specifically because the AS decides the SESSION LENGTH from
 * this header: a login carrying `x-suveren-gateway-version` gets a 30-day
 * gateway session; one without it gets the old 24-hour browser session. A
 * version the client volunteers is never used for authorization — only for
 * this kind of behavioural negotiation and for compatibility reporting.
 *
 * Resolution never throws: an unknown version must degrade to "unknown",
 * never to a failed AS call.
 */

import { readFileSync } from 'node:fs';
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
 * The distributed gateway version — NOT this workspace package's own
 * `0.1.0`, which would be meaningless to a server operator.
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

  return process.env.HAP_BUILD_SHA ?? UNKNOWN;
}

/** Resolved once — cannot change while the process is running. */
export const GATEWAY_VERSION = detectGatewayVersion();

/**
 * Headers sent on the control plane's own calls to the Authority Server
 * (today: just login). `x-` names rather than a parsed User-Agent, matching
 * the MCP server's client-version.ts.
 */
export function clientVersionHeaders(): Record<string, string> {
  return {
    'x-suveren-gateway-version': GATEWAY_VERSION,
  };
}
