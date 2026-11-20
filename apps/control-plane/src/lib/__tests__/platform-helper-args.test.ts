import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateHelper, HELPER_EXECUTABLE } from '../platform-helper';

/** A Suveren.app folder with an executable and a manifest beside it, enough for locateHelper to find it. */
function fakeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helper-args-'));
  const app = join(dir, 'Suveren.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'suveren-unlock-helper'), '');
  writeFileSync(join(dir, 'helper-manifest.json'), JSON.stringify({ v: 1, files: { [HELPER_EXECUTABLE]: '0'.repeat(64) } }));
  return app;
}

const at = (env: NodeJS.ProcessEnv) => locateHelper({ here: '/nowhere', env, platform: 'darwin', arch: 'arm64', execPath: process.execPath, scriptPath: __filename });

describe('the helper\'s debug arguments (tests only)', () => {
  it('a deliberately chosen helper gets the allowed debug arguments', () => {
    const r = at({ SUVEREN_HELPER_APP: fakeApp(), SUVEREN_HELPER_ARGS: '--backend software --allow-any-caller' });
    expect('spec' in r && r.spec.args).toEqual(['serve', '--backend', 'software', '--allow-any-caller']);
  });

  it('anything else in the variable is dropped', () => {
    const r = at({ SUVEREN_HELPER_APP: fakeApp(), SUVEREN_HELPER_ARGS: '--allowed-callers /tmp/x --backend software rm -rf /' });
    expect('spec' in r && r.spec.args).toEqual(['serve', '--backend', 'software']);
    const half = at({ SUVEREN_HELPER_APP: fakeApp(), SUVEREN_HELPER_ARGS: '--backend secure-enclave-off' });
    expect('spec' in half && half.spec.args).toEqual(['serve']);
  });

  it('without a chosen helper the variable is ignored: the installed helper only ever gets `serve`', () => {
    const r = at({ SUVEREN_HELPER_ARGS: '--backend software --allow-any-caller' });
    expect('unavailable' in r || ('spec' in r && r.spec.args)).toBeTruthy();
    if ('spec' in r) expect(r.spec.args).toEqual(['serve']);
  });
});
