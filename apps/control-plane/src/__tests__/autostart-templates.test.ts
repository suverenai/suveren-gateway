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
    nodePath: '/usr/local/bin/node',
    serverEntry: '/opt/suveren/server.js',
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
      nodePath: '/n', serverEntry: '/s', label: 'l', logFile: '/log', dataDir: '',
    });
    expect(p).not.toContain('EnvironmentVariables');
  });

  it('escapes hostile paths — the bug that shipped untested', () => {
    const p = buildLaunchAgentPlist({
      nodePath: NASTY, serverEntry: NASTY, label: 'ai.suveren.gateway',
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

  it('never expires — the default 72h execution limit would kill the gateway', () => {
    expect(task()).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('is hidden, so no console window flashes at every login', () => {
    expect(task()).toContain('<Hidden>true</Hidden>');
  });

  it('quotes the script path so "Program Files" style paths survive', () => {
    expect(task()).toContain('<Arguments>&quot;C:\\Users\\a\\AppData\\suveren\\server.js&quot;</Arguments>');
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
