/**
 * Setup check engine — `suveren-gateway check`.
 *
 * Looks at one computer and reports whether an AI app has a way into the
 * company's systems other than this gateway. It reports; it fixes nothing.
 * It is a check, not a guarantee: every line is a fact it could read, or an
 * honest "cannot tell".
 *
 * Rules this file keeps:
 *   - Read-only: it only reads files and runs read-only system tools through
 *     the injected `io` (see providers.mjs). No network request at all.
 *   - No secret value ever leaves it: secrets are reported by location, by
 *     program name and kind of argument, or by variable NAME.
 *   - Every finding is `closed`, `open` or `cannot tell`.
 *   - No app is special-cased here. Each AI app is a data file in ./apps/;
 *     this engine only interprets these fields:
 *
 * App description fields
 *   id, name            identity; `name` is what the report prints
 *   account             the AI provider account its cloud connectors live in
 *                       (one "cannot tell" line per account)
 *   detect              { paths: [pathSpec], pathBinaries: [name],
 *                         dirPrefixes: [{ <platform>|all: dir, prefix }] } —
 *                       the app counts as found when any of these exists
 *   sources             [{ id, role: 'user'|'lock', format: 'json'|'toml'|
 *                         'plist'|'registry', verified, path: pathSpec,
 *                         expand? }]. A pathSpec maps a platform (`darwin`,
 *                       `win32`, `linux`) or `all` to a template string, or
 *                       to `{ format, path }` / `{ format: 'registry', key }`.
 *                       `verified` may also sit on one platform's entry
 *                       (`{ path, verified: '<date, version tested>' }`):
 *                       a location counts as tested only there.
 *                       `expand: { source, pointer, relPath }` = one file per
 *                       key of an object in another source (Claude Code's
 *                       project list) — never a disk crawl.
 *   connectors          [{ source, pointer }] — where configured connectors
 *                       (MCP servers) are; a pointer may contain '*'.
 *   connectorLocks      [{ kind: 'exclusive'|'allowlist'|'opaque', source,
 *                         pointer, requires?, unmet?, unmetDetail?, equals?,
 *                         detail?, ignoresUserConnectors? }] — how IT
 *                       restricts connectors. `ignoresUserConnectors: true`
 *                       = while this lock is present, the app itself switches
 *                       off connectors in the user's or project's settings:
 *                       all of them for an 'exclusive' lock (its own list is
 *                       used), and for an 'allowlist' every entry the lock
 *                       does not list with the same name AND address. Only
 *                       set where that was observed.
 *   abilities           { terminal|files|browser|screen: { checks: [{ source,
 *                         pointer, equals|includesAny|includesAll|present,
 *                         means: 'forbidden'|'allowed' }], default:
 *                         'allowed'|'cannot tell', fixed?, notes?,
 *                         unknownDetail? } }
 *   accountConnectors   { closedWhen: [condition], notes?: [condition+note] }
 *
 * The gateway itself is recognised by address, never by name: a connector
 * whose every URL points at this computer (GATEWAY_HOSTS) on the gateway's
 * MCP port.
 */

import { posix as posixPath, win32 as winPath } from 'node:path';
import { parseTomlLite } from './toml-lite.mjs';
import { APPS } from './apps/index.mjs';
import {
  CREDENTIAL_FILES, PROCESS_SECRET_PATTERNS, SECRET_ENV_NAME_PATTERNS, INTERPRETERS, isPlaceholderValue,
} from './secrets-data.mjs';

export const RESULTS = Object.freeze({ CLOSED: 'closed', OPEN: 'open', CANNOT_TELL: 'cannot tell' });

export const GROUPS = Object.freeze([
  { id: 'route', title: 'No other route' },
  { id: 'secrets', title: 'No passwords within reach' },
  { id: 'gateway', title: 'No hand on the gateway' },
]);

/** Addresses that mean "this computer". */
export const GATEWAY_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Group names that make a user an administrator, per platform. */
export const ADMIN_GROUPS = {
  darwin: { names: ['admin'], ifAbsent: RESULTS.CLOSED },
  // A Linux user outside these groups may still have sudo rights this check
  // cannot read without asking for a password.
  linux: { names: ['sudo', 'wheel', 'admin'], ifAbsent: RESULTS.CANNOT_TELL },
  // The local Administrators group SID — present (even "for deny only")
  // whenever the account is an administrator.
  win32: { names: ['S-1-5-32-544'], ifAbsent: RESULTS.CLOSED, substring: true },
};

export const CONFIRM_BY_HAND = [
  "Connectors switched on in each AI provider's account or admin console.",
  "Each connected system accepts only the gateway's own service account; older keys are revoked; that account allows no more than the mandates need.",
  'The AI cannot operate the browser or the screen in which the person approves.',
  'Every line marked "cannot tell" above.',
];

/** Footer line about untested locations; null when every one is tested. */
export function unverifiedNote(unverified, total) {
  if (!unverified) return null;
  if (unverified === total) {
    return `All ${total} settings and lock locations this check looked at come from the vendors' documentation and are not yet tested on a real install.`;
  }
  return `${unverified} of the ${total} settings and lock locations this check looked at come from the vendors' documentation and are not yet tested on a real install.`;
}

const ABILITY_LABELS = { terminal: 'terminal', files: 'file access', browser: 'browser control', screen: 'screen control' };

const POLICY_LABELS = {
  asUrl: 'Authority Server', caFile: 'certificate file', pinTls: 'certificate pin', proxy: 'proxy',
  noProxy: 'proxy exceptions', simulation: 'simulation', installMethod: 'updates', port: 'port',
  mcpPort: 'MCP port', dataDir: 'data folder', team: 'team',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(d) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─── Paths ──────────────────────────────────────────────────────────────

function pathApiFor(platform) {
  return platform === 'win32' ? winPath : posixPath;
}

function templateVars(ctx) {
  const p = pathApiFor(ctx.platform);
  const env = ctx.env ?? {};
  return {
    home: ctx.home,
    root: ctx.root ?? '',
    appData: env.APPDATA || p.join(ctx.home, 'AppData', 'Roaming'),
    localAppData: env.LOCALAPPDATA || p.join(ctx.home, 'AppData', 'Local'),
    programData: env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData',
    programFiles: env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files',
    xdgConfig: env.XDG_CONFIG_HOME || p.join(ctx.home, '.config'),
  };
}

function expandTemplate(ctx, template) {
  const vars = templateVars(ctx);
  const raw = template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`Unknown path variable {${name}} in an app description`);
    return vars[name];
  });
  return pathApiFor(ctx.platform).normalize(raw);
}

