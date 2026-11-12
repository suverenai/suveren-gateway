/**
 * Claude desktop app — described as data for the Setup check engine. Every
 * field is explained in the header of ../engine.mjs.
 *
 * The config file location is common knowledge but NOT confirmed by the
 * vendor's documentation; the admin-lock locations and keys come from the
 * vendor's documentation. None of it has been tested on a real install:
 * `verified: false`.
 */
export default {
  id: 'claude-desktop',
  name: 'Claude desktop app',
  account: 'Claude account',

  detect: {
    paths: [
      { darwin: '{root}/Applications/Claude.app' },
      { darwin: '{home}/Applications/Claude.app' },
      { darwin: '{home}/Library/Application Support/Claude', win32: '{appData}\\Claude' },
    ],
  },

  sources: [
    { id: 'user-config', role: 'user', format: 'json', verified: false, path: {
      darwin: '{home}/Library/Application Support/Claude/claude_desktop_config.json',
      win32: '{appData}\\Claude\\claude_desktop_config.json',
    } },
    { id: 'policy', role: 'lock', verified: false, path: {
      darwin: { format: 'plist', path: '{root}/Library/Managed Preferences/com.anthropic.claudefordesktop.plist' },
      win32: { format: 'registry', key: 'HKLM\\SOFTWARE\\Policies\\Claude' },
    } },
  ],

  connectors: [
    { source: 'user-config', pointer: ['mcpServers'] },
  ],

  connectorLocks: [
    // IT's own list is the only one when local connectors and desktop
    // extensions are both switched off.
    { kind: 'exclusive', source: 'policy', pointer: ['managedMcpServers'],
      requires: [
        { source: 'policy', pointer: ['isLocalDevMcpEnabled'], equals: false },
        { source: 'policy', pointer: ['isDesktopExtensionEnabled'], equals: false },
      ],
      unmet: 'open',
      unmetDetail: 'IT has not switched off connectors added on this computer' },
  ],

  abilities: {
    terminal: {
      checks: [
        { source: 'policy', pointer: ['isClaudeCodeForDesktopEnabled'], equals: false, means: 'forbidden' },
        { source: 'policy', pointer: ['isClaudeCodeForDesktopEnabled'], equals: true, means: 'allowed' },
      ],
      default: 'cannot tell',
      unknownDetail: 'depends on whether Claude Code inside the app is switched on',
    },
    files: { checks: [], default: 'cannot tell' },
    browser: {
      checks: [
        { source: 'policy', pointer: ['builtinBrowserEnabled'], equals: false, means: 'forbidden' },
        { source: 'policy', pointer: ['builtinBrowserEnabled'], equals: true, means: 'allowed' },
      ],
      default: 'cannot tell',
    },
    screen: { checks: [], default: 'cannot tell' },
  },

  accountConnectors: { closedWhen: [] },
};
