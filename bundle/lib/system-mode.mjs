/**
 * S1: how the CLI behaves when the gateway runs under its own account.
 *
 * When the LaunchDaemon and its root-owned settings file exist, the gateway's
 * data folder, config, log and process belong to another account. The person's
 * CLI cannot, and must not pretend to, read or stop them. It becomes a thin
 * client: `status` asks /health, `config get port|mcp-port|data-dir` reads the
 * root-owned settings file, and everything that would touch the gateway's files
 * or process says plainly that it needs an administrator, with the command.
 *
 * Pure functions plus one existence probe; nothing here changes the machine.
 */

import { existsSync } from 'node:fs';
import { DAEMON_LABEL, buildLayout } from './system-install-mac.mjs';

/** Where a protected install keeps its marker files. `prefix` is for tests only. */
export function systemMarkers(prefix = '') {
  const l = buildLayout({ version: '0', prefix });
  return { plist: l.daemonPlist, settings: l.settingsFile, logFile: l.logFile };
}

/** True when this Mac has a protected install (both marker files exist). */
export function detectSystemInstall({ prefix = '', exists = existsSync } = {}) {
  const m = systemMarkers(prefix);
  return exists(m.plist) && exists(m.settings);
}

const HELP_FLAGS = new Set(['help', '--help', '-h']);
const READABLE_CONFIG_KEYS = new Set(['port', 'mcp-port', 'data-dir']);

/**
 * `argv` is the command line after the script name. Returns null when the
 * command may run as the person's user, else `{ lines, code }` for a refusal.
 */
export function thinCliRefusal(argv, { prefix = '' } = {}) {
  const cmd = argv[0] ?? 'help';
  const m = systemMarkers(prefix);
  const adminOnly = (what, command) => ({
    code: 2,
    lines: [
      `${what} needs an administrator: the gateway runs under its own account on this Mac.`,
      ...(command ? ['', `  ${command}`] : []),
    ],
  });

  if (HELP_FLAGS.has(cmd) || cmd === 'status' || cmd === 'open' || cmd === 'verify-report') return null;
  if (['install', 'update', 'uninstall'].includes(cmd)) return null; // root checks itself

  switch (cmd) {
    case 'stop':
      return adminOnly('Stopping it', `sudo launchctl bootout system/${DAEMON_LABEL}`);
    case 'restart':
      return adminOnly('Restarting it', `sudo launchctl kickstart -k system/${DAEMON_LABEL}`);
    case 'start':
      return adminOnly('Starting a second gateway', null);
    case 'logs':
      return adminOnly('Reading its log', `sudo tail -n 100 ${m.logFile}`);
    case 'service':
      return adminOnly('Changing the login service', null);
    case 'simulation':
      return adminOnly('Changing simulation mode', null);
    case 'config': {
      const sub = argv[1];
      if (sub === 'help' || sub === '--help' || sub === '-h') return null;
      if (sub === 'get' && READABLE_CONFIG_KEYS.has(argv[2])) return null;
      if (sub === 'get') {
        return {
          code: 2,
          lines: [
            'This setting is kept by the gateway\'s own account and cannot be read from here.',
            'You can read: port, mcp-port, data-dir.',
          ],
        };
      }
      return adminOnly('Changing a setting', null);
    }
    default:
      return null; // unknown commands fall through to the normal "Unknown command" message
  }
}
