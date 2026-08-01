/**
 * Desktop notification — the only way to tell someone the gateway is locked
 * *before* they trip over it.
 *
 * Autostart made this necessary. Previously a gateway that was not running
 * produced an obvious connection error in the agent; now it starts by itself
 * after a reboot, binds its port and answers — while holding no authority at
 * all, because the vault is locked. Everything looks healthy. The failure got
 * quieter as the feature got better.
 *
 * The agent-facing notice covers the moment someone asks it to act. This
 * covers the hours before that.
 *
 * Only fires when the LOGIN SERVICE started the gateway. A manual foreground
 * start needs no notification — you are already looking at the terminal — and
 * firing on every one would be noise.
 */
import { spawn, spawnSync } from 'node:child_process';

export interface NotifyCommand {
  cmd: string;
  args: string[];
}

export interface NotifyOptions {
  /** Where the notification should take the user when clicked, if the platform can. */
  url?: string;
  /** Whether `terminal-notifier` is on PATH — the only macOS route to a clickable notification. */
  hasTerminalNotifier?: boolean;
}

/** AppleScript string literal: backslashes first, then quotes. */
function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** PowerShell single-quoted literal: double any embedded single quote. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the platform command. Pure, so the quoting can be tested without
 * putting a notification on anyone's screen.
 *
 * Returns null on platforms with no mechanism we can rely on, so the caller
 * stays silent rather than spawning something that fails noisily in a log.
 */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
  options: NotifyOptions = {},
): NotifyCommand | null {
  const { url, hasTerminalNotifier = false } = options;

  switch (platform) {
    case 'darwin':
      // AppleScript's `display notification` CANNOT carry a click action. macOS
      // therefore activates whatever it decides posted the notification, which
      // for a script spawned by a launch agent resolves to Finder — clicking
      // the "you must unlock me" notice opens a file browser, which is worse
      // than useless because it looks like the product did something.
      //
      // terminal-notifier can attach a URL, so use it when it happens to be
      // installed. It stays OPTIONAL: a notification that arrives is worth more
      // than a clickable one that requires everybody to install a dependency
      // before the gateway can warn them about anything.
      if (url && hasTerminalNotifier) {
        return {
          cmd: 'terminal-notifier',
          args: ['-title', title, '-message', message, '-open', url, '-group', 'ai.suveren.gateway'],
        };
      }
      return {
        cmd: 'osascript',
        args: ['-e', `display notification ${osaQuote(message)} with title ${osaQuote(title)}`],
      };

    case 'win32':
      // NotifyIcon rather than a modern toast: toasts need a registered AppUserModelID
      // (or the BurntToast module), neither of which we can assume. This works on a
      // stock install.
      return {
        cmd: 'powershell',
        args: [
          '-NoProfile', '-NonInteractive', '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; ` +
          `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
          `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
          `$n.BalloonTipTitle = ${psQuote(title)}; ` +
          `$n.BalloonTipText = ${psQuote(message)}; ` +
          `$n.Visible = $true; $n.ShowBalloonTip(15000); Start-Sleep -Seconds 16; $n.Dispose()`,
        ],
      };

    case 'linux':
      return { cmd: 'notify-send', args: ['--app-name=Suveren', title, message] };

    default:
      return null;
  }
}

/** The message itself — one place, so the agent notice and this one agree. */
export function lockedNotification(port: string | number): { title: string; message: string; url: string } {
  const url = `http://localhost:${port}`;
  return {
    title: 'Suveren is running but locked',
    message:
      `Your agent has no authority until you unlock it. ` +
      `Open ${url} and enter your API key.`,
    url,
  };
}

/**
 * Is `terminal-notifier` on PATH? Cached: the answer cannot change within a
 * process, and this runs on the startup path.
 *
 * `spawnSync` rather than `which` on a shell — no shell means no quoting
 * surface, and a missing binary is an exit code rather than a thrown error.
 */
let terminalNotifierCache: boolean | null = null;
export function hasTerminalNotifier(): boolean {
  if (terminalNotifierCache !== null) return terminalNotifierCache;
  try {
    const probe = spawnSync('terminal-notifier', ['-help'], { stdio: 'ignore' });
    terminalNotifierCache = probe.error === undefined;
  } catch {
    terminalNotifierCache = false;
  }
  return terminalNotifierCache;
}

/**
 * Fire and forget. Never throws and never blocks startup: a missing
 * notify-send, a locked-down PowerShell policy or a denied permission must not
 * stop the gateway from serving.
 */
export function notify(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
  url?: string,
): void {
  const command = buildNotifyCommand(platform, title, message, {
    url,
    // Only probe when a URL could actually be attached.
    hasTerminalNotifier: url !== undefined && platform === 'darwin' ? hasTerminalNotifier() : false,
  });
  if (!command) return;
  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no mechanism available — stay quiet */ });
    child.unref();
  } catch {
    /* never let a notification break startup */
  }
}
