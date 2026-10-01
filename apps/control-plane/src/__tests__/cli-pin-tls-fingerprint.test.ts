/**
 * `suveren-gateway config set pin-tls on` / `start --pin-tls` must require
 * `--expect-fingerprint` — the mandatory out-of-band check: without it,
 * turning pin-tls on would either trust whatever certificate the Authority
 * Server happens to present at the next sign-in (defeating the point of
 * pinning), or rely on a separate manual step a script could skip.
 *
 * Spawns the REAL shipped CLI (`bundle/bin/suveren-gateway.js`) as a child
 * process — not a reimplementation of its logic — same convention hap-e2e's
 * `cli()` helper uses. Refusals first (doc/engineering.md rule 4).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../../../bundle/bin/suveren-gateway.js');

const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP_A_NORM = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const FP_B = '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-pin-tls-fp-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function run(dataDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, SUVEREN_DATA_DIR: dataDir },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('suveren-gateway config set pin-tls on — requires --expect-fingerprint', () => {
  it('REFUSAL: no --expect-fingerprint at all — exit 1, prints the openssl how-to, writes nothing', async () => {
    const dataDir = tmp();
    const { status, stderr } = run(dataDir, ['config', 'set', 'pin-tls', 'on']);

    expect(status).toBe(1);
    expect(stderr).toContain('--expect-fingerprint is required');
    expect(stderr).toContain('openssl');
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false);
  });

  it('REFUSAL: a malformed fingerprint — exit 1, no config written', async () => {
    const dataDir = tmp();
    const { status, stderr } = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', 'not-a-fingerprint']);

    expect(status).toBe(1);
    expect(stderr).toContain('Invalid --expect-fingerprint');
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false);
  });

  it('REFUSAL: a stored (staged) fingerprint exists and the new one differs — exit 1, shows both, does not overwrite', async () => {
    const dataDir = tmp();
    const first = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_A]);
    expect(first.status).toBe(0);

    const second = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_B]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('does not match');
    expect(second.stderr.toUpperCase()).toContain('AABB:CCDD'); // the ORIGINAL, grouped
    // Unchanged — still the first value.
    expect(readJson(join(dataDir, 'config.json')).pinTlsExpectedFingerprint).toBe(FP_A_NORM);
  });

  it('REFUSAL: a real pairing exists with a DIFFERENT TLS pin already on file — exit 1, as-pairing.json untouched', async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, 'as-pairing.json'), JSON.stringify({
      asUrl: 'https://www.suveren.ai',
      publicKeyHex: 'deadbeef',
      pairedAt: '2024-01-01T00:00:00.000Z',
      tlsSpkiPinHex: FP_A_NORM,
    }));

    const { status, stderr } = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_B]);

    expect(status).toBe(1);
    expect(stderr).toContain('does not match');
    expect(readJson(join(dataDir, 'as-pairing.json')).tlsSpkiPinHex).toBe(FP_A_NORM);
  });

  it('accepts a correctly-formatted, colon-grouped, mixed-case fingerprint when nothing is on file yet — stages it (no pairing exists)', async () => {
    const dataDir = tmp();
    const { status, stdout } = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_A]);

    expect(status).toBe(0);
    expect(stdout).toContain('confirmed');
    const config = readJson(join(dataDir, 'config.json'));
    expect(config.pinTls).toBe(true);
    expect(config.pinTlsExpectedFingerprint).toBe(FP_A_NORM); // normalized: lowercase, no colons
    expect(existsSync(join(dataDir, 'as-pairing.json'))).toBe(false); // nothing to pin yet
  });

  it('re-running with the SAME fingerprint (different case/grouping) is idempotent — exit 0', async () => {
    const dataDir = tmp();
    run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_A]);
    const second = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_A_NORM.toUpperCase()]);

    expect(second.status).toBe(0);
    expect(readJson(join(dataDir, 'config.json')).pinTlsExpectedFingerprint).toBe(FP_A_NORM);
  });

  it('a real pairing exists with NO TLS pin yet — writes the confirmed fingerprint directly into as-pairing.json, not staged', async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, 'as-pairing.json'), JSON.stringify({
      asUrl: 'https://www.suveren.ai',
      publicKeyHex: 'deadbeef',
      pairedAt: '2024-01-01T00:00:00.000Z',
    }));

    const { status } = run(dataDir, ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', FP_A]);

    expect(status).toBe(0);
    expect(readJson(join(dataDir, 'as-pairing.json')).tlsSpkiPinHex).toBe(FP_A_NORM);
    // Nothing staged in config.json — it was committed straight away.
    const config = readJson(join(dataDir, 'config.json'));
    expect(config.pinTlsExpectedFingerprint).toBeUndefined();
    expect(config.pinTls).toBe(true);
  });

  it('config set pin-tls off never requires a fingerprint', async () => {
    const dataDir = tmp();
    const { status } = run(dataDir, ['config', 'set', 'pin-tls', 'off']);
    expect(status).toBe(0);
    expect(readJson(join(dataDir, 'config.json')).pinTls).toBe(false);
  });
});

describe('suveren-gateway start --pin-tls — same mandatory check, before anything else', () => {
  it('REFUSAL: --pin-tls with no --expect-fingerprint — exit 1, nothing written, no process left behind', async () => {
    const dataDir = tmp();
    const { status, stderr } = run(dataDir, ['start', '--pin-tls']);

    expect(status).toBe(1);
    expect(stderr).toContain('--expect-fingerprint is required');
    // Refused before even creating the data directory.
    expect(existsSync(dataDir) && existsSync(join(dataDir, 'config.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'gateway.pid'))).toBe(false);
  });

  it('REFUSAL: --pin-tls with a malformed --expect-fingerprint — exit 1, nothing written', async () => {
    const dataDir = tmp();
    const { status } = run(dataDir, ['start', '--pin-tls', '--expect-fingerprint', 'nope']);

    expect(status).toBe(1);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false);
  });
});
