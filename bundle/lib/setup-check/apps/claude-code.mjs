/**
 * Claude Code — described as data for the Setup check engine. Every field
 * is explained in the header of ../engine.mjs.
 *
 * Every location and key here comes from the vendor's documentation and has
 * not yet been tested on a real install (`verified: false`) — except
 * managed-mcp.json on Windows, tested 2026-11-12 with Claude Code 2.1.322.
 */
export default {
  id: 'claude-code',
  name: 'Claude Code',
  account: 'Claude account',

  detect: {
    paths: [
      { all: '{home}/.claude.json' },
      { all: '{home}/.claude' },
    ],
    pathBinaries: ['claude'],
  },

  sources: [
    { id: 'user-config', role: 'user', format: 'json', verified: false, path: { all: '{home}/.claude.json' } },
    { id: 'user-settings', role: 'user', format: 'json', verified: false, path: { all: '{home}/.claude/settings.json' } },
    // Only the projects Claude Code itself lists in ~/.claude.json — the disk
    // is never crawled.
    { id: 'project-mcp', role: 'user', format: 'json', verified: false,
      expand: { source: 'user-config', pointer: ['projects'], relPath: ['.mcp.json'] } },
    { id: 'project-settings', role: 'user', format: 'json', verified: false,
      expand: { source: 'user-config', pointer: ['projects'], relPath: ['.claude', 'settings.json'] } },
    { id: 'project-settings-local', role: 'user', format: 'json', verified: false,
      expand: { source: 'user-config', pointer: ['projects'], relPath: ['.claude', 'settings.local.json'] } },
    { id: 'managed-settings', role: 'lock', format: 'json', verified: false, path: {
      darwin: '{root}/Library/Application Support/ClaudeCode/managed-settings.json',
      linux: '{root}/etc/claude-code/managed-settings.json',
      win32: '{programFiles}\\ClaudeCode\\managed-settings.json',
    } },
    { id: 'managed-mcp', role: 'lock', format: 'json', verified: false, path: {
      darwin: '{root}/Library/Application Support/ClaudeCode/managed-mcp.json',
      linux: '{root}/etc/claude-code/managed-mcp.json',
      win32: { path: '{programFiles}\\ClaudeCode\\managed-mcp.json',
        verified: 'tested 2026-11-12 with Claude Code 2.1.322 on Windows 11' },
    } },
  ],

  connectors: [
    { source: 'user-config', pointer: ['mcpServers'] },
    { source: 'user-config', pointer: ['projects', '*', 'mcpServers'] },
    { source: 'project-mcp', pointer: ['mcpServers'] },
  ],

  connectorLocks: [
    // managed-mcp.json: when present, its servers are the only ones.
    // Observed with Claude Code 2.1.322 on Windows 11 (2026-11-12): while
    // this file exists, `claude mcp add` is refused for every scope and
    // connectors added earlier to the user's settings no longer appear in
    // `claude mcp list`.
    { kind: 'exclusive', source: 'managed-mcp', pointer: ['mcpServers'], ignoresUserConnectors: true },
    // An allow list counts as a lock only when users cannot extend it.
    { kind: 'allowlist', source: 'managed-settings', pointer: ['allowedMcpServers'],
      requires: [{ source: 'managed-settings', pointer: ['allowManagedMcpServersOnly'], equals: true }],
      unmet: 'cannot tell',
      unmetDetail: 'the IT allow list for connectors may be extended in the user\'s own settings' },
  ],

  abilities: {
    terminal: {
      checks: [
        { source: 'managed-settings', pointer: ['permissions', 'deny'], includesAny: ['Bash', 'Bash(*)'], means: 'forbidden' },
        { source: 'user-settings', pointer: ['permissions', 'deny'], includesAny: ['Bash', 'Bash(*)'], means: 'forbidden' },
      ],
      default: 'allowed',
      notes: [
        { source: 'managed-settings', pointer: ['sandbox', 'enabled'], equals: true, note: 'commands run in a sandbox set by IT' },
        { source: 'user-settings', pointer: ['sandbox', 'enabled'], equals: true, note: 'commands run in a sandbox' },
      ],
    },
    files: {
      checks: [
        { source: 'managed-settings', pointer: ['permissions', 'deny'], includesAll: ['Read', 'Edit'], means: 'forbidden' },
        { source: 'user-settings', pointer: ['permissions', 'deny'], includesAll: ['Read', 'Edit'], means: 'forbidden' },
      ],
      default: 'allowed',
    },
    browser: { checks: [], default: 'cannot tell', unknownDetail: 'only through connectors or browser extensions' },
    screen: { checks: [], default: 'cannot tell', unknownDetail: 'only through connectors or extensions' },
  },

  accountConnectors: {
    closedWhen: [{ source: 'managed-settings', pointer: ['disableClaudeAiConnectors'], equals: true }],
  },
};
