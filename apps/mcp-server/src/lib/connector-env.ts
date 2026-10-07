/**
 * The environment a connector process starts with.
 *
 * Connectors used to inherit the gateway's whole environment (`...process.env`).
 * That handed every connector the gateway's own secrets — `SUVEREN_INTERNAL_SECRET`
 * (which opens the control-plane ↔ MCP `/internal/*` routes) and
 * `SUVEREN_AS_API_KEY` when set — plus whatever else the user's shell carried.
 * A connector now gets only:
 *
 * - what the operating system and Node need to run a program (below),
 * - the corporate proxy and CA settings (W1: connectors must reach their
 *   service through the same proxy and trust the same company root),
 * - variables its manifest names in `mcp.passEnv` (e.g. erp's
 *   `ERP_COMPANY_FILE`, a seed file the operator sets on the gateway),
 * - and, added by the caller: PATH, HAP_DATA_DIR, the manifest's `mcp.env`,
 *   and its OWN credentials from the vault.
 *
 * What a connector still holds is its own system's credential, for as long as
 * it runs — inherent to a local MCP connector, and stated in docs/security.md.
 */

/** Needed to run a program at all, per platform. Superset of the MCP SDK's
 *  `getDefaultEnvironment()` list. */
const RUNTIME_VARS = [
  // POSIX
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  // Windows (names are case-insensitive there; matched case-insensitively below)
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
];

/** Network settings a connector must share with the gateway. */
const NETWORK_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];

/**
 * Pick the inherited part of a connector's environment from `parent`.
 * Names match case-insensitively (Windows env names are; proxy variables are
 * conventionally read in both cases), and the original spelling is kept.
 */
export function inheritedConnectorEnv(
  parent: NodeJS.ProcessEnv,
  passEnv: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set([...RUNTIME_VARS, ...NETWORK_VARS, ...passEnv].map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (allowed.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}
