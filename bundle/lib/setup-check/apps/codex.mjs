/**
 * ChatGPT desktop app / Codex — described as data for the Setup check
 * engine. Every field is explained in the header of ../engine.mjs.
 *
 * ~/.codex/config.toml is shared by the Codex CLI and ChatGPT's local
 * sessions (see apps/ui/src/lib/mcp-connect-configs.ts). Locations and keys
 * come from the vendor's documentation and have not been tested on a real
 * install (`verified: false`) — except requirements.toml on Windows, tested
 * 2026-11-12 with codex-cli 0.167.2. The [features] keys and the macOS /
 * Linux paths are not tested.
 */
export default {
  id: 'codex',
  name: 'ChatGPT desktop app / Codex',
  account: 'ChatGPT account',

  detect: {
    paths: [
      { all: '{home}/.codex' },
      { darwin: '{root}/Applications/ChatGPT.app' },
      { darwin: '{root}/Applications/Codex.app' },
    ],
    pathBinaries: ['codex'],
  },

  sources: [
    { id: 'user-config', role: 'user', format: 'toml', verified: false, path: { all: '{home}/.codex/config.toml' } },
    { id: 'requirements', role: 'lock', format: 'toml', verified: false, path: {
      darwin: '{root}/etc/codex/requirements.toml',
      linux: '{root}/etc/codex/requirements.toml',
      win32: { path: '{programData}\\OpenAI\\Codex\\requirements.toml',
        verified: 'tested 2026-11-12 with codex-cli 0.167.2 on Windows 11' },
    } },
    // The macOS admin profile for this domain exists or not; how its keys
    // map to settings is not documented clearly enough to read it.
    { id: 'managed-profile', role: 'lock', verified: false, path: {
      darwin: { format: 'plist', path: '{root}/Library/Managed Preferences/com.openai.codex.plist' },
    } },
  ],

  connectors: [
    { source: 'user-config', pointer: ['mcp_servers'] },
  ],

  connectorLocks: [
    // Observed with codex-cli 0.167.2 on Windows 11 (2026-11-12): with this
    // file present, `codex mcp add` still succeeds, but every connector in
    // the user's config is listed as "disabled: requirements" unless the
    // file lists it with the same name AND the same address.
    { kind: 'allowlist', source: 'requirements', pointer: ['mcp_servers'], ignoresUserConnectors: true },
    { kind: 'opaque', source: 'managed-profile',
      detail: 'an IT profile for Codex exists; this check cannot read what it sets' },
  ],

  abilities: {
    terminal: {
      checks: [],
      default: 'allowed',
      notes: [
        { source: 'requirements', pointer: ['allowed_sandbox_modes'], present: true, note: 'IT limits its sandbox modes' },
        { source: 'requirements', pointer: ['allowed_approval_policies'], present: true, note: 'IT limits when it must ask first' },
      ],
    },
    files: { checks: [], default: 'allowed' },
    browser: {
      checks: [
        { source: 'requirements', pointer: ['features', 'browser_use'], equals: false, means: 'forbidden' },
        { source: 'requirements', pointer: ['features', 'browser_use'], equals: true, means: 'allowed' },
        { source: 'user-config', pointer: ['features', 'browser_use'], equals: false, means: 'forbidden' },
        { source: 'user-config', pointer: ['features', 'browser_use'], equals: true, means: 'allowed' },
      ],
      default: 'cannot tell',
    },
    screen: {
      checks: [
        { source: 'requirements', pointer: ['features', 'computer_use'], equals: false, means: 'forbidden' },
        { source: 'requirements', pointer: ['features', 'computer_use'], equals: true, means: 'allowed' },
        { source: 'user-config', pointer: ['features', 'computer_use'], equals: false, means: 'forbidden' },
        { source: 'user-config', pointer: ['features', 'computer_use'], equals: true, means: 'allowed' },
      ],
      default: 'cannot tell',
    },
  },

  accountConnectors: {
    closedWhen: [],
    notes: [{ source: 'requirements', pointer: ['features', 'apps'], equals: false, note: 'IT has switched off apps in Codex' }],
  },
};
