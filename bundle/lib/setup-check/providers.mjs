/**
 * The Setup check's only contact with the computer: reading files, and
 * running four read-only system tools (`ps`, `id` / `whoami`, `plutil`,
 * `reg query`) — the same child_process pattern as ../policy.mjs, no native
 * modules. Nothing here writes, starts a service, or opens a network
 * connection.
 *
 * The engine receives these as injectable functions so the tests can run
 * against fixture folders and never read the real home folder.
 */

import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix as posixPath, win32 as winPath } from 'node:path';
import { evaluateWrite, hasOwnerRightsEntry, isOwnedBy, parseIcacls, parseWhoami } from './win-acl.mjs';

/** `{ ok: true, text }` | `{ missing: true }` | `{ error: 'unreadable' }`. */
export function readText(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { missing: true };
    // Never pass err.message on: it is not needed, and stays out of output.
    return { error: 'unreadable' };
  }
}

export function exists(path) {
  try { statSync(path); return true; } catch { return false; }
}

export function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function list(dir) {
  try { return readdirSync(dir); } catch { return null; }
}

/** The file's owner uid, or null (Windows reports 0 for everything). */
export function ownerUid(path) {
  try { return statSync(path).uid; } catch { return null; }
}

/**
 * Can the current user change this file or folder? true | false | null
 * (cannot tell).
 *
 * The owner of a file can always give themselves write access again (POSIX:
 * `chmod`; Windows: the owner may always change the access list). So a file
 * or folder this user owns counts as changeable, whatever its current
 * permissions say.
 *
 * macOS / Linux: `access(2)` with W_OK asks the OS without opening anything
 * for writing. True when the path is writable or owned by this user, or
 * when its folder is (then it can be replaced) — except in a folder with the
 * sticky bit (like /tmp), where only the owner may replace it.
 *
 * Windows: access(W_OK) only looks at the read-only attribute, so the answer
 * comes from the access list instead (win-acl.mjs), and — only when that
 * says "cannot write" — from the owner. Only the object's own list is
 * evaluated: replacing a file through its folder needs rights on both that
 * this check does not combine.
 */
export function writable(path, platform = process.platform, runner = run) {
  if (platform === 'win32') return windowsWritable(path, runner);
  if (posixChangeable(path)) return true;
  const dir = dirname(path);
  if (!posixChangeable(dir)) return false;
  // Sticky folder: only the owner of the entry (or of the folder) may replace it.
  try {
    const d = statSync(dir);
    if (d.mode & 0o1000) {
      const uid = currentUid();
      return uid !== null && (ownerUid(path) === uid || d.uid === uid);
    }
  } catch {
    return null;
  }
  return true;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** POSIX: writable now, or owned by this user (who may chmod it). */
function posixChangeable(path) {
  try { accessSync(path, constants.W_OK); return true; } catch { /* next */ }
  const uid = currentUid();
  return uid !== null && exists(path) && ownerUid(path) === uid;
}

/**
 * For a file that does not exist: the nearest folder above it that does,
 * and whether this user could create the file there (by creating the
 * missing folders). `{ ancestor, writable: true|false|null }`.
 */
export function nearestCreatable(path, platform = process.platform, runner = run) {
  const p = platform === 'win32' ? winPath : posixPath;
  let dir = p.dirname(path);
  while (!exists(dir)) {
    const up = p.dirname(dir);
    if (up === dir) return { ancestor: null, writable: null };
    dir = up;
  }
  if (platform === 'win32') return { ancestor: dir, writable: windowsWritable(dir, runner) };
  return { ancestor: dir, writable: posixChangeable(dir) };
}

/**
 * Windows: the owner SID of a file or folder, read with .NET from a
 * PowerShell that loads no module (so no command lookup and no module
 * cache): GetAccessControl with only the Owner section, read-only. The path
 * goes in through an environment variable, never into the script text.
 */
/**
 * Time limit for a PowerShell call. Its first start can be slow: a GitHub
 * Windows runner needed 50 s for the process list (2026-11-12). When the
 * limit is passed, spawnSync stops PowerShell and the line reads "could not
 * be read (PowerShell did not finish within 120 s)" — the check never hangs.
 */
export const WINDOWS_POWERSHELL_TIMEOUT_MS = 120_000;

export const WINDOWS_OWNER_SCRIPT =
  '$p = $env:SUVEREN_CHECK_PATH; ' +
  '$s = [System.Security.AccessControl.AccessControlSections]::Owner; ' +
  'if ([System.IO.Directory]::Exists($p)) { $a = [System.IO.Directory]::GetAccessControl($p, $s) } ' +
  'else { $a = [System.IO.File]::GetAccessControl($p, $s) }; ' +
  '[Console]::Out.Write($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)';

export function windowsOwnerSid(path, runner = run) {
  const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_OWNER_SCRIPT], WINDOWS_POWERSHELL_TIMEOUT_MS, { SUVEREN_CHECK_PATH: path });
  if (!r.ok) return null;
  const sid = String(r.stdout).trim();
  return /^S-1-\d+(-\d+)+$/.test(sid) ? sid : null;
}

