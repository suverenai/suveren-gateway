/**
 * fetchAs / buildPinnedDispatcher / buildCapturingDispatcher (opt-in
 * pin-tls) — REAL TLS: a local HTTPS server with a real self-signed
 * certificate (generated via `openssl` in beforeAll — acceptable at this
 * unit level; the real end-to-end wire format is covered in hap-e2e), real
 * certificate swaps on the SAME host:port, and the actual Node TLS stack
 * doing the handshake. Nothing here mocks `checkServerIdentity` or the
 * certificate object itself.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAs, AsTlsMismatchError } from '../src/lib/as-tls-pin';

const certDir = mkdtempSync(join(tmpdir(), 'as-tls-pin-'));

interface Cert {
  certFile: string;
  keyFile: string;
}

/** A real self-signed cert/key pair via the system `openssl` — a SAN of
 *  127.0.0.1 so Node's default hostname check (checkServerIdentity) passes
 *  for a server bound to that address. */
function makeCert(name: string): Cert {
  const certFile = join(certDir, `${name}.cert.pem`);
  const keyFile = join(certDir, `${name}.key.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { certFile, keyFile };
}

let certA: Cert;
let certB: Cert; // a DIFFERENT keypair/cert — the "relay with its own cert" shape

beforeAll(() => {
  certA = makeCert('a');
  certB = makeCert('b');
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;
afterEach(() => {
  if (originalExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
});

/** Trust `cert`'s own file as the CA — the "a relay with its own cert
 *  trusted via --ca-file" shape from the task: a self-signed cert is
 *  perfectly valid TLS (trusted) but is NOT the pinned key. */
function trustViaCaFile(cert: Cert): void {
  process.env.NODE_EXTRA_CA_CERTS = cert.certFile;
}

function startHttps(cert: Cert, port: number): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer(
    { cert: readFileSync(cert.certFile), key: readFileSync(cert.keyFile) },
    (_req, res) => res.end('ok'),
  );
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const PORT = 18543;
const URL = `https://127.0.0.1:${PORT}/`;

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.(); stop = null;
});

describe('fetchAs — opt-in TLS pinning, real certificates', () => {
  it('captures a pin from a trusted certificate (first pairing)', async () => {
    trustViaCaFile(certA);
    const { close } = await startHttps(certA, PORT); stop = close;

    const { res, capturedSpkiHex } = await fetchAs(URL, undefined, { enabled: true, captureIfUnpinned: true });

    expect(res.status).toBe(200);
    expect(capturedSpkiHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the SAME certificate again under the pin — renewal-with-same-key shape', async () => {
    trustViaCaFile(certA);
    const { close: c1 } = await startHttps(certA, PORT);
    const { capturedSpkiHex } = await fetchAs(URL, undefined, { enabled: true, captureIfUnpinned: true });
    await c1();

    const { close: c2 } = await startHttps(certA, PORT); stop = c2;
    const { res } = await fetchAs(URL, undefined, { enabled: true, pinnedSpkiHex: capturedSpkiHex });
    expect(res.status).toBe(200);
  });

  it('REFUSAL: a relay with its own (CA-trusted) certificate on the same URL is refused under the pin', async () => {
    // Pin against certA.
    trustViaCaFile(certA);
    const { close: c1 } = await startHttps(certA, PORT);
    const { capturedSpkiHex } = await fetchAs(URL, undefined, { enabled: true, captureIfUnpinned: true });
    await c1();

    // Now something else answers the SAME url:port with certB — a totally
    // different keypair — and the operator has separately trusted certB via
    // --ca-file (so plain TLS validation alone would accept it: this is
    // exactly the gap pin-tls exists to close).
    trustViaCaFile(certB);
    const { close: c2 } = await startHttps(certB, PORT); stop = c2;

    await expect(fetchAs(URL, undefined, { enabled: true, pinnedSpkiHex: capturedSpkiHex }))
      .rejects.toBeInstanceOf(AsTlsMismatchError);
  });

  it('REFUSAL: refuses to connect at all when pin-tls is on but nothing is pinned yet and capture is not allowed', async () => {
    trustViaCaFile(certA);
    const { close } = await startHttps(certA, PORT); stop = close;

    await expect(fetchAs(URL, undefined, { enabled: true, captureIfUnpinned: false }))
      .rejects.toBeInstanceOf(AsTlsMismatchError);
  });

  it('pin-tls OFF: behaves exactly like a bare fetch — an untrusted self-signed cert is rejected by plain TLS, pinning never enters it', async () => {
    // No NODE_EXTRA_CA_CERTS set — this cert is trusted by nobody.
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { close } = await startHttps(certA, PORT); stop = close;

    await expect(fetchAs(URL, undefined, { enabled: false })).rejects.toThrow();
  });

  it('pin-tls OFF: identical to calling global fetch() directly — no pinning module involved at all (today\'s behavior)', async () => {
    // `--ca-file` trust for the DEFAULT fetch agent is applied once, at
    // process start, by bundle/server.js setting NODE_EXTRA_CA_CERTS before
    // re-exec'ing (see its own doc comment: Node reads that env var only at
    // startup) — not re-derivable by setting it live mid-test. What this
    // test proves instead is the actual invariant: with pinning off,
    // fetchAs delegates to the SAME bare `fetch` a caller would get without
    // this module at all, nothing more, nothing less — proven by getting
    // the exact same outcome (an untrusted self-signed cert, rejected) both
    // ways, byte-for-byte reason.
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { close } = await startHttps(certA, PORT); stop = close;

    const direct = await fetch(URL).catch((err: unknown) => err);
    const viaFetchAs = await fetchAs(URL, undefined, { enabled: false }).catch((err: unknown) => err);

    expect(direct).toBeInstanceOf(Error);
    expect(viaFetchAs).toBeInstanceOf(Error);
    expect((viaFetchAs as Error).message).toBe((direct as Error).message);
    expect((viaFetchAs as { cause?: { code?: string } }).cause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });
});
