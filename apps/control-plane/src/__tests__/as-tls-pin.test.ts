/**
 * fetchAs / buildPinnedDispatcher / buildCapturingDispatcher (opt-in
 * pin-tls) — REAL TLS: a local HTTPS server with a real self-signed
 * certificate (generated via `openssl` in beforeAll — acceptable at this
 * unit level; the real end-to-end wire format is covered in hap-e2e), real
 * certificate swaps on the SAME host:port, and the actual Node TLS stack
 * doing the handshake. Nothing here mocks `checkServerIdentity` or the
 * certificate object itself.
 *
 * Every server listens on port 0 (OS-assigned) — this suite runs alongside
 * the mcp-server workspace's own copy under `pnpm -r test`, and a FIXED
 * port here collided with one there (EADDRINUSE, CI macOS). "Same URL"
 * cert-swap tests capture the first server's assigned port and explicitly
 * rebind the SECOND server to that exact number after closing the first —
 * safe because both happen sequentially within one test, never concurrently
 * with anything else that might grab it in between.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAs, AsTlsMismatchError } from '../lib/as-tls-pin';

const certDir = mkdtempSync(join(tmpdir(), 'as-tls-pin-'));

interface Cert {
  certFile: string;
  keyFile: string;
}

/** A real self-signed cert/key pair via the system `openssl`. */
function makeCert(name: string, subjectAltName = 'IP:127.0.0.1'): Cert {
  const certFile = join(certDir, `${name}.cert.pem`);
  const keyFile = join(certDir, `${name}.key.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', `subjectAltName=${subjectAltName}`,
  ], { stdio: 'ignore' });
  return { certFile, keyFile };
}

let certA: Cert;
let certB: Cert; // a DIFFERENT keypair/cert — the "relay with its own cert" shape
let certWrongHost: Cert; // valid/trusted, but for a DIFFERENT hostname

beforeAll(() => {
  certA = makeCert('a');
  certB = makeCert('b');
  certWrongHost = makeCert('wronghost', 'DNS:not-this-host.example');
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

/** @param port 0 (default) lets the OS assign a free port — read back via
 *  the resolved `port`/`url`. Pass an explicit port to rebind the SAME
 *  number a prior (now-closed) server in this test was assigned, for the
 *  "same URL, different certificate" shape. */
function startHttps(cert: Cert, port = 0): Promise<{ close: () => Promise<void>; port: number; url: string }> {
  const server: Server = createServer(
    { cert: readFileSync(cert.certFile), key: readFileSync(cert.keyFile) },
    (_req, res) => res.end('ok'),
  );
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const assigned = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        // Drop open keep-alive sockets too: server.close() alone waits for them, and
        // a test that rebinds the same port (the relay case) would race them.
        close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
        port: assigned,
        url: `https://127.0.0.1:${assigned}/`,
      });
    });
  });
}