/** A pathSpec for this platform: `{ format?, path?, key? }` or null. */
function pickSpec(ctx, spec) {
  if (!spec) return null;
  const v = spec[ctx.platform] ?? spec.all;
  if (v === undefined) return null;
  return typeof v === 'string' ? { path: v } : v;
}

function resolvePathSpec(ctx, spec) {
  const s = pickSpec(ctx, spec);
  return s && s.path ? expandTemplate(ctx, s.path) : null;
}

/** "~/…" for paths in the home folder, for shorter report lines. */
function tilde(ctx, path) {
  if (!path || !ctx.home) return path;
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  if (path === ctx.home) return '~';
  if (path.startsWith(ctx.home + sep)) return `~${sep}${path.slice(ctx.home.length + 1)}`;
  return path;
}

/** Every location an app description resolves to on a platform — for
 *  tests and for `--json` readers who want to know what was looked at. */
export function resolveAppLocations(ctx, app) {
  const out = { detect: [], sources: {} };
  for (const spec of app.detect?.paths ?? []) {
    const p = resolvePathSpec(ctx, spec);
    if (p) out.detect.push(p);
  }
  for (const src of app.sources) {
    if (src.expand) continue;
    const s = pickSpec(ctx, src.path);
    if (!s) continue;
    out.sources[src.id] = s.key ? s.key : expandTemplate(ctx, s.path);
  }
  return out;
}

// ─── Reading sources ────────────────────────────────────────────────────

function parseByFormat(format, text) {
  if (format === 'json') return JSON.parse(text);
  if (format === 'toml') return parseTomlLite(text);
  throw new Error('unknown format');
}

/** Load one file/plist/registry source. Never throws. */
function loadOne(ctx, src, format, location, kind, verified = src.verified) {
  const base = {
    id: src.id, role: src.role, format, location, kind,
    verified: Boolean(verified),
    verifiedNote: typeof verified === 'string' ? verified : null,
  };
  if (format === 'registry') {
    const r = ctx.io.registry(location);
    if (r.missing) return { ...base, status: 'missing' };
    if (!r.ok) return { ...base, status: 'unreadable' };
    return { ...base, status: 'ok', data: r.data };
  }
  if (format === 'plist') {
    const r = ctx.io.plist(location);
    if (r.missing) return { ...base, status: 'missing' };
    if (!r.ok) return { ...base, status: 'unreadable' };
    return { ...base, status: 'ok', data: r.data };
  }
  const r = ctx.io.readText(location);
  if (r.missing) return { ...base, status: 'missing' };
  if (!r.ok) return { ...base, status: 'unreadable' };
  try {
    return { ...base, status: 'ok', data: parseByFormat(format, r.text) };
  } catch {
    // The parse error text is deliberately dropped: it could quote the file.
    return { ...base, status: 'unparseable' };
  }
}

/** All instances of every source of an app: `{ [id]: instance[] }`. */
function loadSources(ctx, app) {
  const loaded = {};
  const pending = [...app.sources];
  // Plain sources first; `expand` sources need theirs loaded.
  pending.sort((a, b) => Number(Boolean(a.expand)) - Number(Boolean(b.expand)));
  for (const src of pending) {
    if (src.expand) {
      const instances = [];
      for (const parent of loaded[src.expand.source] ?? []) {
        if (parent.status !== 'ok') continue;
        for (const holder of resolvePointer(parent.data, src.expand.pointer)) {
          if (!isPlainObject(holder)) continue;
          for (const key of Object.keys(holder)) {
            const p = pathApiFor(ctx.platform);
            if (!p.isAbsolute(key)) continue;
            const location = p.join(key, ...src.expand.relPath);
            instances.push(loadOne(ctx, src, src.format, location, 'file'));
          }
        }
      }
      loaded[src.id] = instances;
      continue;
    }
    const s = pickSpec(ctx, src.path);
    if (!s) { loaded[src.id] = []; continue; }
    const format = s.format ?? src.format;
    const location = format === 'registry' ? s.key : expandTemplate(ctx, s.path);
    loaded[src.id] = [loadOne(ctx, src, format, location, format === 'registry' ? 'registry' : 'file', s.verified ?? src.verified)];
  }
  return loaded;
}

/** Values at a pointer; '*' matches every key of an object. */
function resolvePointer(data, pointer) {
  let current = [data];
  for (const part of pointer ?? []) {
    const next = [];
    for (const v of current) {
      if (!isPlainObject(v)) continue;
      if (part === '*') next.push(...Object.values(v));
      else if (Object.prototype.hasOwnProperty.call(v, part)) next.push(v[part]);
    }
    current = next;
  }
  return current.map(coerce);
}

/** A registry or plist value may carry JSON as a string. */
function coerce(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { return JSON.parse(t); } catch { return v; }
    }
  }
  return v;
}

function sameValue(actual, expected) {
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') return actual === expected;
    if (actual === 0 || actual === '0' || actual === 'false') return expected === false;
    if (actual === 1 || actual === '1' || actual === 'true') return expected === true;
    return false;
  }
  return actual === expected;
}

/** Does a condition hold? `null` when its source could not be read. */
function conditionHolds(sources, cond) {
  const instances = sources[cond.source] ?? [];
  let sawUnreadable = false;
  for (const inst of instances) {
    if (inst.status === 'unreadable' || inst.status === 'unparseable') { sawUnreadable = true; continue; }
    if (inst.status !== 'ok') continue;
    for (const value of resolvePointer(inst.data, cond.pointer)) {
      if (testValue(value, cond)) return true;
    }
  }
  return sawUnreadable ? null : false;
}

