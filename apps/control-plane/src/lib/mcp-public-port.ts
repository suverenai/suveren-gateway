/**
 * The port AI assistants use to reach this gateway's MCP server, as shown in
 * the UI's "connect your assistant" snippet.
 *
 * The UI used to guess it from its own port (3400 → 3430, anything else →
 * 7430), which was wrong for a custom port (`config set port` / the Windows
 * installer's PORT) and for dev (:3401 → :3431). The control plane knows:
 *
 *   1. SUVEREN_MCP_PUBLIC_PORT — when the outside port differs from the one
 *      the server binds (Docker maps container 3030 to host 7430).
 *   2. SUVEREN_MCP_PORT — set by bundle/server.js for both children.
 *   3. The port in the internal MCP URL (dev sets only that).
 */
export function mcpPublicPort(env: NodeJS.ProcessEnv = process.env, internalUrl?: string): number | null {
  for (const raw of [env.SUVEREN_MCP_PUBLIC_PORT, env.SUVEREN_MCP_PORT]) {
    const n = Number(raw);
    if (raw && Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  try {
    const url = new URL(internalUrl ?? env.SUVEREN_MCP_INTERNAL_URL ?? '');
    const n = Number(url.port);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    /* no usable URL */
  }
  return null;
}