let windowsIdentity;
/** Who this user is, from `whoami` (cached for the run). */
export function windowsIdentityOf(runner = run) {
  if (runner === run && windowsIdentity !== undefined) return windowsIdentity;
  const u = runner('whoami', ['/user', '/fo', 'csv', '/nh']);
  const g = runner('whoami', ['/groups', '/fo', 'csv', '/nh']);
  const id = u.ok && g.ok ? parseWhoami(u.stdout, g.stdout) : { ok: false };
  const result = id.ok ? id : null;
  if (runner === run) windowsIdentity = result;
  return result;
}

function windowsWritable(path, runner) {
  const identity = windowsIdentityOf(runner);
  if (!identity) return null;
  const r = runner('icacls', [path]);
  if (!r.ok) return null;
  const parsed = parseIcacls(r.stdout, path);
  if (!parsed.ok) return null;
  const answer = evaluateWrite(parsed.entries, identity);
  if (answer !== false) return answer;
  // "Cannot write" holds only if this user is not the owner: an owner may
  // always change the access list — unless an OWNER RIGHTS entry replaces
  // those implicit rights (then the list above already decided).
  if (hasOwnerRightsEntry(parsed.entries)) return false;
  const owner = windowsOwnerSid(path, runner);
  if (!owner) return null;
  return isOwnedBy(owner, identity) ? true : false;
}

/**
 * Run a read-only system tool. On failure, `reason` says why in plain words
 * (not found / timed out / ended with status N) — never the tool's output,
 * which may hold command lines with secrets.
 */
export function run(bin, args, timeoutMs = 10_000, extraEnv = null) {
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    if (r.error) {
      const code = r.error.code;
      const reason = code === 'ENOENT' ? 'was not found' : code === 'ETIMEDOUT' ? `did not finish within ${Math.round(timeoutMs / 1000)} s` : 'could not be started';
      return { error: 'failed', reason, status: null };
    }
    if (r.status !== 0) return { error: 'failed', reason: r.status === null ? 'was stopped' : `ended with status ${r.status}`, status: r.status };
    if (typeof r.stdout !== 'string') return { error: 'failed', reason: 'gave no output', status: r.status };
    return { ok: true, stdout: r.stdout };
  } catch {
    return { error: 'failed', reason: 'could not be started' };
  }
}

/**
 * Windows: process names and command lines as JSON, from PowerShell's
 * Get-CimInstance (wmic is gone from current Windows 11). No profile, no
 * prompt, hidden window, time limit (in run()). Output is UTF-8 where a
 * console allows it. PowerShell itself may keep a small cache in the user's
 * local app data folder (see docs/setup-check.md).
 */
export const WINDOWS_PROCESS_COMMAND = [
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    // Without a console (e.g. started by a deployment tool) setting the
    // output encoding can throw; then the default encoding is used.
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; ' +
    'Get-CimInstance -ClassName Win32_Process | Select-Object Name, CommandLine | ConvertTo-Json -Compress'],
];