function testValue(value, cond) {
  if (cond.present) return value !== undefined && value !== null;
  if ('equals' in cond) return sameValue(value, cond.equals);
  if (cond.includesAny) return Array.isArray(value) && cond.includesAny.some((x) => value.includes(x));
  if (cond.includesAll) return Array.isArray(value) && cond.includesAll.every((x) => value.includes(x));
  return false;
}

// ─── Connectors ─────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Every URL in a connector entry. `env` and `headers` are skipped: they
 *  hold keys, never the address. */
function collectUrls(entry) {
  const out = [];
  const walk = (v, key) => {
    if (key && /^(env|headers)$/i.test(key)) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(URL_RE)) {
        try { out.push(new URL(m[0])); } catch { /* not a URL */ }
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(entry);
  return out;
}

function isGatewayUrl(url, mcpPort) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!GATEWAY_HOSTS.includes(host)) return false;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return port === Number(mcpPort);
}

/** 'gateway' | 'other' | 'unknown'. An entry with no address that names a
 *  program (a command) is another connector; one that only carries a name
 *  (an allow-list entry by name) is 'unknown': any connector could use it. */
function classifyEntry(entry, mcpPort) {
  const urls = collectUrls(entry);
  if (urls.length) return urls.every((u) => isGatewayUrl(u, mcpPort)) ? 'gateway' : 'other';
  if (typeof entry === 'string') return 'unknown';
  if (isPlainObject(entry) && Object.keys(entry).every((k) => /^(name|serverName|id)$/i.test(k))) return 'unknown';
  return 'other';
}

/** `{ name, entry }` for every entry in a map or a list. */
function entriesOf(value) {
  if (isPlainObject(value)) return Object.entries(value).map(([name, entry]) => ({ name, entry }));
  if (Array.isArray(value)) {
    return value.map((entry, i) => ({
      name: (isPlainObject(entry) && (entry.name ?? entry.serverName ?? entry.id)) || `entry ${i + 1}`,
      entry,
    }));
  }
  return [];
}

function readConnectors(ctx, app, sources) {
  const gateway = [];
  const others = new Set();
  const unreadable = [];
  const entries = [];
  const seen = new Set();
  for (const spec of app.connectors) {
    for (const inst of sources[spec.source] ?? []) {
      if (inst.status === 'unreadable' || inst.status === 'unparseable') {
        if (!seen.has(inst.location)) { unreadable.push(inst); seen.add(inst.location); }
        continue;
      }
      if (inst.status !== 'ok') continue;
      for (const holder of resolvePointer(inst.data, spec.pointer)) {
        for (const { name, entry } of entriesOf(holder)) {
          entries.push({ name: String(name), entry });
          // A stdio connector with no address is not the gateway.
          if (classifyEntry(entry, ctx.mcpPort) === 'gateway') gateway.push(name);
          else others.add(String(name));
        }
      }
    }
  }
  return { gateway, others: [...others], unreadable, entries, entryCount: gateway.length + others.size };
}

/** Evaluate one connector-lock mechanism; null when it is not in place. */
function evalLock(ctx, app, sources, lock) {
  const instances = (sources[lock.source] ?? []);
  const inst = instances[0];
  if (!inst || inst.status === 'missing') return null;
  const where = inst.kind === 'registry' ? inst.location : tilde(ctx, inst.location);
  if (inst.status !== 'ok') {
    return { result: RESULTS.CANNOT_TELL, detail: `could not read the IT lock (${where})`, inst };
  }
  if (lock.kind === 'opaque') {
    if (lock.pointer && !conditionHolds(sources, { source: lock.source, pointer: lock.pointer, equals: lock.equals })) return null;
    return { result: RESULTS.CANNOT_TELL, detail: lock.detail, inst };
  }
  const values = resolvePointer(inst.data, lock.pointer);
  if (lock.kind === 'allowlist' && values.length === 0) return null;
  for (const cond of lock.requires ?? []) {
    const holds = conditionHolds(sources, cond);
    if (holds === null) return { result: RESULTS.CANNOT_TELL, detail: `could not read the IT lock (${where})`, inst };
    if (!holds) return { result: lock.unmet ?? RESULTS.OPEN, detail: lock.unmetDetail ?? 'the IT lock is not complete', inst };
  }
  const entries = values.flatMap(entriesOf);
  if (values.some((v) => !isPlainObject(v) && !Array.isArray(v))) {
    return { result: RESULTS.CANNOT_TELL, detail: `the IT list of connectors has a form this check does not know (${where})`, inst };
  }
  const gatewayNames = [];
  const otherNames = [];
  let unknown = 0;
  for (const { name, entry } of entries) {
    const c = classifyEntry(entry, ctx.mcpPort);
    if (c === 'gateway') gatewayNames.push(name);
    else if (c === 'other') otherNames.push(String(name));
    else unknown++;
  }
  const listed = { inst, spec: lock, gatewayNames, otherNames, entries };
  if (otherNames.length) {
    return { ...listed, result: RESULTS.OPEN, detail: `the IT lock also allows ${countNoun(otherNames.length, 'other connector')} (${otherNames.join(', ')})` };
  }
  if (unknown) {
    return { ...listed, result: RESULTS.CANNOT_TELL, detail: 'the IT allow list names connectors without their address, so another connector could use the same name' };
  }
  return {
    ...listed,
    result: RESULTS.CLOSED,
    detail: gatewayNames.length ? 'IT allows only the gateway as connector' : 'IT allows no connectors on this computer',
  };
}

/** Same set of addresses; an allow-list entry without any address (e.g. a
 *  command identity) is matched by name alone. */
function sameAddresses(lockEntry, userEntry) {
  const key = (e) => collectUrls(e).map((u) => u.href).sort().join(' ');
  const l = key(lockEntry);
  return l === '' || l === key(userEntry);
}

