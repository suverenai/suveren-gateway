#!/usr/bin/env node
// Serves a built phone-app bundle with exactly the production headers (hosting/headers.mjs), for checking a
// release bundle before it is put on the real host. Not a production server: plain HTTP on 127.0.0.1 only
// (HSTS is sent anyway so the header list can be checked as the host sends it).
//   node scripts/serve-release.mjs <bundle dir> <port> <AS origin>
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { MIME, cacheControlFor, resolveServedPath, securityHeaders } from '../hosting/headers.mjs';

const dir = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 3480);
const asOrigin = process.argv[4] ?? 'https://www.suveren.ai';
const base = securityHeaders(asOrigin);

const isFile = (p) => {
  const f = normalize(join(dir, p));
  return (f === dir || f.startsWith(dir + '/')) && existsSync(f) && statSync(f).isFile();
};

createServer((req, res) => {
  let path;
  try { path = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
  const served = resolveServedPath(path, isFile);
  if (!served) { res.setHeader('Cache-Control', 'no-store'); res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.setHeader('Cache-Control', cacheControlFor(served));
  res.writeHead(200, { 'Content-Type': MIME[extname(served)] ?? 'application/octet-stream' });
  res.end(readFileSync(join(dir, served)));
}).listen(port, '127.0.0.1', () => console.log(`phone app release check: http://127.0.0.1:${port} (${dir}, AS ${asOrigin})`));
