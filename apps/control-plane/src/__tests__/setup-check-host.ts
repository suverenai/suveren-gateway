/**
 * Helpers for the Setup check tests that spawn the REAL CLI, so they isolate
 * it the same way on a macOS, Linux and Windows host (not a test file: no
 * `.test.` in the name).
 *
 * Host facts that leak into a spawned CLI and how they are pinned:
 *   - the home folder: os.homedir() follows HOME on macOS/Linux but
 *     USERPROFILE on Windows — both are set to the fixture home;
 *   - Windows locations the AI-app descriptions use (APPDATA, LOCALAPPDATA,
 *     ProgramFiles, ProgramData) — pointed into the fixture;
 *   - PATH: only system folders, so an AI app installed on the machine
 *     running the suite is not "found"; on Windows these still hold the
 *     read-only tools the check calls (whoami, icacls, PowerShell), with the
 *     variables those tools need to start.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_POWERSHELL_TIMEOUT_MS } from '../../../../bundle/lib/setup-check/providers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const IS_WINDOWS_HOST = process.platform === 'win32';

/**
 * Time limits for tests that run the REAL CLI or tools on the host, derived
 * from the check's own limit: one CLI run on a slow Windows host may start
 * PowerShell (process list, owner lookup) and wait up to its limit, plus
 * Node's own start and the other read-only tools.
 */
export const CLI_RUN_LIMIT_MS = WINDOWS_POWERSHELL_TIMEOUT_MS + 30_000;
/** A test doing `runs` CLI runs (or other real-tool spawns of that size). */
export function cliTestTimeout(runs: number): number {
  return runs * CLI_RUN_LIMIT_MS + 30_000;
}

/** Environment for a spawned CLI with `home` as its home folder and `base`
 *  as the fixture folder for system locations. */
export function hostIsolatedEnv(home: string, base: string): Record<string, string> {
  if (!IS_WINDOWS_HOST) {
    return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home };
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pass = (name: string) => (process.env[name] ? { [name]: process.env[name] as string } : {});
  return {
    PATH: [
      win32.join(systemRoot, 'System32'),
      systemRoot,
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';'),
    SystemRoot: systemRoot,
    ...pass('windir'),
    ...pass('SystemDrive'),
    ...pass('PATHEXT'),
    ...pass('ComSpec'),
    ...pass('TEMP'),
    ...pass('TMP'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    ProgramFiles: join(base, 'ProgramFiles'),
    ProgramData: join(base, 'ProgramData'),
  };
}

// ─── Windows tool output for fixtures ───────────────────────────────────

/** The real `icacls` capture from a Windows 11 VM (2026-11-12), with line
 *  endings normalised: git may check it out with CRLF on Windows. */
export const ICACLS_CAPTURE_LF = readFileSync(join(__dirname, 'fixtures', 'icacls-windows11-2026-11-12.txt'), 'utf8').replace(/\r\n/g, '\n');

/** The block `icacls <path>` printed for one captured path, as printed
 *  (LF line endings; see ICACLS_CAPTURE_LF). */
export function icaclsBlock(path: string): string {
  const blocks = ICACLS_CAPTURE_LF.split(/^Successfully processed.*$/m).map((b) => b.replace(/^\n/, ''));
  const block = blocks.find((b) => b.startsWith(`${path} `));
  if (!block) throw new Error(`no capture for ${path}`);
  return `${block}Successfully processed 1 files; Failed processing 0 files\n`;
}

/** A captured block, re-labelled as the output for another path (the same
 *  entries, as icacls prints them for any path). */
export function icaclsBlockFor(capturedPath: string, path: string): string {
  const block = icaclsBlock(capturedPath);
  const pad = ' '.repeat(path.length + 1);
  return block
    .split('\n')
    .map((line, i) => (i === 0 ? `${path} ${line.slice(capturedPath.length + 1)}` : line.replace(/^\s+(?=\S)/, pad)))
    .join('\n');
}

export const CAPTURED = {
  lockFile: 'C:\\Program Files\\ClaudeCode\\managed-mcp.json',
  lockDir: 'C:\\Program Files\\ClaudeCode',
  rootDir: 'C:\\suveren-check-test',
  rootFile: 'C:\\suveren-check-test\\bin\\suveren-gateway.js',
  userPrograms: 'C:\\Users\\Owner\\AppData\\Local\\Programs\\Suveren',
  programData: 'C:\\ProgramData',
};

const ENABLED = 'Mandatory group, Enabled by default, Enabled group';
export const csv = (...f: string[]) => f.map((x) => `"${x}"`).join(',');

/** `whoami /groups /fo csv /nh` of a standard user (reconstructed from the
 *  group names and SIDs reported from the VM), plus `extra` rows. */
export function standardGroupsCsv(extra: string[] = []): string {
  return [
    csv('Everyone', 'Well-known group', 'S-1-1-0', ENABLED),
    csv('NT AUTHORITY\\Local account and member of Administrators group', 'Well-known group', 'S-1-5-114', 'Group used for deny only'),
    ...extra,
    csv('BUILTIN\\Users', 'Alias', 'S-1-5-32-545', ENABLED),
    csv('NT AUTHORITY\\INTERACTIVE', 'Well-known group', 'S-1-5-4', ENABLED),
    csv('NT AUTHORITY\\Authenticated Users', 'Well-known group', 'S-1-5-11', ENABLED),
    csv('Mandatory Label\\Medium Mandatory Level', 'Label', 'S-1-16-8192', ''),
  ].join('\r\n');
}

export const STANDARD_USER_CSV = csv('testpc\\person', 'S-1-5-21-1-2-3-1002');
export { ENABLED };