/** A free TCP port, momentarily bound then released — for the "nothing is
 *  listening here" outage test, where "nothing" must still mean a port no
 *  concurrent test process could be using right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.(); stop = null;
});

describe('fetchAs — opt-in TLS pinning, real certificates', () => {
  it('captures a pin from a trusted certificate (first pairing, pin-tls already on)', async () => {
    trustViaCaFile(certA);
    const { close, url } = await startHttps(certA); stop = close;

    const { res, capturedSpkiHex } = await fetchAs(url, undefined, { enforce: true, capture: true });

    expect(res.status).toBe(200);
    expect(capturedSpkiHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the SAME certificate again under the pin — renewal-with-same-key shape', async () => {
    trustViaCaFile(certA);
    const { close: c1, port, url } = await startHttps(certA);
    const { capturedSpkiHex } = await fetchAs(url, undefined, { enforce: true, capture: true });
    await c1();

    const { close: c2 } = await startHttps(certA, port); stop = c2;
    const { res } = await fetchAs(url, undefined, { enforce: true, pinnedSpkiHex: capturedSpkiHex });
    expect(res.status).toBe(200);
  });

  it('REFUSAL: a relay with its own (CA-trusted) certificate on the same URL is refused under the pin', async () => {
    // Pin against certA.
    trustViaCaFile(certA);
    const { close: c1, port, url } = await startHttps(certA);
    const { capturedSpkiHex } = await fetchAs(url, undefined, { enforce: true, capture: true });
    await c1();

    // Now something else answers the SAME url:port with certB — a totally
    // different keypair — and the operator has separately trusted certB via
    // --ca-file (so plain TLS validation alone would accept it: this is
    // exactly the gap pin-tls exists to close).
    trustViaCaFile(certB);
    const { close: c2 } = await startHttps(certB, port); stop = c2;

    await expect(fetchAs(url, undefined, { enforce: true, pinnedSpkiHex: capturedSpkiHex }))
      .rejects.toBeInstanceOf(AsTlsMismatchError);
  });

  it('REFUSAL: an ordinary (non-capturing) call refuses to connect at all when nothing is pinned yet — re-pairing required', async () => {
    trustViaCaFile(certA);
    const { close, url } = await startHttps(certA); stop = close;

    await expect(fetchAs(url, undefined, { enforce: true })).rejects.toBeInstanceOf(AsTlsMismatchError);
  });

  it('REFUSAL (hostname): a certificate valid for a DIFFERENT host is refused under enforcement, same as a pin mismatch', async () => {
    // Trust it via CA so only the HOSTNAME check (not plain cert validity)
    // is what fails — proving "pin OR hostname" (finding 3) both count as
    // checkServerIdentity rejections, not just an SPKI mismatch.
    trustViaCaFile(certWrongHost);
    const { close, url } = await startHttps(certWrongHost); stop = close;

    await expect(fetchAs(url, undefined, { enforce: true, capture: true }))
      .rejects.toBeInstanceOf(AsTlsMismatchError);
  });

  it('pin-tls OFF: behaves exactly like a bare fetch — an untrusted self-signed cert is rejected by plain TLS, pinning never enters it', async () => {
    // No NODE_EXTRA_CA_CERTS set — this cert is trusted by nobody.
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { close, url } = await startHttps(certA); stop = close;

    await expect(fetchAs(url, undefined, { enforce: false })).rejects.toThrow();
  });

  it('pin-tls OFF: delegates to the SAME bare fetch() a caller would get without this module — SAME underlying failure, enriched message', async () => {
    // `--ca-file` trust for the DEFAULT fetch agent is applied once, at
    // process start, by bundle/server.js setting NODE_EXTRA_CA_CERTS before
    // re-exec'ing (see its own doc comment: Node reads that env var only at
    // startup) — not re-derivable by setting it live mid-test.
    //
    // The two calls no longer produce a BYTE-IDENTICAL message (they did
    // before the corporate-proxy work added `rethrowWithIssuerHint`): an
    // untrusted-issuer failure — the exact shape a TLS-inspecting proxy
    // produces — is deliberately rewritten with a message naming the cause
    // and pointing at `--ca-file`/`config set ca-file`, everywhere fetchAs is
    // the caller's only path to the AS, not only when a proxy is configured.
    // What must still hold: it is the SAME underlying TLS failure (same
    // `cause.code`), not a different, misdiagnosed one.
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { close, url } = await startHttps(certA); stop = close;

    const direct = await fetch(url).catch((err: unknown) => err);
    const viaFetchAs = await fetchAs(url, undefined, { enforce: false }).catch((err: unknown) => err);

    expect(direct).toBeInstanceOf(Error);
    expect(viaFetchAs).toBeInstanceOf(Error);
    expect((direct as Error).message).toBe('fetch failed');
    expect((viaFetchAs as Error).message).toMatch(/not trusted.*config set ca-file/is);
    // `.cause` on fetchAs's rethrown error is the ORIGINAL "fetch failed"
    // error — same message as calling fetch() directly — not a new one.
    expect(((viaFetchAs as { cause?: unknown }).cause as Error)?.message).toBe((direct as Error).message);
    const directCause = (direct as { cause?: { code?: string } }).cause;
    expect(directCause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });
});

describe('fetchAs — capture at every pairing, independent of enforcement (design: pin-tls can be turned on later)', () => {
  it('pin-tls OFF + capture: ALWAYS captures/refreshes the live certificate\'s SPKI, never refuses, even with a stale pin on file', async () => {
    trustViaCaFile(certA);
    const { close, url } = await startHttps(certA); stop = close;

    // A completely unrelated "stale" pin on file — pin-tls off means this
    // is never enforced, and a capturing call must overwrite it, not refuse.
    const { res, capturedSpkiHex } = await fetchAs(url, undefined, {
      enforce: false,
      pinnedSpkiHex: '0'.repeat(64),
      capture: true,
    });

    expect(res.status).toBe(200);
    expect(capturedSpkiHex).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedSpkiHex).not.toBe('0'.repeat(64));
  });

  it('pin-tls ON + an EXISTING pin is enforced, never silently replaced, even though capture is requested', async () => {
    trustViaCaFile(certA);
    const { close: c1, port, url } = await startHttps(certA);
    const { capturedSpkiHex: realHex } = await fetchAs(url, undefined, { enforce: true, capture: true });
    await c1();

    trustViaCaFile(certB);
    const { close: c2 } = await startHttps(certB, port); stop = c2;

    // `capture: true` here models the challenge call itself finding a pin
    // ALREADY on file — it must enforce, not quietly adopt certB's key.
    await expect(fetchAs(url, undefined, { enforce: true, pinnedSpkiHex: realHex, capture: true }))
      .rejects.toBeInstanceOf(AsTlsMismatchError);
  });
});

describe('fetchAs — an Authority Server outage is an outage, not a pin mismatch (finding 3)', () => {
  it('a refused connection (nothing listening) under an enforced pin is NOT reported as AsTlsMismatchError', async () => {
    // Nothing is listening on this port at all.
    const port = await freePort();
    const pinning = { enforce: true, pinnedSpkiHex: 'a'.repeat(64) };
    const err = await fetchAs(`https://127.0.0.1:${port}/`, undefined, pinning).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AsTlsMismatchError);
  });

  it('an untrusted certificate chain (no matching CA at all) under an enforced pin is NOT reported as AsTlsMismatchError', async () => {
    // certA is listening but NOT trusted (no NODE_EXTRA_CA_CERTS) — this is
    // an ordinary TLS trust failure, not our checkServerIdentity rejecting
    // anything (checkServerIdentity is never reached: Node refuses the
    // chain before that hook runs).
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { close, url } = await startHttps(certA); stop = close;

    const pinning = { enforce: true, pinnedSpkiHex: 'a'.repeat(64) };
    const err = await fetchAs(url, undefined, pinning).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AsTlsMismatchError);
  });
});