function countNoun(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function evalConnectorLock(ctx, app, sources) {
  const results = (app.connectorLocks ?? []).map((l) => evalLock(ctx, app, sources, l)).filter(Boolean);
  // A lock whose own list replaces the user's connectors (data flag).
  const exclusive = results.find((r) => r.spec?.ignoresUserConnectors && r.gatewayNames) ?? null;
  if (results.length === 0) {
    return { result: RESULTS.OPEN, detail: 'no IT lock, so the user can add connectors', inst: null, exclusive };
  }
  // A lock that holds wins; then an honest "cannot tell"; then open.
  const pick = results.find((r) => r.result === RESULTS.CLOSED)
    ?? results.find((r) => r.result === RESULTS.CANNOT_TELL)
    ?? results[0];
  if (pick.result === RESULTS.CLOSED && pick.inst) {
    const w = lockWritable(ctx, pick.inst);
    const where = tilde(ctx, pick.inst.location);
    if (w === true) return { ...pick, exclusive, result: RESULTS.OPEN, detail: `${pick.detail}, but this user can change the lock (${where})`, writable: true };
    if (w === null) return { ...pick, exclusive, result: RESULTS.CANNOT_TELL, detail: `${pick.detail}, but whether this user can change the lock could not be read (${where})` };
  }
  return { ...pick, exclusive };
}

/** true | false | null. A registry policy key is changeable by
 *  administrators only (that is reported on its own line); a file lock is
 *  checked for real. */
function lockWritable(ctx, inst) {
  if (inst.kind === 'registry') return false;
  return ctx.io.writable(inst.location);
}

// ─── Abilities ──────────────────────────────────────────────────────────

/** → { state, notes, detail? } ; state: allowed | user-forbidden |
 *  it-forbidden | it-forbidden-writable | unknown | unreadable */
function evalAbility(ctx, app, sources, spec) {
  const notes = [];
  for (const n of spec.notes ?? []) {
    if (conditionHolds(sources, n)) notes.push(n.note);
  }
  if (spec.fixed) return { state: 'fixed', detail: spec.fixed.detail, notes };
  for (const check of spec.checks ?? []) {
    const holds = conditionHolds(sources, check);
    const inst = (sources[check.source] ?? [])[0];
    if (holds === null && inst?.role === 'lock') return { state: 'unreadable', notes, where: tilde(ctx, inst.location) };
    if (!holds) continue;
    if (check.means === 'allowed') return { state: 'allowed', notes };
    if (inst.role === 'lock') {
      const w = lockWritable(ctx, inst);
      const state = w === true ? 'it-forbidden-writable' : w === null ? 'it-forbidden-unknown' : 'it-forbidden';
      return { state, notes, where: tilde(ctx, inst.location) };
    }
    return { state: 'user-forbidden', notes };
  }
  if (spec.default === 'allowed') return { state: 'allowed', notes };
  return { state: 'unknown', notes, detail: spec.unknownDetail };
}

const ABILITY_PHRASES = {
  allowed: { result: RESULTS.OPEN, text: (l, are) => `${l} ${are ? 'are' : 'is'} allowed` },
  'user-forbidden': { result: RESULTS.OPEN, text: (l, are) => `${l} ${are ? 'are' : 'is'} switched off only in the user's own settings, which the user can change` },
  'it-forbidden': { result: RESULTS.CLOSED, text: (l, are) => `${l} ${are ? 'are' : 'is'} switched off by IT` },
  'it-forbidden-writable': { result: RESULTS.OPEN, text: (l, are) => `${l} ${are ? 'are' : 'is'} switched off by IT, but this user can change the lock` },
  'it-forbidden-unknown': { result: RESULTS.CANNOT_TELL, text: (l, are) => `${l} ${are ? 'are' : 'is'} switched off by IT, but whether this user can change the lock could not be read` },
  unknown: { result: RESULTS.CANNOT_TELL, text: (l) => `${l}: cannot tell from its settings` },
  unreadable: { result: RESULTS.CANNOT_TELL, text: (l) => `${l}: cannot tell, the IT lock could not be read` },
};

function abilityFindings(ctx, app, sources, source) {
  const evaluated = Object.entries(app.abilities ?? {}).map(([key, spec]) => ({ key, ...evalAbility(ctx, app, sources, spec) }));
  const out = [];
  // Abilities with the same state and nothing extra to say share one line.
  const simple = new Map();
  for (const a of evaluated) {
    const label = ABILITY_LABELS[a.key] ?? a.key;
    const extra = [a.detail, ...a.notes].filter(Boolean);
    if (a.state === 'fixed') {
      out.push({ result: RESULTS.OPEN, label, text: `${label} is allowed: ${extra.join('; ')}` });
      continue;
    }
    if (extra.length) {
      const phrase = ABILITY_PHRASES[a.state];
      out.push({ result: phrase.result, label, text: `${phrase.text(label, false)} (${extra.join('; ')})` });
      continue;
    }
    if (!simple.has(a.state)) simple.set(a.state, []);
    simple.get(a.state).push(label);
  }
  for (const [state, labels] of simple) {
    const phrase = ABILITY_PHRASES[state];
    out.push({ result: phrase.result, text: phrase.text(joinList(labels), labels.length > 1) });
  }
  // Keep a stable order: the order abilities are listed in.
  const order = (f) => Math.min(...Object.values(ABILITY_LABELS).map((l, i) => (f.text.startsWith(l) ? i : 99)));
  out.sort((a, b) => order(a) - order(b));
  return out.map((f) => ({ group: 'route', result: f.result, subject: app.name, detail: f.text, source, verified: false }));
}

// ─── Group 1: No other route ────────────────────────────────────────────

function isAppFound(ctx, app, sources) {
  for (const spec of app.detect?.paths ?? []) {
    const p = resolvePathSpec(ctx, spec);
    if (p && ctx.io.exists(p)) return true;
  }
  const pathDirs = String(ctx.env?.PATH ?? ctx.env?.Path ?? '').split(ctx.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = ctx.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const p = pathApiFor(ctx.platform);
  for (const bin of app.detect?.pathBinaries ?? []) {
    for (const dir of pathDirs) {
      for (const ext of exts) {
        if (ctx.io.exists(p.join(dir, bin + ext))) return true;
      }
    }
  }
  for (const dp of app.detect?.dirPrefixes ?? []) {
    const dir = resolvePathSpec(ctx, dp);
    const names = dir ? ctx.io.list(dir) : null;
    if (names && names.some((n) => n.startsWith(dp.prefix))) return true;
  }
  return Object.values(sources).flat().some((inst) => inst.role === 'user' && inst.status !== 'missing');
}

function describeInstances(ctx, instances) {
  return instances
    .filter((i) => i.status !== 'missing')
    .map((i) => (i.kind === 'registry' ? i.location : tilde(ctx, i.location)))
    .join('; ');
}

function routeFindingsForApp(ctx, app, sources) {
  const findings = [];
  const add = (result, detail, source) => findings.push({ group: 'route', result, subject: app.name, detail, source, verified: false });
  const userInsts = app.connectors.flatMap((c) => sources[c.source] ?? []);
  const userSource = describeInstances(ctx, userInsts) || 'no connector settings found';
  const fromUser = readConnectors(ctx, app, sources);
  const { unreadable } = fromUser;
  const lock = evalConnectorLock(ctx, app, sources);
  // With an exclusive lock in place the app runs only the lock's own list;
  // what is left in the user's or project's settings is switched off.
  const ex = lock.exclusive;
  let gateway = fromUser.gateway;
  let others = fromUser.others;
  let leftovers = 0;
  if (ex && ex.spec.kind === 'allowlist') {
    // The app keeps a connector from the user's settings only when the
    // lock lists it with the same name AND the same address (observed with
    // codex-cli 0.167.2); every other entry is switched off.
    const enabled = fromUser.entries.filter((u) => ex.entries.some((l) => String(l.name) === u.name && sameAddresses(l.entry, u.entry)));
    gateway = enabled.filter((u) => classifyEntry(u.entry, ctx.mcpPort) === 'gateway').map((u) => u.name);
    others = [...new Set(enabled.filter((u) => classifyEntry(u.entry, ctx.mcpPort) !== 'gateway').map((u) => u.name))];
    leftovers = fromUser.entries.length - enabled.length;
  } else if (ex) {
    // The lock's own list replaces the user's connectors.
    gateway = ex.gatewayNames;
    others = ex.otherNames;
    leftovers = fromUser.entryCount;
  }
  const leftoverNote = leftovers
    ? ` (${leftovers} ${leftovers === 1 ? 'entry' : 'entries'} in the user's settings ${leftovers === 1 ? 'is' : 'are'} switched off by the lock)`
    : '';
  const lockSource = lock.inst ? (lock.inst.kind === 'registry' ? lock.inst.location : tilde(ctx, lock.inst.location)) : 'no IT lock found';

  for (const inst of unreadable) {
    add(RESULTS.CANNOT_TELL, `could not read ${tilde(ctx, inst.location)}`, tilde(ctx, inst.location));
  }

  const gatewayCount = ex
    ? gateway.length
    : gateway.length + (lock.result === RESULTS.CLOSED || lock.writable ? (lock.gatewayNames?.length ?? 0) : 0);
  const lockHolds = lock.result === RESULTS.CLOSED;
  const gatewayNote = gatewayCount > 1 ? ` (${gatewayCount} entries point to it)` : '';
  const connSource = ex ? `${lockSource}; ${userSource}` : userSource;

  if (others.length && ex) {
    add(RESULTS.OPEN, `${countNoun(others.length, 'other connector')} in IT's list (${others.join(', ')})${leftoverNote}`, connSource);
  } else if (others.length && lockHolds) {
    add(RESULTS.CLOSED, `${countNoun(others.length, 'other connector')} set up (${others.join(', ')}), but IT allows only the gateway`, `${userSource}; ${lockSource}`);
  } else if (others.length) {
    add(RESULTS.OPEN, `${countNoun(others.length, 'other connector')} (${others.join(', ')})`, userSource);
  } else if (gatewayCount) {
    add(RESULTS.CLOSED, `the gateway is the only connector${gatewayNote}${leftoverNote}`, connSource);
  } else {
    add(RESULTS.CLOSED, `no other connectors${leftoverNote}`, connSource);
  }
  if (!gatewayCount) {
    add(RESULTS.OPEN, 'the gateway is not connected in this app', connSource);
  }

  add(lock.result, lock.detail, lockSource);

  const abilitySource = describeInstances(ctx, Object.values(sources).flat().filter((i) => !i.id.startsWith('project'))) || 'built-in behaviour of the app';
  findings.push(...abilityFindings(ctx, app, sources, abilitySource));
  return findings;
}

function adminFinding(ctx) {
  const add = (result, detail) => ({ group: 'route', result, subject: '', detail, source: ctx.platform === 'win32' ? 'whoami /groups' : 'id -Gn', verified: true });
  if (ctx.uid === 0) return add(RESULTS.OPEN, 'This check runs as the system administrator (root), so the user setup cannot be judged');
  const rule = ADMIN_GROUPS[ctx.platform];
  if (!rule) return add(RESULTS.CANNOT_TELL, 'Whether this user is an administrator: not known on this kind of computer');
  const r = ctx.io.groups();
  if (!r.ok) return add(RESULTS.CANNOT_TELL, 'Whether this user is an administrator: could not read the group list');
  const isAdmin = rule.substring
    ? rule.names.some((n) => r.stdout.includes(n))
    : r.stdout.split(/\s+/).some((g) => rule.names.includes(g));
  if (isAdmin) return add(RESULTS.OPEN, 'This user is an administrator on this computer and can undo every lock');
  if (rule.ifAbsent === RESULTS.CLOSED) return add(RESULTS.CLOSED, 'This user is not an administrator on this computer');
  return add(RESULTS.CANNOT_TELL, 'This user is in no administrator group, but other administrator rights cannot be read');
}

function accountFindings(ctx, foundApps) {
  const byAccount = new Map();
  for (const { app, sources } of foundApps) {
    if (!app.account) continue;
    if (!byAccount.has(app.account)) byAccount.set(app.account, []);
    byAccount.get(app.account).push({ app, sources });
  }
  const out = [];
  for (const [account, list] of byAccount) {
    const allClosed = list.every(({ app, sources }) => (app.accountConnectors?.closedWhen ?? []).length > 0
      && app.accountConnectors.closedWhen.every((c) => conditionHolds(sources, c) === true));
    const notes = list.flatMap(({ app, sources }) => (app.accountConnectors?.notes ?? []).filter((n) => conditionHolds(sources, n)).map((n) => n.note));
    const source = `${account} (not stored on this computer)`;
    if (allClosed) {
      out.push({ group: 'route', result: RESULTS.CLOSED, subject: `Connectors in the ${account}`, detail: `switched off by IT for ${joinList(list.map((x) => x.app.name))}`, source, verified: false });
    } else {
      out.push({ group: 'route', result: RESULTS.CANNOT_TELL, subject: `Connectors in the ${account}`, detail: `confirm in the admin console${notes.length ? ` (${notes.join('; ')})` : ''}`, source, verified: false });
    }
  }
  return out;
}

// ─── Group 2: No passwords within reach ─────────────────────────────────

/** A short, value-free name for the program a process runs. */
export function programLabel(command, secretValues) {
  // Double quotes group a path with spaces (Windows: "C:\\Program Files\\…").
  const tokens = [...command.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  const base = (t) => t.split(/[\\/]/).pop() ?? t;
  // The package (or, under node_modules/.bin, the command) after the LAST
  // node_modules in the path.
  const fromNodeModules = (t) => {
    const all = [...t.matchAll(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)(?:[\\/]([^\\/]+))?/g)];
    const m = all[all.length - 1];
    if (!m) return null;
    if (m[1] === '.bin') return m[2] ?? null;
    return m[1].replace(/\\/g, '/');
  };
  let label = base(tokens[0] ?? '').replace(/\.(exe|cmd)$/i, '');
  if (INTERPRETERS.includes(label.toLowerCase())) {
    const isNpx = /^(npx|bunx|uvx)$/i.test(label);
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-')) continue;
      if (/[\\/]/.test(t)) { label = fromNodeModules(t) ?? base(t).replace(/\.(m?js|cjs|ts|py|rb|pl|sh)$/i, ''); break; }
      if (isNpx) { label = t.replace(/(.)@[^@]*$/, '$1'); break; }
      break;
    }
  }
  label = label.replace(/[^A-Za-z0-9._@/+-]/g, '').slice(0, 40);
  // Belt and braces: a program name that contains a found value is dropped.
  if (!label || secretValues.some((v) => v && v.length >= 4 && label.includes(v))) return 'a program';
  return label;
}

function processFindings(ctx) {
  const r = ctx.io.ps();
  const source = r.source
    ?? (ctx.platform === 'win32' ? 'process list (PowerShell Get-CimInstance Win32_Process)' : 'process list (ps)');
  // On Windows a check without administrator rights is shown only the
  // command lines of its own account's programs.
  const scope = ctx.platform === 'win32' ? '; on Windows, without administrator rights this check sees only this user\'s programs' : '';
  if (!r.ok) {
    return [{ group: 'secrets', result: RESULTS.CANNOT_TELL, subject: '', detail: 'Process list: could not be read', source, verified: true }];
  }
  const readers = ctx.platform === 'win32'
    ? 'readable by programs of this user and by administrators'
    : 'readable by every user of this computer';
  const hits = new Map();
  for (const command of r.commands) {
    const values = [];
    const kinds = [];
    for (const p of PROCESS_SECRET_PATTERNS) {
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
      for (const m of command.matchAll(re)) {
        if (!m[1] || isPlaceholderValue(m[1])) continue;
        values.push(m[1]);
        if (!kinds.includes(p.kind)) kinds.push(p.kind);
      }
    }
    if (!kinds.length) continue;
    const label = programLabel(command, values);
    for (const kind of kinds) {
      const key = `${label}\u0000${kind}`;
      hits.set(key, { label, kind, count: (hits.get(key)?.count ?? 0) + 1 });
    }
  }
  if (!hits.size) {
    return [{ group: 'secrets', result: RESULTS.CLOSED, subject: '', detail: `No passwords or tokens in the process list${scope ? ` (${scope.slice(2)})` : ''}`, source, verified: true }];
  }
  return [...hits.values()].map((h) => ({
    group: 'secrets',
    result: RESULTS.OPEN,
    subject: h.label,
    detail: `${h.kind} in its start command, ${readers}${h.count > 1 ? ` (${h.count} processes)` : ''}${scope}`,
    source,
    verified: true,
  }));
}

function credentialFileFindings(ctx) {
  const findings = [];
  let checked = 0;
  const p = pathApiFor(ctx.platform);
  for (const cf of ctx.credentialFiles ?? CREDENTIAL_FILES) {
    const path = resolvePathSpec(ctx, cf.path);
    if (!path) continue;
    checked++;
    const where = tilde(ctx, path);
    if (cf.anyOf) {
      if (!ctx.io.isDir(path)) continue;
      if (cf.anyOf.some((name) => ctx.io.exists(p.join(path, name)))) {
        findings.push({ group: 'secrets', result: RESULTS.OPEN, subject: '', detail: `Key file for ${cf.label}: ${where}`, source: where, verified: true });
      }
      continue;
    }
    const r = ctx.io.readText(path);
    if (r.missing) continue;
    if (!r.ok) {
      findings.push({ group: 'secrets', result: RESULTS.CANNOT_TELL, subject: '', detail: `Could not read ${where} (may hold ${cf.label})`, source: where, verified: true });
      continue;
    }
    if (!cf.pattern || cf.pattern.test(r.text)) {
      findings.push({ group: 'secrets', result: RESULTS.OPEN, subject: '', detail: `Key file for ${cf.label}: ${where}`, source: where, verified: true });
    }
  }
  if (!findings.length) {
    findings.push({ group: 'secrets', result: RESULTS.CLOSED, subject: '', detail: `No key files for connected systems outside the vault (${checked} well-known places checked)`, source: 'well-known key file locations in the home folder', verified: true });
  }
  return findings;
}

function envFindings(ctx) {
  const names = Object.entries(ctx.env ?? {})
    .filter(([name, value]) => value && SECRET_ENV_NAME_PATTERNS.some((re) => re.test(name)))
    .map(([name]) => name)
    .sort();
  const source = 'environment variable names of this terminal';
  if (!names.length) {
    return [{ group: 'secrets', result: RESULTS.CLOSED, subject: '', detail: "No secret-looking names in this terminal's environment", source, verified: true }];
  }
  return [{
    group: 'secrets',
    result: RESULTS.OPEN,
    subject: '',
    detail: `Secret-looking names in this terminal's environment: ${names.join(', ')} (programs started from here, an AI app too, get them)`,
    source,
    verified: true,
  }];
}

// ─── Group 3: No hand on the gateway ────────────────────────────────────

function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function bindFinding(ctx) {
  const g = ctx.gateway;
  const base = { group: 'gateway', subject: '', verified: true };
  if (g.inContainer) {
    return { ...base, result: RESULTS.CANNOT_TELL, detail: 'The gateway runs in a container: who can reach it depends on how its port is published', source: 'SUVEREN_CONTAINER / /.dockerenv' };
  }
  const settings = [];
  const envHost = ctx.env?.SUVEREN_BIND_HOST?.trim();
  if (envHost) settings.push({ where: 'SUVEREN_BIND_HOST in this terminal', host: envHost, token: Boolean(ctx.env?.SUVEREN_MCP_TOKEN?.trim()) });
  const text = g.serviceDefinitionText;
  if (text) {
    const m = /<key>SUVEREN_BIND_HOST<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
      ?? /Environment="?SUVEREN_BIND_HOST=([^"\s]*)/.exec(text);
    if (m && m[1].trim()) settings.push({ where: 'the login service', host: m[1].trim(), token: /SUVEREN_MCP_TOKEN/.test(text) });
  }
  const source = ['SUVEREN_BIND_HOST (this terminal)', g.serviceDefinitionPath ? tilde(ctx, g.serviceDefinitionPath) : null].filter(Boolean).join('; ');
  const wide = settings.filter((s) => !isLoopbackHost(s.host));
  if (!wide.length) {
    return { ...base, result: RESULTS.CLOSED, detail: 'Gateway is set to answer only on this computer', source };
  }
  const noToken = wide.find((s) => !s.token);
  if (noToken) {
    return { ...base, result: RESULTS.OPEN, detail: `Gateway is set to answer other computers (${noToken.host}, from ${noToken.where}) without a token`, source };
  }
  return { ...base, result: RESULTS.CLOSED, detail: `Gateway is set to answer other computers (${wide[0].host}), and a token is set for them`, source };
}

