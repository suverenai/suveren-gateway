/**
 * Can the current Windows user write a file or folder? Read-only answer from
 * `icacls <path>` (prints the access list) and `whoami /user` / `whoami
 * /groups` (who this user is). Nothing is created, appended to or opened for
 * writing to find out.
 *
 * Why not fs.accessSync(path, W_OK): on Windows Node only looks at the
 * read-only attribute, not at the access list, so it says "writable" for
 * C:\Program Files\... where a standard user is refused (measured in a
 * Windows 11 VM, 2026-11-12).
 *
 * Answer: true (write access established), false (excluded), null (cannot
 * tell). Rules, applied to the entries that apply to the object itself:
 *   - Entries marked (IO) (inherit only) are skipped: they apply to children.
 *   - An entry applies to this user when its account name or SID is the user
 *     or one of the user's groups as `whoami` prints them (names compared
 *     case-insensitively; names are localised, so both tools must agree).
 *   - Write rights: F, M, W, WD, AD, GA, GW, and WDAC / WO (whoever may change
 *     the access list or the owner can give themselves write access).
 *   - A matching deny entry with F → false. A matching deny entry with any
 *     other write right → null (partial deny: not evaluated).
 *   - A matching allow entry with a write right → true, unless an entry is
 *     present that this module does not evaluate (CREATOR OWNER / OWNER
 *     RIGHTS / CREATOR GROUP applying to the object, a Mandatory Label, an
 *     account name with characters that may have been garbled) → null.
 *   - Only via a group whose state `whoami` printed in a form not understood
 *     (e.g. a non-English Windows) → null.
 *   - No allow entry grants write → false, unless such an unevaluated entry
 *     grants write → null.
 *   - Any line that does not parse, or icacls / whoami failing → null.
 */

const FLAG_TOKENS = new Set(['I', 'OI', 'CI', 'IO', 'NP', 'DENY']);
const RIGHT_TOKENS = new Set([
  'F', 'M', 'RX', 'R', 'W', 'D', 'N',
  'DE', 'RC', 'WDAC', 'WO', 'S', 'AS', 'MA', 'GR', 'GW', 'GE', 'GA',
  'RD', 'WD', 'AD', 'REA', 'WEA', 'X', 'DC', 'RA', 'WA',
  'NW', 'NR', 'NX', // integrity-label policies
]);
const WRITE_RIGHTS = new Set(['F', 'M', 'W', 'WD', 'AD', 'GA', 'GW', 'WDAC', 'WO']);
/** Principals whose meaning depends on who owns the object. */
const UNEVALUATED_PRINCIPALS = ['CREATOR OWNER', 'OWNER RIGHTS', 'CREATOR GROUP', 'S-1-3-0', 'S-1-3-4', 'S-1-3-1'];

/**
 * Parse `icacls <path>` stdout. Returns `{ ok: true, entries }` or
 * `{ ok: false }`. Each entry: { principal, flags: Set, rights: Set }.
 */
export function parseIcacls(stdout, path) {
  const lines = String(stdout).split(/\r?\n/);
  const entries = [];
  let first = true;
  for (const raw of lines) {
    if (first) {
      if (!raw.toLowerCase().startsWith(String(path).toLowerCase() + ' ')) return { ok: false };
      first = false;
      const e = parseEntry(raw.slice(path.length + 1));
      if (!e) return { ok: false };
      entries.push(e);
      continue;
    }
    if (raw.trim() === '') break; // blank line ends the list; the summary follows
    if (!/^\s/.test(raw)) return { ok: false };
    const e = parseEntry(raw);
    if (!e) return { ok: false };
    entries.push(e);
  }
  if (first || entries.length === 0) return { ok: false };
  return { ok: true, entries };
}

function parseEntry(text) {
  const m = /^\s*(.+):((?:\([^()]*\))+)\s*$/.exec(text);
  if (!m) return null;
  const principal = m[1].trim();
  const flags = new Set();
  const rights = new Set();
  for (const group of m[2].slice(1, -1).split(')(')) {
    const g = group.toUpperCase();
    if (FLAG_TOKENS.has(g)) { flags.add(g); continue; }
    for (const token of g.split(',')) {
      if (!RIGHT_TOKENS.has(token)) return null;
      rights.add(token);
    }
  }
  if (rights.size === 0) return null;
  return { principal, flags, rights };
}

