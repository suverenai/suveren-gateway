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
import { spawn } from 'node:child_process';

export interface NotifyCommand {
  cmd: string;
  args: string[];
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
): NotifyCommand | null {
  switch (platform) {
    case 'darwin':
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
export function lockedNotification(port: string | number): { title: string; message: string } {
  return {
    title: 'Suveren is running but locked',
    message:
      `Your agent has no authority until you unlock it. ` +
      `Open http://localhost:${port} and enter your API key.`,
  };
}

/**
 * Fire and forget. Never throws and never blocks startup: a missing
 * notify-send, a locked-down PowerShell policy or a denied permission must not
 * stop the gateway from serving.
 */
export function notify(title: string, message: string, platform: NodeJS.Platform = process.platform): void {
  const command = buildNotifyCommand(platform, title, message);
  if (!command) return;
  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no mechanism available — stay quiet */ });
    child.unref();
  } catch {
    /* never let a notification break startup */
  }
}
