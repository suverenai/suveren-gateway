#!/usr/bin/env node
/**
 * Post-install banner.
 *
 * Fires after `npm install -g @suveren/gateway`. Tells the
 * user how to start the gateway and where to point their browser, so
 * they don't have to dig through the README to find ports.
 *
 * Skipped silently in non-global installs and in non-TTY contexts (CI,
 * logged setup scripts) so we never spam unattended output.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Skip non-global installs (the binary won't be on PATH there anyway).
if (process.env.npm_config_global !== 'true') process.exit(0);
// Skip CI / logged contexts.
if (!process.stdout.isTTY) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version ?? '?';

// Detect whether a gateway is already running (left over from a
// previous version). If so, the user has just upgraded the binary on
// disk but the running process still executes the OLD code — they
// need `suveren-gateway restart` to pick up this version.
const DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const PID_FILE = join(DATA_DIR, 'gateway.pid');
function isRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // probe — throws if dead
    return true;
  } catch {
    return false;
  }
}
const upgradeInPlace = isRunning();

// Box-drawing banner. Width 60 chars inside the borders.
const W = 60;
const center = (s) => {
  const pad = Math.max(0, W - s.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
};
const left = (s) => s + ' '.repeat(Math.max(0, W - s.length));
const blank = ' '.repeat(W);

const lines = [
  '',
  '  ╭' + '─'.repeat(W) + '╮',
  '  │' + center(`Installed @suveren/gateway v${version}`) + '│',
  '  │' + blank + '│',
];

if (upgradeInPlace) {
  // Most important guidance — surface it first and unmissably.
  lines.push('  │' + left('   ⚠  A gateway is already running an older version.') + '│');
  lines.push('  │' + left('       Restart it now to pick up this update:') + '│');
  lines.push('  │' + left('         $ suveren-gateway restart') + '│');
  lines.push('  │' + blank + '│');
  lines.push('  │' + left('   Already in a browser tab? Reload after restart.') + '│');
} else {
  lines.push('  │' + left('   Start the gateway in this terminal:') + '│');
  lines.push('  │' + left('     $ suveren-gateway start') + '│');
  lines.push('  │' + blank + '│');
  lines.push('  │' + left('   Or run it in the background:') + '│');
  lines.push('  │' + left('     $ suveren-gateway start --detach') + '│');
  lines.push('  │' + blank + '│');
  lines.push('  │' + left('   Then open the UI:') + '│');
  lines.push('  │' + left('     → http://localhost:3400') + '│');
}

lines.push('  │' + blank + '│');
lines.push('  │' + left('   Other commands:  suveren-gateway help') + '│');
lines.push('  ╰' + '─'.repeat(W) + '╯');
lines.push('');
console.log(lines.join('\n'));
