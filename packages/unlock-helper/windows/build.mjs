#!/usr/bin/env node
// Builds the Windows helper for x64 and arm64 and writes the hashes the gateway checks before it starts it
// (DESIGN.md sections 4, 8 and 10). Runs on any system with Go 1.24 or later (cross-compiles; no C compiler).
//   node build.mjs [output folder]          default: ./dist   (release: no software keys, no test switches)
//   CONFIG=debug node build.mjs dist-debug  the DEBUG helper, for tests only; never shipped
// Makes <out>/windows-<arch>/suveren-unlock-helper.exe and <out>/helper-manifest-windows-<arch>.json.
//
// NOT SIGNED. A shipped .exe needs an Authenticode signature (the gateway's Windows code-signing certificate),
// and the hashes must be taken AFTER signing, because signing changes the file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, 'dist'));
const debug = process.env.CONFIG === 'debug';
const go = process.env.GO ?? 'go';

rmSync(out, { recursive: true, force: true });
for (const [arch, goarch] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
  const dir = join(out, `windows-${arch}`);
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'suveren-unlock-helper.exe');
  execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w -buildid=', ...(debug ? ['-tags', 'debug'] : []), '-o', exe, './cmd/suveren-unlock-helper'], {
    cwd: here, stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: goarch, CGO_ENABLED: '0' },
  });
  const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
  writeFileSync(join(out, `helper-manifest-windows-${arch}.json`), JSON.stringify({ v: 1, files: { 'suveren-unlock-helper.exe': sha } }, null, 2) + '\n');
  console.log(`built ${exe} (${debug ? 'DEBUG' : 'release'})`);
}
