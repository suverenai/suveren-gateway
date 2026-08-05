/**
 * Autostart file contents.
 *
 * The macOS plist builder shipped with NO tests and pasted paths straight into
 * XML. A home directory containing `&` or `<` — both legal on macOS and Linux —
 * produced a malformed plist, and the install failed in a way that pointed at
 * launchctl rather than at us. Windows Task Scheduler XML has exactly the same
 * exposure, so the escaping is tested for both.
 *
 * These are pure string builders, so they can be tested directly. The
 * side-effecting install/uninstall paths still cannot be tested without
 * mutating the machine's real login items.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  buildLaunchAgentPlist,
  buildMacLauncher,
  buildSystemdUnit,
  buildWindowsTaskXml,
} from '../../../../bundle/lib/autostart-templates.mjs';

const NASTY = '/Users/a&b/<test>/"quoted"/O\'Brien';

describe('escapeXml', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes ampersands first, so escapes are not double-escaped', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary paths untouched', () => {
    expect(escapeXml('/Users/andreas/.suveren')).toBe('/Users/andreas/.suveren');
  });
});

describe('macOS LaunchAgent plist', () => {
  const plist = () => buildLaunchAgentPlist({
    launcherPath: '/Users/a/.suveren/Suveren',
    label: 'ai.suveren.gateway',
    logFile: '/Users/a/.suveren/gateway.log',
    dataDir: '/Users/a/.suveren',
  });

  it('starts at login and restarts on crash', () => {
    const p = plist();
    expect(p).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(p).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('carries NO secret — the gateway must boot locked', () => {
    const p = plist().toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'password', 'token', 'secret']) {
      expect(p).not.toContain(forbidden);
    }
  });

  it('omits the environment block entirely when no data dir is set', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: '/L', label: 'l', logFile: '/log', dataDir: '',
    });
    expect(p).not.toContain('EnvironmentVariables');
  });

  it('escapes hostile paths — the bug that shipped untested', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: NASTY, label: 'ai.suveren.gateway',
      logFile: NASTY, dataDir: NASTY,
    });
    // Raw `&` or `<` would make the plist unparseable and launchctl would
    // refuse it with an error that looks like our bug, not the path's.
    expect(p).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(p).toContain('&amp;');
    expect(p).toContain('&lt;test&gt;');
  });
});

describe('Linux systemd user unit', () => {
  const unit = (dataDir = '/home/a/.suveren') => buildSystemdUnit({
    nodePath: '/usr/bin/node',
    serverEntry: '/opt/suveren/server.js',
    logFile: '/home/a/.suveren/gateway.log',
    dataDir,
  });

  it('restarts on failure and starts with the user session', () => {
    const u = unit();
    expect(u).toContain('Restart=always');
    expect(u).toContain('WantedBy=default.target');
  });

  it('QUOTES the environment value — systemd splits unquoted values on spaces', () => {
    const u = buildSystemdUnit({
      nodePath: '/usr/bin/node', serverEntry: '/s', logFile: '/l',
      dataDir: '/home/a/My Data/.suveren',
    });
    expect(u).toContain('Environment="SUVEREN_DATA_DIR=/home/a/My Data/.suveren"');
  });

  it('omits the Environment line when no data dir is set', () => {
    expect(unit('')).not.toContain('Environment=');
  });

  it('carries no secret', () => {
    const u = unit().toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'password', 'token', 'secret']) {
      expect(u).not.toContain(forbidden);
    }
  });
});

describe('Windows Task Scheduler XML', () => {
  const task = () => buildWindowsTaskXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverEntry: 'C:\\Users\\a\\AppData\\suveren\\server.js',
    author: 'Suveren',
    dataDir: 'C:\\Users\\a\\.suveren',
    userId: 'LAPTOP-HP\\Hans-Peter',
  });

  it('is UTF-16 declared — schtasks /Create /XML rejects other encodings', () => {
    expect(task()).toContain('encoding="UTF-16"');
  });

  it('triggers at logon and restarts on failure', () => {
    const t = task();
    expect(t).toContain('<LogonTrigger>');
    expect(t).toContain('<RestartOnFailure>');
  });

  it('runs unprivileged in the user session — no admin, no stored password', () => {
    const t = task();
    expect(t).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(t).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  // The bug this suite missed: every assertion above passed while the task was
  // unregistrable. A LogonTrigger without a UserId means "at ANY user's logon",
  // which requires admin — schtasks answered "Zugriff verweigert" and autostart
  // was impossible for a standard user.
  it('names the user in BOTH the trigger and the principal — the admin trap', () => {
    const t = task();
    expect(t).toContain('<UserId>LAPTOP-HP\\Hans-Peter</UserId>');
    // Once in <LogonTrigger>, once in <Principal>. One alone is not enough:
    // the trigger decides whose logon fires it, the principal whose account
    // it runs as.
    expect(t.match(/<UserId>/g)).toHaveLength(2);
  });

  it('places UserId where the XSD requires it — schtasks rejects any other order', () => {
    const t = task();
    // Principal: UserId precedes LogonType.
    expect(t).toMatch(/<UserId>[^<]+<\/UserId>\s*<LogonType>/);
    // LogonTrigger: UserId follows Enabled.
    expect(t).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>/);
  });

  it('omits UserId rather than emitting an empty one when no user is known', () => {
    // An empty <UserId></UserId> is a malformed principal; leaving it out at
    // least keeps the old (admin-only) behaviour instead of failing to parse.
    const t = buildWindowsTaskXml({
      nodePath: 'C:\\node.exe', serverEntry: 'C:\\server.js',
      author: 'Suveren', dataDir: '', userId: '',
    });
    expect(t).not.toContain('<UserId>');
  });

  it('escapes a hostile user name', () => {
    const t = buildWindowsTaskXml({
      nodePath: 'C:\\node.exe', serverEntry: 'C:\\server.js',
      author: 'Suveren', dataDir: '', userId: 'DOM\\a&b',
    });
    expect(t).toContain('<UserId>DOM\\a&amp;b</UserId>');
    expect(t).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('never expires — the default 72h execution limit would kill the gateway', () => {
    expect(task()).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('is hidden, so no console window flashes at every login', () => {
    expect(task()).toContain('<Hidden>true</Hidden>');
  });

  it('quotes the script path so "Program Files" style paths survive', () => {
    expect(task()).toContain('<Arguments>&quot;C:\\Users\\a\\AppData\\suveren\\server.js&quot; --autostart</Arguments>');
  });

  it('passes --autostart, the only way Windows can mark a service start', () => {
    // Task Scheduler XML has no environment block, so the marker that tells
    // the gateway to announce being locked has to ride in the arguments.
    expect(task()).toContain('--autostart');
  });

  it('escapes hostile paths', () => {
    const t = buildWindowsTaskXml({
      nodePath: 'C:\\a&b\\node.exe', serverEntry: 'C:\\<x>\\server.js',
      author: 'Suveren', dataDir: 'C:\\a&b',
    });
    expect(t).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(t).toContain('C:\\a&amp;b\\node.exe');
  });

  it('carries no secret', () => {
    const t = task().toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'password', 'secret']) {
      expect(t).not.toContain(forbidden);
    }
  });
});

describe('PATH is carried into the unit — integrations depend on it', () => {
  // launchd hands a process /usr/bin:/bin:/usr/sbin:/sbin, and a systemd user
  // unit inherits nothing useful. The gateway still starts (its node path is
  // absolute) but cannot find npx or the integration bin shims, so every
  // integration fails to launch and the UI shows them all "Not running" —
  // silently, with no error anywhere.
  const REAL_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

  it('macOS plist includes PATH', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: '/L', label: 'l', logFile: '/log',
      dataDir: '/d', path: REAL_PATH,
    });
    expect(p).toContain('<key>PATH</key>');
    expect(p).toContain(`<string>${REAL_PATH}</string>`);
  });

  it('macOS plist still emits the env block when ONLY a path is given', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: '/L', label: 'l', logFile: '/log',
      dataDir: '', path: REAL_PATH,
    });
    expect(p).toContain('EnvironmentVariables');
    expect(p).toContain('<key>PATH</key>');
    expect(p).not.toContain('SUVEREN_DATA_DIR');
  });

  it('systemd unit includes a quoted PATH', () => {
    const u = buildSystemdUnit({
      nodePath: '/n', serverEntry: '/s', logFile: '/log',
      dataDir: '/d', path: REAL_PATH,
    });
    expect(u).toContain(`Environment="PATH=${REAL_PATH}"`);
  });

  it('omits PATH when none is supplied, rather than writing an empty one', () => {
    // An empty PATH would be WORSE than none: it overrides the default with
    // nothing at all.
    const p = buildLaunchAgentPlist({
      launcherPath: '/L', label: 'l', logFile: '/log', dataDir: '/d', path: '',
    });
    expect(p).not.toContain('<key>PATH</key>');
    const u = buildSystemdUnit({ nodePath: '/n', serverEntry: '/s', logFile: '/l', dataDir: '/d', path: '' });
    expect(u).not.toContain('PATH=');
  });

  it('escapes a hostile PATH', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: '/L', label: 'l', logFile: '/log',
      dataDir: '', path: '/a&b:/c<d>',
    });
    expect(p).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('macOS launcher — what Login Items actually displays', () => {
  // Pointing launchd at the node binary made System Settings show
  // "node — Item from unidentified developer": unidentifiable, and alarming.
  // The entry is the FILENAME of the program launchd runs, so it has to be a
  // file called Suveren.
  it('is a shell script that execs the gateway', () => {
    const l = buildMacLauncher({ nodePath: '/opt/homebrew/bin/node', serverEntry: '/x/server.js' });
    expect(l.startsWith('#!/bin/sh')).toBe(true);
    expect(l).toContain("exec '/opt/homebrew/bin/node' '/x/server.js'");
  });

  it('quotes paths, so spaces and apostrophes cannot break it', () => {
    const l = buildMacLauncher({
      nodePath: "/Users/O'Brien/My Tools/node",
      serverEntry: '/opt/My Server/server.js',
    });
    expect(l).toContain("'/opt/My Server/server.js'");
    expect(l).toContain("O'\\''Brien");
  });

  it('execs rather than spawning — launchd must signal the gateway directly', () => {
    // Without exec the launcher lingers as an extra process, and KeepAlive
    // plus signal delivery would apply to the wrapper, not the gateway.
    expect(buildMacLauncher({ nodePath: '/n', serverEntry: '/s' })).toContain('exec ');
  });

  it('the plist points at the launcher, not at node', () => {
    const p = buildLaunchAgentPlist({
      launcherPath: '/Users/a/.suveren/Suveren', label: 'l', logFile: '/log', dataDir: '', path: '',
    });
    expect(p).toContain('<string>/Users/a/.suveren/Suveren</string>');
    expect(p).not.toContain('node');
  });
});
