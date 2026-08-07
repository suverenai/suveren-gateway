/**
 * Desktop notifications — the gateway telling a human something needs them.
 *
 * Two callers: the locked-vault notice at autostart, and the review doorbell
 * (notification-dispatcher). Both carry fixed literals; nothing agent-authored
 * ever reaches these strings, which is also why the quoting below is defense in
 * depth rather than the security boundary.
 *
 * Per-platform, deliberately not uniform — each OS gets its best native path:
 *
 * - **macOS** — `osascript` with a notification sound (`Glass`: audible,
 *   calm). AppleScript notifications cannot carry a click action or a custom
 *   icon; when `terminal-notifier` is installed we use it instead and gain
 *   both. The real end state is a signed helper app posting through
 *   UNUserNotificationCenter — tracked in doc/native-notifications-plan.md,
 *   blocked on an Apple Developer account.
 * - **Windows** — a real WinRT toast, not the legacy NotifyIcon balloon. First
 *   call registers an AppUserModelID for "Suveren" under HKCU (DisplayName +
 *   IconUri — the documented lightweight registration; no Start-Menu shortcut,
 *   no BurntToast). Toasts get the Suveren icon, the default notification
 *   sound, Action Center persistence, and protocol activation: clicking opens
 *   the gateway UI.
 * - **Linux** — `notify-send` with the icon. Sound and click actions are
 *   notification-daemon lottery; deferred with the Linux phase of the plan.
 *
 * Fire and forget everywhere: a missing binary, a denied permission or a
 * locked-down PowerShell must never affect the gateway.
 */
import { spawn, spawnSync } from 'node:child_process';
import { ensureNotifierIcon } from './notifier-icon';

export interface NotifyCommand {
  cmd: string;
  args: string[];
}

export interface NotifyOptions {
  /** Where the notification should take the user when clicked, if the platform can. */
  url?: string;
  /** Whether `terminal-notifier` is on PATH — the only macOS route to a clickable notification. */
  hasTerminalNotifier?: boolean;
  /** Absolute path to the Suveren notification icon, where the platform can show one. */
  iconPath?: string | null;
}

/** AppleScript string literal: backslashes first, then quotes. */
function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** PowerShell single-quoted literal: double any embedded single quote. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** XML text/attribute escape for the toast payload. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The toast is posted under this identity. Registered under HKCU on first use:
 * per-user, no admin rights, and what makes "Suveren" appear as its own app in
 * Windows notification settings instead of "Windows PowerShell".
 */
export const WINDOWS_AUMID = 'Suveren.Gateway';

/**
 * One PowerShell invocation: ensure the AUMID registration, build the toast
 * XML, show it. Windows PowerShell 5.1 (`powershell.exe`) is required for the
 * WinRT projection — which is exactly what we spawn; `pwsh` would not work.
 */
function windowsToastScript(title: string, message: string, url?: string, iconPath?: string | null): string {
  const toastXml =
    `<toast${url ? ` activationType="protocol" launch="${xmlEscape(url)}"` : ''}>` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text>` +
    `<text>${xmlEscape(message)}</text>` +
    (iconPath ? `<image placement="appLogoOverride" src="${xmlEscape(iconPath)}"/>` : '') +
    `</binding></visual>` +
    `<audio src="ms-winsoundevent:Notification.Default"/>` +
    `</toast>`;

  return (
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$aumid=${psQuote(WINDOWS_AUMID)}; ` +
    `$reg=\"HKCU:\\Software\\Classes\\AppUserModelId\\$aumid\"; ` +
    `if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }; ` +
    `New-ItemProperty -Path $reg -Name DisplayName -Value 'Suveren' -PropertyType String -Force | Out-Null; ` +
    (iconPath
      ? `New-ItemProperty -Path $reg -Name IconUri -Value ${psQuote(iconPath)} -PropertyType String -Force | Out-Null; `
      : '') +
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null; ` +
    `$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; ` +
    `$doc.LoadXml(${psQuote(toastXml)}); ` +
    `$toast = New-Object Windows.UI.Notifications.ToastNotification $doc; ` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)`
  );
}

/** Calm but audible; a fixed choice, not configurable, so it stays recognisable. */
const MAC_SOUND = 'Glass';

/**
 * Build the platform command. Pure, so the quoting and the toast XML can be
 * tested without putting a notification on anyone's screen.
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
  const { url, hasTerminalNotifier = false, iconPath } = options;

  switch (platform) {
    case 'darwin':
      // AppleScript's `display notification` CANNOT carry a click action or a
      // custom icon — macOS attributes it to whatever posted it. It CAN carry
      // a sound, which does more for prominence than any icon would.
      //
      // terminal-notifier can attach a URL and an icon, so use it when it
      // happens to be installed. It stays OPTIONAL: a notification that
      // arrives is worth more than a clickable one that requires everybody to
      // install a dependency first.
      if (url && hasTerminalNotifier) {
        return {
          cmd: 'terminal-notifier',
          args: [
            '-title', title,
            '-message', message,
            '-open', url,
            '-sound', MAC_SOUND,
            ...(iconPath ? ['-appIcon', iconPath] : []),
            '-group', 'ai.suveren.gateway',
          ],
        };
      }
      return {
        cmd: 'osascript',
        args: [
          '-e',
          `display notification ${osaQuote(message)} with title ${osaQuote(title)} sound name ${osaQuote(MAC_SOUND)}`,
        ],
      };

    case 'win32':
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', windowsToastScript(title, message, url, iconPath)],
      };

    case 'linux':
      return {
        cmd: 'notify-send',
        args: [
          '--app-name=Suveren',
          ...(iconPath ? ['-i', iconPath] : []),
          title,
          message,
        ],
      };

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
    hasTerminalNotifier: platform === 'darwin' ? hasTerminalNotifier() : false,
    // Windows and Linux show it on the toast itself; macOS only via
    // terminal-notifier. Failure to write it must never block the sound.
    iconPath: ensureNotifierIcon(),
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
