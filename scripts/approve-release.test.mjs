// node --test scripts/approve-release.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildManifest, compareManifest, observeDir, observeSite, parseManifest,
  referencedFromHtml, sha256Hex, MANIFEST_SCHEMA,
} from './approve-release.mjs';

const COMMIT = 'a'.repeat(40);
const CLI = fileURLToPath(new URL('./approve-release.mjs', import.meta.url));

const FILES = {
  'index.html': '<!doctype html><script type="module" src="/assets/app-abc.js"></script><link rel="stylesheet" href="/assets/app-abc.css">',
  'assets/app-abc.js': 'console.log("app")',
  'assets/app-abc.css': 'body{margin:0}',
  'sw.js': 'self.addEventListener("fetch",()=>{})',
};

function makeDir(files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'approve-rel-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, ...p.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

// A real HTTP server standing in for the live site.
async function serve(files) {
  const server = createServer((req, res) => {
    const p = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1));
    if (p in files) { res.writeHead(200); res.end(files[p]); } else { res.writeHead(404); res.end('no'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const manifestOf = (files = FILES) => buildManifest(makeDir(files), { tag: 'approve-v0.0.1', commit: COMMIT });

test('manifest: sorted, with sha256 and size, no timestamp', () => {
  const m = manifestOf();
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.deepEqual(m.files.map((f) => f.path), ['assets/app-abc.css', 'assets/app-abc.js', 'index.html', 'sw.js']);
  const js = m.files.find((f) => f.path === 'assets/app-abc.js');
  assert.equal(js.sha256, sha256Hex(Buffer.from(FILES['assets/app-abc.js'])));
  assert.equal(js.size, FILES['assets/app-abc.js'].length);
  assert.equal(JSON.stringify(manifestOf()), JSON.stringify(manifestOf()), 'same files, same manifest');
});

test('manifest: an empty directory and a symlink are refused', () => {
  assert.throws(() => buildManifest(makeDir({}), { tag: 't', commit: COMMIT }), /no files/);
  const dir = makeDir();
  symlinkSync('/etc/hosts', join(dir, 'link.txt'));
  assert.throws(() => buildManifest(dir, { tag: 't', commit: COMMIT }), /not a regular file/);
});

test('parseManifest refuses unsafe paths, bad hashes, duplicates, other schemas', () => {
  const good = manifestOf();
  assert.doesNotThrow(() => parseManifest(JSON.stringify(good)));
  const withFile = (f) => JSON.stringify({ ...good, files: [f] });
  const h = 'b'.repeat(64);
  for (const p of ['../x', '/etc/passwd', 'a//b', 'a\\b', './a', '']) {
    assert.throws(() => parseManifest(withFile({ path: p, sha256: h })), /unsafe path/, p);
  }
  assert.throws(() => parseManifest(withFile({ path: 'a', sha256: 'zz' })), /bad sha256/);
  assert.throws(() => parseManifest(JSON.stringify({ ...good, files: [good.files[0], good.files[0]] })), /duplicate/);
  assert.throws(() => parseManifest(JSON.stringify({ ...good, schema: 'other' })), /schema/);
});

test('compare directory: identical is green', () => {
  const dir = makeDir();
  const m = buildManifest(dir, { tag: 't', commit: COMMIT });
  const r = compareManifest(m, observeDir(dir));
  assert.equal(r.status, 'green');
  assert.equal(r.checked, 4);
});

test('compare directory: one changed byte is red, restored is green', () => {
  const m = manifestOf();
  const changed = makeDir({ ...FILES, 'assets/app-abc.js': 'console.log("apq")' });
  const red = compareManifest(m, observeDir(changed));
  assert.equal(red.status, 'red');
  assert.deepEqual(red.changed.map((c) => c.path), ['assets/app-abc.js']);
  const restored = makeDir();
  assert.equal(compareManifest(m, observeDir(restored)).status, 'green');
});

test('compare directory: a missing file and an extra file are red, each named', () => {
  const m = manifestOf();
  const { 'sw.js': _gone, ...fewer } = FILES;
  const missing = compareManifest(m, observeDir(makeDir(fewer)));
  assert.equal(missing.status, 'red');
  assert.deepEqual(missing.missing.map((x) => x.path), ['sw.js']);
  const extra = compareManifest(m, observeDir(makeDir({ ...FILES, 'evil.js': 'x' })));
  assert.equal(extra.status, 'red');
  assert.deepEqual(extra.extra, ['evil.js']);
});

test('referencedFromHtml: local files, external origins, ignores anchors and data urls', () => {
  const refs = referencedFromHtml(
    '<a href="#x"><img src="data:image/png;base64,AA"><script src="/a.js"></script><link href=\'b.css\'><script src="https://cdn.example/x.js"></script>',
    'https://approve.example',
  );
  assert.deepEqual(refs.sort(), ['a.js', 'b.css', 'https://cdn.example/x.js']);
});

test('compare live site over HTTP: green, one byte changed is red, restored is green', async () => {
  const m = manifestOf();
  const live = { ...FILES };
  const site = await serve(live);
  try {
    assert.equal(compareManifest(m, await observeSite(m, site.url)).status, 'green');

    live['assets/app-abc.js'] = 'console.log("apq")'; // one byte
    const red = compareManifest(m, await observeSite(m, site.url));
    assert.equal(red.status, 'red');
    assert.deepEqual(red.changed.map((c) => c.path), ['assets/app-abc.js']);

    live['assets/app-abc.js'] = FILES['assets/app-abc.js']; // restored
    assert.equal(compareManifest(m, await observeSite(m, site.url)).status, 'green');
  } finally { await site.close(); }
});

test('compare live site: a missing file (404) is red with its reason', async () => {
  const m = manifestOf();
  const { 'sw.js': _gone, ...fewer } = FILES;
  const site = await serve(fewer);
  try {
    const r = compareManifest(m, await observeSite(m, site.url));
    assert.equal(r.status, 'red');
    assert.deepEqual(r.missing, [{ path: 'sw.js', reason: 'HTTP 404' }]);
  } finally { await site.close(); }
});

test('compare live site: a file the page loads that the release does not list is red', async () => {
  const m = manifestOf();
  const site = await serve({ ...FILES, 'index.html': FILES['index.html'] + '<script src="/injected.js"></script><script src="https://evil.example/x.js"></script>' });
  try {
    const r = compareManifest(m, await observeSite(m, site.url));
    assert.equal(r.status, 'red');
    assert.deepEqual(r.extra.sort(), ['https://evil.example/x.js', 'injected.js']);
    assert.equal(r.changed[0].path, 'index.html'); // and the page itself changed
  } finally { await site.close(); }
});

test('compare live site: an unreachable site is red, not silently green', async () => {
  const m = manifestOf();
  const site = await serve(FILES);
  await site.close();
  const r = compareManifest(m, await observeSite(m, site.url));
  assert.equal(r.status, 'red');
  assert.equal(r.missing.length, 4);
});

test('compare live site: a redirect is not followed and counts as missing', async () => {
  const m = manifestOf();
  const server = createServer((req, res) => { res.writeHead(302, { location: 'https://elsewhere.example/' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = compareManifest(m, await observeSite(m, `http://127.0.0.1:${server.address().port}`));
    assert.equal(r.status, 'red');
    assert.equal(r.missing[0].reason, 'HTTP 302');
  } finally { await new Promise((r) => server.close(r)); }
});

test('observeSite refuses a plain http address that is not local', async () => {
  await assert.rejects(observeSite(manifestOf(), 'http://approve.example'), /https/);
});

test('command line: manifest, then compare exits 0, then 1 after a changed byte, then 0 again', () => {
  const dir = makeDir();
  const out = mkdtempSync(join(tmpdir(), 'approve-cli-'));
  const mf = join(out, 'manifest.json');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

  assert.equal(run('manifest', dir, '--tag', 'approve-v0.0.1', '--commit', COMMIT, '--out', mf).status, 0);
  assert.equal(run('compare', '--manifest', mf, '--dir', dir).status, 0);

  const target = join(dir, 'assets', 'app-abc.js');
  writeFileSync(target, 'console.log("apq")');
  const red = run('compare', '--manifest', mf, '--dir', dir, '--out', join(out, 'result.json'));
  assert.equal(red.status, 1);
  assert.match(red.stdout, /changed: assets\/app-abc\.js/);

  writeFileSync(target, FILES['assets/app-abc.js']);
  assert.equal(run('compare', '--manifest', mf, '--dir', dir).status, 0);

  assert.equal(run('manifest', dir, '--tag', 't', '--commit', 'short', '--out', mf).status, 2);
  assert.equal(run('compare', '--manifest', mf).status, 2);
  rmSync(out, { recursive: true });
});