/**
 * The IT settings line(s) of "No hand on the gateway". One fact per line:
 * the state of the Authority Server address lock. Whether this user could
 * create the settings file is folded into that line where it is the same
 * fact (no settings / address not fixed), so the result never counts it
 * twice.
 */
function itSettingsFindings(ctx) {
  const pol = ctx.gateway.policy ?? {};
  const where = [pol.file, pol.registry].filter(Boolean).join('; ') || 'IT settings';
  const line = (result, detail, source = where) => ({ group: 'gateway', result, subject: '', detail, source, verified: true });
  const label = (k) => POLICY_LABELS[k] ?? k;
  if (pol.error) return [line(RESULTS.CANNOT_TELL, 'The IT settings for the gateway could not be read')];

  const locked = pol.locked ?? [];
  const settingsExist = locked.length > 0 || pol.fileExists === true;
  // Could this user plant the settings file? Only asked when it is absent.
  const createNote = () => {
    if (!pol.file || pol.fileExists) return '';
    const c = ctx.io.nearestCreatable(pol.file);
    if (c.writable === true) return '; this user could also create that file themselves';
    if (c.writable === null) return '; whether this user could create that file could not be read';
    return '';
  };

  if (!settingsExist) {
    const fixWhere = pol.machineRegistryKey ? `${pol.file}, or the registry key ${pol.machineRegistryKey}` : pol.file;
    return [line(RESULTS.OPEN, `No IT settings file: this user can point the gateway at another Authority Server. IT closes this by fixing the address in the settings file (${fixWhere})${createNote()}`)];
  }

  if (!locked.includes('asUrl')) {
    const fixed = locked.length ? joinList(locked.map(label)) : 'nothing';
    return [line(RESULTS.OPEN, `The IT settings do not fix the Authority Server address (they fix: ${fixed})${createNote()}`)];
  }

  const teamNote = locked.includes('team') ? '' : ' (the team is not fixed; teams are optional)';
  const source = pol.sources?.asUrl;
  if (source === 'HKLM') {
    return [line(RESULTS.CLOSED, `IT has fixed the Authority Server address, and this user cannot change that${teamNote}`, pol.machineRegistryKey ?? where)];
  }
  if (source === 'HKCU') {
    return [line(RESULTS.OPEN, `IT has fixed the Authority Server address only in this user's own registry hive (${pol.userRegistryKey ?? 'HKCU'}), which this user can change`, pol.userRegistryKey ?? where)];
  }
  if (source === 'file') {
    const w = pol.fileExists ? ctx.io.writable(pol.file) : null;
    if (w === false) return [line(RESULTS.CLOSED, `IT has fixed the Authority Server address, and this user cannot change that${teamNote}`, pol.file)];
    if (w === true) return [line(RESULTS.OPEN, `IT has fixed the Authority Server address, but this user can change the settings file (${pol.file})`, pol.file)];
    return [line(RESULTS.CANNOT_TELL, `IT has fixed the Authority Server address, but whether this user can change the settings file could not be read (${pol.file})`, pol.file)];
  }
  return [line(RESULTS.CANNOT_TELL, 'IT has fixed the Authority Server address, but where that is set could not be read')];
}

