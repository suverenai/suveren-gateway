/**
 * Desktop notification for a locked gateway.
 *
 * Autostart made a locked gateway invisible: it starts by itself, binds its
 * port and answers, while holding no authority. Everything looks healthy and
 * nothing says otherwise until someone asks an agent to act — possibly hours
 * later.
 *
 * Command construction is tested rather than the spawn, so the quoting can be
 * checked without putting a notification on anyone's screen.
 */
import { describe, it, expect } from 'vitest';
import { buildNotifyCommand, lockedNotification } from '../lib/desktop-notify';

describe('buildNotifyCommand', () => {
  it('macOS uses osascript with both strings quoted', () => {
    const c = buildNotifyCommand('darwin', 'Title', 'Body')!;
    expect(c.cmd).toBe('osascript');
    expect(c.args[1]).toBe('display notification "Body" with title "Title"');
  });

  it('macOS escapes quotes and backslashes — AppleScript would otherwise break', () => {
    const c = buildNotifyCommand('darwin', 'A "quoted" title', 'back\\slash')!;
    // Unescaped, the quote ends the literal and osascript fails with a syntax
    // error nobody would connect to a notification.
    expect(c.args[1]).toContain('\\"quoted\\"');
    expect(c.args[1]).toContain('back\\\\slash');
  });

  it('Linux uses notify-send and identifies the app', () => {
    const c = buildNotifyCommand('linux', 'Title', 'Body')!;
    expect(c.cmd).toBe('notify-send');
    expect(c.args).toContain('--app-name=Suveren');
    expect(c.args.slice(-2)).toEqual(['Title', 'Body']);
  });

  it('Windows uses PowerShell without requiring an extra module', () => {
    const c = buildNotifyCommand('win32', 'Title', 'Body')!;
    expect(c.cmd).toBe('powershell');
    // A modern toast needs a registered AppUserModelID or BurntToast; neither
    // can be assumed on a stock machine.
    expect(c.args.join(' ')).toContain('NotifyIcon');
    expect(c.args).toContain('-NoProfile');
  });

  it("Windows doubles single quotes — PowerShell's literal escape", () => {
    const c = buildNotifyCommand('win32', "O'Brien", "it's locked")!;
    const joined = c.args.join(' ');
    expect(joined).toContain("'O''Brien'");
    expect(joined).toContain("'it''s locked'");
  });

  it('returns null on platforms with no mechanism, so the caller stays silent', () => {
    // Spawning something that does not exist would put a confusing failure in
    // the log for no benefit.
    expect(buildNotifyCommand('freebsd' as NodeJS.Platform, 'T', 'B')).toBeNull();
  });
});

describe('lockedNotification', () => {
  it('says what is wrong AND what to do about it', () => {
    const { title, message } = lockedNotification(3400);
    expect(title).toContain('locked');
    expect(message).toContain('http://localhost:3400');
    expect(message).toMatch(/API key/i);
  });

  it('makes the consequence explicit — running is not the same as working', () => {
    expect(lockedNotification(3400).message).toContain('no authority');
  });

  it('honours a non-default port, so the link is not a dead end', () => {
    expect(lockedNotification(7400).message).toContain('http://localhost:7400');
  });
});

describe('buildNotifyCommand — clickable notification (macOS)', () => {
  // Why this exists: AppleScript's `display notification` cannot carry a click
  // action, so macOS activates whatever it thinks posted it. From a launch
  // agent that resolves to Finder — clicking "Suveren is locked" opened a file
  // browser. terminal-notifier is the only route to attaching the URL.

  it('uses terminal-notifier with -open when a URL is given and the binary exists', () => {
    const c = buildNotifyCommand('darwin', 'Title', 'Body', {
      url: 'http://localhost:3400',
      hasTerminalNotifier: true,
    })!;
    expect(c.cmd).toBe('terminal-notifier');
    expect(c.args).toContain('-open');
    expect(c.args[c.args.indexOf('-open') + 1]).toBe('http://localhost:3400');
  });

  it('passes title and message as ARGUMENTS, not interpolated script', () => {
    // terminal-notifier takes argv directly, so hostile text cannot escape into
    // a shell or a script the way it could with osascript.
    const c = buildNotifyCommand('darwin', 'A "quoted" title', 'back\\slash', {
      url: 'http://localhost:3400',
      hasTerminalNotifier: true,
    })!;
    expect(c.args).toContain('A "quoted" title');
    expect(c.args).toContain('back\\slash');
  });

  it('falls back to osascript when terminal-notifier is absent', () => {
    // A notification that arrives beats a clickable one that requires everyone
    // to install a dependency first.
    const c = buildNotifyCommand('darwin', 'Title', 'Body', {
      url: 'http://localhost:3400',
      hasTerminalNotifier: false,
    })!;
    expect(c.cmd).toBe('osascript');
  });

  it('falls back to osascript when no URL is supplied', () => {
    const c = buildNotifyCommand('darwin', 'Title', 'Body', { hasTerminalNotifier: true })!;
    expect(c.cmd).toBe('osascript');
  });

  it('leaves the other platforms unchanged', () => {
    const opts = { url: 'http://localhost:3400', hasTerminalNotifier: true };
    expect(buildNotifyCommand('win32', 'T', 'B', opts)!.cmd).toBe('powershell');
    expect(buildNotifyCommand('linux', 'T', 'B', opts)!.cmd).toBe('notify-send');
    expect(buildNotifyCommand('freebsd' as NodeJS.Platform, 'T', 'B', opts)).toBeNull();
  });
});

describe('lockedNotification', () => {
  it('exposes the URL it tells the user to open, so both can never disagree', () => {
    const n = lockedNotification(3400);
    expect(n.url).toBe('http://localhost:3400');
    expect(n.message).toContain(n.url);
  });
});
