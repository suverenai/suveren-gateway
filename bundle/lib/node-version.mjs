/**
 * Minimum Node.js version for the gateway — checked at start by
 * bundle/bin/suveren-gateway.js and bundle/server.js.
 *
 * The connectors the gateway installs (crm, erp, email, records — all built on
 * better-sqlite3 13) need Node 22. `engines` in package.json is not enough:
 * npm only WARNS on a mismatch, and for an unpinned install it silently picks
 * an older connector that still runs on the old Node. With pinned connector
 * versions the pinned connector is installed anyway and crashes on its first
 * database call. Refusing at start, with the reason, is the only visible
 * failure. Keep MIN_NODE_MAJOR in step with `engines` in package.json.tpl.
 */

export const MIN_NODE_MAJOR = 22;

/**
 * Returns null when `version` (e.g. process.versions.node, "22.11.0") is
 * supported, otherwise a message naming both versions. An unparseable version
 * is refused — the safe direction.
 */
export function unsupportedNodeReason(version) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  return (
    `Suveren gateway needs Node.js ${MIN_NODE_MAJOR} or newer — this is Node.js ${version}. ` +
    `Install a current Node.js (https://nodejs.org) and start the gateway again.`
  );
}