/** One CSV line → fields (double-quoted, "" escapes). */
function csvFields(line) {
  const out = [];
  const re = /"((?:[^"]|"")*)"(?:,|$)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index !== consumed) return null;
    out.push(m[1].replace(/""/g, '"'));
    consumed = re.lastIndex;
    if (consumed >= line.length) break;
  }
  return consumed === line.length ? out : null;
}

/**
 * Parse `whoami /user /fo csv /nh` and `whoami /groups /fo csv /nh`.
 * Returns { ok: true, user: { name, sid }, groups: [{ name, sid, state }] }
 * with state 'enabled' | 'denyOnly' | 'unknown', or { ok: false }.
 */
export function parseWhoami(userCsv, groupsCsv) {
  const userLine = String(userCsv).split(/\r?\n/).find((l) => l.trim());
  const u = userLine ? csvFields(userLine.trim()) : null;
  if (!u || u.length !== 2 || !/^S-1-/.test(u[1])) return { ok: false };
  const groups = [];
  for (const line of String(groupsCsv).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = csvFields(line.trim());
    if (!f || f.length !== 4) return { ok: false };
    const [name, , sid, attrs] = f;
    if (/^S-1-16-/.test(sid)) continue; // Mandatory Label rows: integrity level, not a group
    const a = attrs.toLowerCase();
    const state = a.includes('deny only') ? 'denyOnly' : a.includes('enabled group') ? 'enabled' : 'unknown';
    groups.push({ name, sid, state });
  }
  return { ok: true, user: { name: u[0], sid: u[1] }, groups };
}

const norm = (s) => s.replace(/^\*/, '').trim().toUpperCase();

/** 'user' | 'enabled' | 'denyOnly' | 'unknown' | null (not this user). */
function membership(principal, identity) {
  const p = norm(principal);
  if (p === norm(identity.user.name) || p === norm(identity.user.sid)) return 'user';
  let found = null;
  for (const g of identity.groups) {
    if (p === norm(g.name) || p === norm(g.sid)) {
      if (g.state === 'enabled') return 'enabled';
      found = g.state;
    }
  }
  return found;
}

const grantsWrite = (rights) => [...rights].some((r) => WRITE_RIGHTS.has(r));

/** true | false | null — see the header. */
export function evaluateWrite(entries, identity) {
  let allowWrite = false;
  let allowViaUnknownGroup = false;
  let unevaluatedWrite = false;
  let unevaluatedPresent = false;
  let denyFull = false;
  let denyPartial = false;
  for (const e of entries) {
    if (e.flags.has('IO')) continue;
    const isDeny = e.flags.has('DENY');
    const writes = grantsWrite(e.rights);
    const upper = e.principal.toUpperCase();
    if (upper.startsWith('MANDATORY LABEL\\')) { unevaluatedPresent = true; continue; }
    if (UNEVALUATED_PRINCIPALS.includes(norm(e.principal))) {
      unevaluatedPresent = true;
      if (writes) unevaluatedWrite = true;
      continue;
    }
    // A name that may have been garbled by a code page cannot be matched.
    if (/[^\x20-\x7E]/.test(e.principal)) {
      unevaluatedPresent = true;
      if (writes) unevaluatedWrite = true;
      continue;
    }
    if (!writes) continue;
    const m = membership(e.principal, identity);
    if (!m) continue;
    if (isDeny) {
      // Deny entries apply to deny-only groups too.
      if (e.rights.has('F')) denyFull = true; else denyPartial = true;
      continue;
    }
    if (m === 'user' || m === 'enabled') allowWrite = true;
    else if (m === 'unknown') allowViaUnknownGroup = true;
    // denyOnly: an allow entry for that group does not apply.
  }
  if (denyFull) return false;
  if (denyPartial) return null;
  if (allowWrite) return unevaluatedPresent ? null : true;
  if (allowViaUnknownGroup || unevaluatedWrite) return null;
  return false;
}
