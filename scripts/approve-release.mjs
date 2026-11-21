#!/usr/bin/env node
// Release manifest for the phone app (apps/approve): generate it, and compare
// files against it. Used by .github/workflows/approve-build.yml (manifest, and
// the independent rebuild check), approve-publish.yml (files vs manifest
// before deploy) and approve-compare.yml (live site vs manifest).
//
// Node built-ins only. No new packages. Test: node --test scripts/approve-release.test.mjs
//
//   node scripts/approve-release.mjs manifest <dir> --tag T --commit C --out manifest.json
//   node scripts/approve-release.mjs compare  --manifest manifest.json --dir <dir>   [--out result.json]
//   node scripts/approve-release.mjs compare  --manifest manifest.json --url https://host [--out result.json]
//
// Exit codes: 0 = every file matches; 1 = a difference (or the site cannot be read); 2 = bad usage.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_SCHEMA = 'suveren-approve-manifest/1';
export const RESULT_SCHEMA = 'suveren-approve-compare/1';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// A manifest comes from outside (a release asset), so its paths are untrusted.
export function assertSafePath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0') ||
      p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe path in manifest: ${JSON.stringify(p)}`);
  }
}

// Bytewise sort by UTF-8 (not locale), so every machine gets the same order.
function byPath(a, b) {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

// Every regular file under dir. A symlink or other special file is an error:
// a served file must be exactly the bytes that are hashed.
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(dir, full).split(sep).join('/'));
      else throw new Error(`not a regular file: ${full}`);
    }
  };
  walk(dir);
  return out;
}

export function buildManifest(dir, { tag, commit }) {
  const files = listFiles(dir).map((path) => {
    const bytes = readFileSync(join(dir, ...path.split('/')));
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  }).sort(byPath);
  if (files.length === 0) throw new Error(`no files under ${dir}`);
  // No timestamp on purpose: two builds of the same source give the same manifest.
  return { schema: MANIFEST_SCHEMA, tag, commit, files };
}

export function parseManifest(text) {
  const m = JSON.parse(text);
  if (m.schema !== MANIFEST_SCHEMA) throw new Error(`unknown manifest schema: ${m.schema}`);
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('manifest lists no files');
  const seen = new Set();
  for (const f of m.files) {
    assertSafePath(f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256 for ${f.path}`);
    if (seen.has(f.path)) throw new Error(`duplicate path in manifest: ${f.path}`);
    seen.add(f.path);
  }
  return m;
}

// Pure comparison.
//   observed.hashes : Map path -> sha256 hex of what is served, or null when the file could not be read
//   observed.extra  : paths (or URLs) that are served or referenced but are not in the manifest
//   observed.errors : Map path -> short reason for a null (HTTP 404, network error, ...)
export function compareManifest(manifest, observed) {
  const changed = [];
  const missing = [];
  for (const f of manifest.files) {
    const got = observed.hashes.get(f.path);
    if (got === undefined || got === null) {
      missing.push({ path: f.path, reason: observed.errors?.get(f.path) ?? 'not served' });
    } else if (got !== f.sha256) {
      changed.push({ path: f.path, expected: f.sha256, actual: got });
    }
  }
  const known = new Set(manifest.files.map((f) => f.path));
  const extra = [...new Set(observed.extra ?? [])].filter((p) => !known.has(p)).sort();
  const ok = changed.length === 0 && missing.length === 0 && extra.length === 0;
  return { status: ok ? 'green' : 'red', checked: manifest.files.length, changed, missing, extra };
}

export function observeDir(dir) {
  const hashes = new Map();
  for (const p of listFiles(dir)) hashes.set(p, sha256Hex(readFileSync(join(dir, ...p.split('/')))));
  return { hashes, extra: [...hashes.keys()], errors: new Map() };
}

// Local files and external origins that a served HTML page pulls in. A file the
// live site loads that the release does not list is a difference, even though
// a site cannot be asked for a file list.
export function referencedFromHtml(html, origin) {
  const refs = new Set();
  const re = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(re)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!v || v.startsWith('#') || /^(data|blob|mailto|tel|javascript):/i.test(v)) continue;
    let u;
    try { u = new URL(v, origin + '/'); } catch { continue; }
    if (u.origin !== origin) { refs.add(u.href); continue; }
    const p = decodeURIComponent(u.pathname).replace(/^\//, '');
    refs.add(p === '' ? 'index.html' : p);
  }
  return [...refs];
}

export async function observeSite(manifest, baseUrl, fetchImpl = fetch) {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('the site address must be https');
  }
  const origin = u.origin;
  const hashes = new Map();
  const errors = new Map();
  const extra = [];
  const known = new Set(manifest.files.map((f) => f.path));
  await Promise.all(manifest.files.map(async (f) => {
    // index.html is what a browser gets at "/".
    const url = origin + (f.path === 'index.html' ? '/' : '/' + f.path.split('/').map(encodeURIComponent).join('/'));
    try {
      const res = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (res.status !== 200) { hashes.set(f.path, null); errors.set(f.path, `HTTP ${res.status}`); return; }
      const bytes = Buffer.from(await res.arrayBuffer());
      hashes.set(f.path, sha256Hex(bytes));
      if (f.path.endsWith('.html')) {
        for (const r of referencedFromHtml(bytes.toString('utf8'), origin)) if (!known.has(r)) extra.push(r);
      }
    } catch (e) {
      hashes.set(f.path, null);
      errors.set(f.path, `network error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
  return { hashes, extra, errors };
}

// ── command line ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function usage(msg) {
  console.error(`${msg}\nusage: approve-release.mjs manifest <dir> --tag T --commit C --out FILE\n       approve-release.mjs compare --manifest FILE (--dir DIR | --url URL) [--out FILE]`);
  process.exit(2);
}

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  if (pos[0] === 'manifest') {
    if (!pos[1] || !opt.tag || !opt.commit || !opt.out) usage('missing argument');
    if (!/^[0-9a-f]{40}$/.test(opt.commit)) usage('--commit must be a full 40-character sha');
    const m = buildManifest(pos[1], { tag: opt.tag, commit: opt.commit });
    writeFileSync(opt.out, JSON.stringify(m, null, 2) + '\n');
    console.log(`${m.files.length} files hashed into ${opt.out}`);
    return 0;
  }
  if (pos[0] === 'compare') {
    if (!opt.manifest || (!opt.dir === !opt.url)) usage('give --manifest and exactly one of --dir / --url');
    const manifest = parseManifest(readFileSync(opt.manifest, 'utf8'));
    let observed;
    try {
      observed = opt.dir ? observeDir(opt.dir) : await observeSite(manifest, opt.url);
    } catch (e) {
      console.error(`::error::${e instanceof Error ? e.message : e}`);
      return 1;
    }
    const result = {
      schema: RESULT_SCHEMA,
      checked_at: new Date().toISOString(),
      site: opt.url ?? null,
      tag: manifest.tag,
      commit: manifest.commit,
      ...compareManifest(manifest, observed),
    };
    if (opt.out) writeFileSync(opt.out, JSON.stringify(result, null, 2) + '\n');
    console.log(`${result.status.toUpperCase()}: ${result.checked} files checked against ${manifest.tag}`);
    for (const c of result.changed) console.log(`::error::changed: ${c.path} (expected ${c.expected.slice(0, 12)}, got ${c.actual.slice(0, 12)})`);
    for (const m of result.missing) console.log(`::error::missing: ${m.path} (${m.reason})`);
    for (const e of result.extra) console.log(`::error::not in the release: ${e}`);
    return result.status === 'green' ? 0 : 1;
  }
  usage('unknown command');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
