/**
 * Manual MCP connection instructions per AI client.
 *
 * These are the verified-working configs, not the MCP SDK's generic "just put
 * a URL in the config" form — several clients don't actually support that:
 * Claude Desktop's config file has no field for a remote URL at all, so it
 * goes through the `mcp-remote` stdio bridge instead. Getting this wrong
 * means someone pastes a snippet that silently does nothing.
 *
 * Shared by SetupGuide's "Connect your agent" step and the dashboard
 * first-run card's "Set it up by hand" fold (see McpConnectDetails.tsx) so
 * the two surfaces never drift apart.
 */
export interface McpClientConfig {
  label: string;
  snippet: (endpoint: string) => string;
}

export const MCP_CONFIGS: Record<string, McpClientConfig> = {
  'claude-code': {
    label: 'Claude Code',
    snippet: (ep) => `claude mcp add --transport http suveren ${ep}/mcp`,
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    // Claude Desktop's config file cannot take a remote URL directly — the
    // working entry goes through the mcp-remote stdio bridge.
    snippet: (ep) => `Add to ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop:\n\n${JSON.stringify({
      mcpServers: {
        suveren: { command: 'npx', args: ['mcp-remote@latest', `${ep}/mcp`, '--allow-http'] },
      },
    }, null, 2)}`,
  },
  'chatgpt-codex': {
    label: 'ChatGPT / Codex',
    // ~/.codex/config.toml is shared by the Codex CLI and ChatGPT's local sessions.
    snippet: (ep) => `Add to ~/.codex/config.toml:\n\n[mcp_servers.suveren]\nurl = "${ep}/mcp"\n\nOr: codex mcp add suveren --url ${ep}/mcp`,
  },
  other: {
    label: 'Other',
    snippet: (ep) => `Streamable HTTP:  POST ${ep}/mcp\nSSE transport:    GET  ${ep}/sse\nHealth check:     GET  ${ep}/health`,
  },
};

/** Render order for the tab strip — Record key order isn't a contract. */
export const MCP_CONFIG_ORDER: readonly string[] = ['claude-code', 'claude-desktop', 'chatgpt-codex', 'other'];
