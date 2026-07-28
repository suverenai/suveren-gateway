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