function gatewayFindings(ctx, appsFound) {
  const g = ctx.gateway;
  const out = [bindFinding(ctx)];
  const add = (result, detail, source) => out.push({ group: 'gateway', result, subject: '', detail, source, verified: true });

  // Program files.
  if (g.programDir) {
    const w = ctx.io.writable(g.programDir);
    if (w === true) {
      add(RESULTS.OPEN, `This user can change the gateway's program files (${tilde(ctx, g.programDir)})`, g.programDir);
    } else if (w === false) {
      add(RESULTS.CLOSED, "This user cannot change the gateway's program files", g.programDir);
    } else {
      add(RESULTS.CANNOT_TELL, `Whether this user can change the gateway's program files could not be read (${tilde(ctx, g.programDir)})`, g.programDir);
    }
  } else {
    add(RESULTS.CANNOT_TELL, "Who can change the gateway's program files: its folder is not known", 'program folder');
  }

  // IT settings (policy.mjs): what matters is the Authority Server address.
  // Whoever can change it can point the gateway at a server of their own
  // that signs anything, and the company's limits no longer bind it.
  out.push(...itSettingsFindings(ctx));

  // Same user account.
  const dataSource = g.dataDir ? tilde(ctx, g.dataDir) : 'data folder';
  if (!appsFound.length) {
    add(RESULTS.CLOSED, 'No AI app found under this user account', dataSource);
  } else if (!g.dataDir || !ctx.io.exists(g.dataDir)) {
    add(RESULTS.CANNOT_TELL, "Whether AI app and gateway run under the same user account: the gateway's data folder was not found", dataSource);
  } else {
    let sameUser;
    if (ctx.platform === 'win32' || ctx.uid === null || ctx.uid === undefined) {
      const sep = ctx.platform === 'win32' ? '\\' : '/';
      sameUser = g.dataDir.toLowerCase().startsWith((ctx.home + sep).toLowerCase());
    } else {
      sameUser = ctx.io.ownerUid(g.dataDir) === ctx.uid;
    }
    if (sameUser) {
      add(RESULTS.OPEN, 'AI app and gateway run under the same user account: this setup relies on the AI app having no terminal (the data folder and saved settings belong to this user)', dataSource);
    } else {
      add(RESULTS.CLOSED, 'The gateway\'s data folder belongs to another user account than the AI app', dataSource);
    }
  }

  if (g.settingsErrors) {
    add(RESULTS.CANNOT_TELL, 'Some saved gateway settings could not be read', g.installSettingsLocation ?? 'saved settings');
  }

  add(RESULTS.CANNOT_TELL, `Gateway ${g.version || '(version unknown)'}: whether it is the newest release is not checked (this check makes no network request)`, 'package.json of the installed gateway');
  return out;
}