/**
 * Linux fallback when `ps` is missing (minimal images): read
 * `<procDir>/<pid>/cmdline` directly. Arguments there are separated by NUL
 * bytes; they are joined with spaces so the same patterns apply. A process
 * that ends or cannot be read meanwhile is skipped. Read-only; the text is
 * only handed to the engine, never printed.
 */
export function procCommands(procDir) {
  const pids = list(procDir);
  if (!pids) return { error: 'unreadable' };
  const commands = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let raw;
    try { raw = readFileSync(join(procDir, pid, 'cmdline'), 'utf8'); } catch { continue; }
    const args = raw.split('\0').filter((a) => a !== '');
    if (args.length) commands.push(args.join(' '));
  }
  return { ok: true, commands, source: `process list (${procDir})` };
}

/** Raw process-list output: `ps` text (macOS/Linux) or JSON (Windows). */
export function psList(platform) {
  // PowerShell's first start can be slow — see WINDOWS_POWERSHELL_TIMEOUT_MS.
  if (platform === 'win32') return run(WINDOWS_PROCESS_COMMAND[0], WINDOWS_PROCESS_COMMAND[1], WINDOWS_POWERSHELL_TIMEOUT_MS);
  return run('ps', ['axww', '-o', 'user=,command=']);
}

/**
 * Raw output → `{ ok: true, commands: string[] }` or `{ error }`. Never
 * throws and never passes the raw text on in an error.
 *   macOS/Linux: one process per line, first column the user (dropped).
 *   Windows: ConvertTo-Json output — an array, or a single object when
 *   there is one process. A process whose command line this user may not
 *   read has CommandLine null and is skipped.
 */
export function parseProcessList(platform, stdout) {
  if (platform === 'win32') {
    const text = String(stdout).replace(/^\uFEFF/, '').trim();
    // A real process list is never empty (PowerShell itself is in it): no
    // output means the call failed, not "no programs" — never a "closed".
    if (!text) return { error: 'unreadable', reason: 'gave no output' };
    let data;
    try { data = JSON.parse(text); } catch { return { error: 'unreadable', reason: 'gave output that could not be read' }; }
    const list = Array.isArray(data) ? data : [data];
    const commands = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') return { error: 'unreadable' };
      if (typeof p.CommandLine === 'string' && p.CommandLine.trim()) commands.push(p.CommandLine.trim());
    }
    return { ok: true, commands };
  }
  const commands = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (t) commands.push(t.replace(/^\S+\s+/, ''));
  }
  return { ok: true, commands };
}

/** Group memberships of the current user, as the OS prints them. */
export function groups(platform) {
  if (platform === 'win32') return run('whoami', ['/groups']);
  return run('id', ['-Gn']);
}

/** A macOS property list read as JSON via `plutil` (read-only: `-o -`). */
export function readPlist(path) {
  if (!exists(path)) return { missing: true };
  const r = run('plutil', ['-convert', 'json', '-o', '-', path]);
  if (!r.ok) return { error: 'unreadable' };
  try { return { ok: true, data: JSON.parse(r.stdout) }; } catch { return { error: 'unreadable' }; }
}

/**
 * Parse `reg query <key>` output into `{ name: value }`. REG_DWORD/REG_QWORD
 * become numbers; everything else stays a string.
 */
export function parseRegValues(stdout) {
  const out = {};
  const lineRe = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/;
  const emptyRe = /^ {4}(.+?) {4}(REG_[A-Z_]+)\s*$/;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const m = lineRe.exec(raw) ?? emptyRe.exec(raw);
    if (!m) continue;
    const [, name, type, value = ''] = m;
    out[name] = type === 'REG_DWORD' || type === 'REG_QWORD' ? parseInt(value, 16) : value;
  }
  return out;
}

/** A Windows registry key's values; `missing` when the key is absent. */
export function readRegistry(key, platform) {
  if (platform !== 'win32') return { missing: true };
  const r = run('reg', ['query', key]);
  if (!r.ok) return r.status === 1 ? { missing: true } : { error: 'unreadable' };
  return { ok: true, data: parseRegValues(r.stdout) };
}
