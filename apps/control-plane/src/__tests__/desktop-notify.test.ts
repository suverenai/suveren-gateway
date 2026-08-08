/**
 * Command construction is tested rather than the spawn, so the quoting and the
 * toast payload can be checked without putting a notification on anyone's
 * screen. The Windows path in particular can ONLY be exercised this way on a
 * Mac dev machine — which is exactly how a wrong default survives, so the
 * assertions here are deliberately strict about the full command.
 */
import { describe, it, expect } from 'vitest';
import { buildNotifyCommand, lockedNotification, WINDOWS_AUMID, notifySpawnOptions } from '../lib/desktop-notify';

describe('buildNotifyCommand — macOS', () => {
  it('uses osascript with both strings quoted and an audible sound', () => {
    const c = buildNotifyCommand('darwin', 'Title', 'Body')!;
    expect(c.cmd).toBe('osascript');
    expect(c.args[1]).toBe('display notification "Body" with title "Title" sound name "Glass"');
  });

  it('escapes quotes and backslashes — AppleScript would otherwise break', () => {
    const c = buildNotifyCommand('darwin', 'A "quoted" title', 'back\\slash')!;
    expect(c.args[1]).toContain('\\"quoted\\"');
    expect(c.args[1]).toContain('back\\\\slash');
  });

  it('prefers terminal-notifier when present: clickable, icon, sound', () => {
    const c = buildNotifyCommand('darwin', 'T', 'B', {
      url: 'http://localhost:3400',
      hasTerminalNotifier: true,
      iconPath: '/data/notifier-icon.png',
    })!;
    expect(c.cmd).toBe('terminal-notifier');
    expect(c.args).toContain('-open');
    expect(c.args).toContain('http://localhost:3400');
    expect(c.args).toContain('-sound');
    expect(c.args).toContain('-appIcon');
    expect(c.args).toContain('/data/notifier-icon.png');
    // Group id makes repeats replace instead of stack.
    expect(c.args).toContain('ai.suveren.gateway');
  });
});

describe('buildNotifyCommand — Windows', () => {
  it('posts a WinRT toast under the Suveren AUMID, not a NotifyIcon balloon', () => {
    const c = buildNotifyCommand('win32', 'Title', 'Body')!;
    expect(c.cmd).toBe('powershell');
    expect(c.args).toContain('-NoProfile');
    const script = c.args.join(' ');
    expect(script).toContain('ToastNotificationManager');
    expect(script).toContain(`AppUserModelId`);
    expect(script).toContain(WINDOWS_AUMID);
    // The legacy balloon held a PowerShell process alive for 16s and showed a
    // generic info icon. Gone.
    expect(script).not.toContain('NotifyIcon');
    expect(script).not.toContain('Start-Sleep');
  });

  it('clicking the toast opens the gateway (protocol activation)', () => {
    const c = buildNotifyCommand('win32', 'T', 'B', { url: 'http://localhost:3400' })!;
    const script = c.args.join(' ');
    expect(script).toContain('activationType=&quot;protocol&quot;'.replace(/&quot;/g, '"'));
    expect(script).toContain('launch="http://localhost:3400"');
  });

  it('carries the Suveren icon and the default notification sound', () => {
    const c = buildNotifyCommand('win32', 'T', 'B', { iconPath: 'C:\\data\\icon.png' })!;
    const script = c.args.join(' ');
    expect(script).toContain('appLogoOverride');
    expect(script).toContain('C:\\data\\icon.png');
    expect(script).toContain('ms-winsoundevent:Notification.Default');
  });

  it('XML-escapes the strings inside the toast payload', () => {
    const c = buildNotifyCommand('win32', 'A <b> & "c"', "it's here")!;
    const script = c.args.join(' ');
    expect(script).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    // And PowerShell single quotes are doubled around the XML literal.
    expect(script).toContain('&apos;');
    expect(script).not.toContain('<b>');
  });

  it("doubles single quotes — PowerShell's literal escape", () => {
    const c = buildNotifyCommand('win32', "O'Brien", 'x')!;
    // The apostrophe is XML-escaped first, so no bare quote can terminate the
    // PowerShell literal.
    expect(c.args.join(' ')).not.toMatch(/[^']O'Brien/);
  });
});

describe('buildNotifyCommand — Linux', () => {
  it('uses notify-send, identifies the app, and shows the icon', () => {
    const c = buildNotifyCommand('linux', 'Title', 'Body', { iconPath: '/data/icon.png' })!;
    expect(c.cmd).toBe('notify-send');
    expect(c.args).toContain('--app-name=Suveren');
    expect(c.args).toContain('-i');
    expect(c.args).toContain('/data/icon.png');
    expect(c.args.slice(-2)).toEqual(['Title', 'Body']);
  });

  it('omits the icon flag when no icon could be written', () => {
    const c = buildNotifyCommand('linux', 'T', 'B', { iconPath: null })!;
    expect(c.args).not.toContain('-i');
  });
});

describe('buildNotifyCommand — elsewhere', () => {
  it('returns null so the caller stays silent', () => {
    expect(buildNotifyCommand('freebsd' as NodeJS.Platform, 'T', 'B')).toBeNull();
  });
});

describe('lockedNotification', () => {
  it('names the port it asks the person to open', () => {
    const n = lockedNotification(3400);
    expect(n.url).toBe('http://localhost:3400');
    expect(n.message).toContain('http://localhost:3400');
  });
});

describe('notifySpawnOptions', () => {
  it('does NOT detach on Windows', () => {
    // Verified on Windows 11: a toast posted from a DETACHED_PROCESS is
    // accepted (PowerShell exits 0, stderr empty) and never delivered. This
    // one flag silently swallowed every Windows notification the gateway sent.
    expect(notifySpawnOptions('win32').detached).toBe(false);
  });

  it('detaches elsewhere, so a notification outlives a gateway restart', () => {
    expect(notifySpawnOptions('darwin').detached).toBe(true);
    expect(notifySpawnOptions('linux').detached).toBe(true);
  });

  it('pipes stderr on every platform - discarding it is how the bug hid', () => {
    for (const p of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(notifySpawnOptions(p).stdio[2]).toBe('pipe');
    }
  });
});