// ─── Run ────────────────────────────────────────────────────────────────

/**
 * Run every check. `ctx`:
 *   platform, home, env, root ('' = real system folders), now (Date), uid,
 *   mcpPort, io (see providers.mjs), apps?, credentialFiles?,
 *   gateway: { version, simulation, dataDir, programDir, policy:
 *     { locked, file, fileExists, registry, error }, serviceDefinitionText,
 *     serviceDefinitionPath, inContainer, settingsErrors,
 *     installSettingsLocation }
 *   notes?: extra lines for the report footer (e.g. a test fixture in use)
 */
export function runSetupCheck(ctx) {
  const apps = ctx.apps ?? APPS;
  const found = [];
  for (const app of apps) {
    const sources = loadSources(ctx, app);
    if (isAppFound(ctx, app, sources)) found.push({ app, sources });
  }

  const findings = [];
  for (const { app, sources } of found) findings.push(...routeFindingsForApp(ctx, app, sources));
  findings.push({ group: 'route', result: RESULTS.CANNOT_TELL, subject: 'Other AI apps', detail: `not recognised by this check (it knows ${joinList(apps.map((a) => a.name))})`, source: 'built-in list of AI apps', verified: true });
  findings.push(adminFinding(ctx));
  findings.push(...accountFindings(ctx, found));

  findings.push(...processFindings(ctx));
  findings.push(...credentialFileFindings(ctx));
  findings.push(...envFindings(ctx));

  findings.push(...gatewayFindings(ctx, found));

  const order = GROUPS.map((g) => g.id);
  findings.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

  // Every settings / lock location looked at for the apps found.
  const locations = [];
  const seenLoc = new Set();
  for (const { app, sources } of found) {
    for (const inst of Object.values(sources).flat()) {
      const key = `${app.id}\u0000${inst.location}`;
      if (seenLoc.has(key)) continue;
      seenLoc.add(key);
      locations.push({ app: app.name, role: inst.role, location: inst.location, present: inst.status !== 'missing', verified: inst.verified, verifiedNote: inst.verifiedNote });
    }
  }
  const notes = [...(ctx.notes ?? [])];
  const note = unverifiedNote(locations.filter((l) => !l.verified).length, locations.length);
  if (note) notes.push(note);

  const summary = {
    open: findings.filter((f) => f.result === RESULTS.OPEN).length,
    closed: findings.filter((f) => f.result === RESULTS.CLOSED).length,
    cannotTell: findings.filter((f) => f.result === RESULTS.CANNOT_TELL).length,
  };

  return {
    date: ctx.now ?? new Date(),
    gateway: { version: ctx.gateway?.version ?? '', simulation: ctx.gateway?.simulation ?? null, mcpPort: Number(ctx.mcpPort) },
    aiAppsFound: found.map(({ app }) => ({ id: app.id, name: app.name })),
    locations,
    findings: findings.map(({ verified, ...f }) => f),
    confirmByHand: CONFIRM_BY_HAND,
    notes,
    summary,
    exitCode: summary.open > 0 ? 1 : 0,
  };
}
