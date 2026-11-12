/**
 * GitHub Copilot in VS Code — described as data for the Setup check engine.
 * Every field is explained in the header of ../engine.mjs.
 *
 * The user mcp.json location is not confirmed by official documentation;
 * the rest comes from the vendors' documentation. None of it has been tested
 * on a real install: `verified: false`.
 */
export default {
  id: 'copilot-vscode',
  name: 'GitHub Copilot in VS Code',
  account: 'GitHub account',

  detect: {
    paths: [
      { darwin: '{home}/Library/Application Support/Code/User/mcp.json', win32: '{appData}\\Code\\User\\mcp.json', linux: '{xdgConfig}/Code/User/mcp.json' },
      { all: '{home}/.copilot/mcp-config.json' },
    ],
    dirPrefixes: [{ all: '{home}/.vscode/extensions', prefix: 'github.copilot' }],
  },

  sources: [
    { id: 'vscode-mcp', role: 'user', format: 'json', verified: false, path: {
      darwin: '{home}/Library/Application Support/Code/User/mcp.json',
      win32: '{appData}\\Code\\User\\mcp.json',
      linux: '{xdgConfig}/Code/User/mcp.json',
    } },
    { id: 'copilot-mcp', role: 'user', format: 'json', verified: false, path: { all: '{home}/.copilot/mcp-config.json' } },
    { id: 'managed-settings', role: 'lock', format: 'json', verified: false, path: {
      darwin: '{root}/Library/Application Support/GitHubCopilot/managed-settings.json',
      linux: '{root}/etc/github-copilot/managed-settings.json',
      win32: '{programFiles}\\GitHubCopilot\\managed-settings.json',
    } },
    { id: 'vscode-policy', role: 'lock', verified: false, path: {
      linux: { format: 'json', path: '{root}/etc/vscode/policy.json' },
      win32: { format: 'registry', key: 'HKLM\\Software\\Policies\\Microsoft\\VSCode' },
    } },
  ],

  connectors: [
    { source: 'vscode-mcp', pointer: ['servers'] },
    { source: 'copilot-mcp', pointer: ['mcpServers'] },
  ],

  connectorLocks: [
    { kind: 'allowlist', source: 'managed-settings', pointer: ['allowedMcpServers'] },
    { kind: 'opaque', source: 'vscode-policy', pointer: ['ChatAllowManagedMcpServersOnly'], equals: true,
      detail: 'IT allows only connectors it manages; the list is not stored on this computer' },
  ],

  abilities: {
    terminal: {
      // The terminal tool cannot be removed, only set to ask first.
      fixed: { result: 'allowed', detail: 'the terminal cannot be switched off, only set to ask first' },
      notes: [
        { source: 'vscode-policy', pointer: ['ChatToolsAutoApprove'], equals: false, note: 'IT requires it to ask first' },
        { source: 'vscode-policy', pointer: ['ChatAgentMode'], equals: false, note: 'IT has switched off agent mode' },
      ],
    },
    files: { checks: [], default: 'allowed' },
    browser: {
      checks: [
        { source: 'vscode-policy', pointer: ['BrowserChatTools'], equals: false, means: 'forbidden' },
        { source: 'vscode-policy', pointer: ['BrowserChatTools'], equals: true, means: 'allowed' },
      ],
      default: 'cannot tell',
    },
    screen: { checks: [], default: 'cannot tell' },
  },

  accountConnectors: { closedWhen: [] },
};
