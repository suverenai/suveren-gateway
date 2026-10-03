/**
 * Corporate HTTP(S) proxy support — REAL network: a real CONNECT proxy (a
 * plain, non-inspecting TCP relay) and a real TLS-INSPECTING proxy (its own
 * "company root CA", generated via `openssl`, re-signing the leaf the AS
 * stand-in presents) built from `node:net`/`node:tls` directly — the same
 * "real certs, real sockets, nothing mocked" standard as as-tls-pin.test.ts,
 * extended with a real proxy in front.
 *
 * What this proves, per apps the task asked for:
 *   1. direct works
 *   2. through a plain (non-inspecting) proxy works
 *   3. through a TLS-inspecting proxy FAILS without --ca-file, with the new
 *      clear "untrusted issuer" message pointing at --ca-file
 *   4. through a TLS-inspecting proxy WORKS with --ca-file (the company root)
 *   5. pin-tls ON + an inspecting proxy → refused, with a message naming the
 *      TLS-inspecting-proxy possibility (not just "re-pair")
 *   6. CONTROL CHECK: with the proxy-selection wiring stubbed out, the same
 *      "through proxy" call from (2) now fails — proving (2) actually
 *      depends on the wiring under test, not an accidental direct route.
 *
 * The target hostname (`fake-as.proxytest.invalid`) deliberately does not
 * resolve via real DNS — the AS stand-in's certificate carries it as a SAN,
 * but the plain/inspecting proxies route STRAIGHT to the stand-in's real
 * 127.0.0.1 port regardless of the requested host. A direct (unproxied)
 * connection attempt to that hostname can therefore only ever fail
 * (ENOTFOUND/EAI_AGAIN) — which is exactly what makes "it worked" proof that
 * the proxy path, not some other route, was actually used.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAs, AsTlsMismatchError } from '../src/lib/as-tls-pin';

const HOST = 'fake-as.proxytest.invalid'; // never resolves via real DNS
const certDir = mkdtempSync(join(tmpdir(), 'corporate-proxy-'));

interface Cert { certFile: string; keyFile: string }

function makeSelfSignedCert(name: string): Cert {
  const certFile = join(certDir, `${name}.cert.pem`);
  const keyFile = join(certDir, `${name}.key.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST},IP:127.0.0.1`,
  ], { stdio: 'ignore' });
  return { certFile, keyFile };
}

/** A self-signed "company root CA" and a leaf for HOST signed by it — the
 *  exact shape a TLS-inspecting proxy presents: a certificate chain that is
 *  cryptographically valid, for the right hostname, but issued by a CA
 *  nothing trusts unless told to. */
function makeCompanyCaAndLeaf(): { root: Cert; leaf: Cert } {
  const rootKey = join(certDir, 'company-root.key.pem');
  const rootCert = join(certDir, 'company-root.cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', rootKey, '-out', rootCert,
    '-days', '1', '-subj', '/CN=Test Company Root CA',
  ], { stdio: 'ignore' });

  const leafKey = join(certDir, 'inspected-leaf.key.pem');
  const leafCsr = join(certDir, 'inspected-leaf.csr.pem');
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', leafKey, '-out', leafCsr,
    '-subj', `/CN=${HOST}`,
  ], { stdio: 'ignore' });

  const extFile = join(certDir, 'inspected-leaf.ext.cnf');
  require('node:fs').writeFileSync(extFile, `subjectAltName=DNS:${HOST}\n`);
  const leafCert = join(certDir, 'inspected-leaf.cert.pem');
  execFileSync('openssl', [
    'x509', '-req', '-in', leafCsr,
    '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial',
    '-out', leafCert, '-days', '1', '-extfile', extFile,
  ], { stdio: 'ignore' });

  return { root: { certFile: rootCert, keyFile: rootKey }, leaf: { certFile: leafCert, keyFile: leafKey } };
}

let asCert: Cert;
let company: { root: Cert; leaf: Cert };

beforeAll(() => {
  asCert = makeSelfSignedCert('as-backend');
  company = makeCompanyCaAndLeaf();
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** The real AS stand-in: a plain HTTPS server answering every request `ok`. */
function startAsBackend(cert: Cert): Promise<{ close: () => Promise<void>; port: number }> {
  const server: HttpsServer = createHttpsServer(
    { cert: readFileSync(cert.certFile), key: readFileSync(cert.keyFile) },
    (_req, res) => res.end('ok'),
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
        port,
      });
    });
  });
}

/** Parses the single `CONNECT host:port HTTP/1.1\r\n...\r\n\r\n` request off
 *  `socket`, acks `200 Connection Established`, and resolves. The host/port
 *  the CLIENT asked for is ignored by both proxies below — they always
 *  connect to the ONE real backend this test suite cares about — which is
 *  what lets `HOST` be a never-resolves-via-DNS hostname while still
 *  exercising a real CONNECT handshake end to end. */
function readConnectRequest(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\r\n\r\n') === -1) return;
      socket.removeListener('data', onData);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      resolve();
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** A plain (non-inspecting) CONNECT proxy: once tunnelled, it is a dumb byte
 *  pipe between the client and `backendPort` — TLS passes through
 *  untouched, so the client sees the AS stand-in's REAL certificate. */
function startPlainProxy(backendPort: number): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createNetServer((clientSocket) => {
    readConnectRequest(clientSocket).then(() => {
      const upstream = netConnect(backendPort, '127.0.0.1');
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      const cleanup = () => { clientSocket.destroy(); upstream.destroy(); };
      clientSocket.on('error', cleanup);
      upstream.on('error', cleanup);
    }).catch(() => clientSocket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ close: () => new Promise<void>((r) => server.close(() => r())), port });
    });
  });
}

/** A TLS-INSPECTING proxy: terminates the client's TLS handshake itself,
 *  presenting `company.leaf` (signed by `company.root`, NOT the AS's real
 *  certificate) instead of passing the real one through — exactly what a
 *  corporate TLS-inspection box does. It then opens its OWN (separate) TLS
 *  connection to the real AS backend (trusting it unconditionally — this
 *  process plays "the inspecting box", not the client under test) and
 *  shuttles decrypted bytes between the two independent TLS sessions. */
function startInspectingProxy(backendPort: number): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createNetServer((clientSocket) => {
    readConnectRequest(clientSocket).then(() => {
      const clientTls = new TLSSocket(clientSocket, {
        isServer: true,
        cert: readFileSync(company.leaf.certFile),
        key: readFileSync(company.leaf.keyFile),
      });
      clientTls.on('error', () => clientTls.destroy());
      clientTls.once('secure', () => {
        const backendTls = tlsConnect({ host: '127.0.0.1', port: backendPort, rejectUnauthorized: false });
        backendTls.once('secureConnect', () => {
          clientTls.pipe(backendTls);
          backendTls.pipe(clientTls);
        });
        const cleanup = () => { clientTls.destroy(); backendTls.destroy(); };
        clientTls.on('error', cleanup);
        backendTls.on('error', cleanup);
      });
    }).catch(() => clientSocket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ close: () => new Promise<void>((r) => server.close(() => r())), port });
    });
  });
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('corporate HTTP(S) proxy — real network', () => {
  it('direct: works when the AS certificate is trusted', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    process.env.NODE_EXTRA_CA_CERTS = asCert.certFile;

    // `capture: true` (not a bare unpinned call) purely so this test can
    // mutate NODE_EXTRA_CA_CERTS at RUNTIME, inside the same already-running
    // test process: `capture`/`enforce` calls build their own dispatcher via
    // `buildTlsDispatcher`, which re-reads `effectiveCa()` on every call —
    // the bare unpinned branch (a plain global `fetch`) only ever sees
    // NODE_EXTRA_CA_CERTS the way Node reads it, once, at process start,
    // same as production's bundle/server.js re-exec relies on — nothing
    // about THIS change touches that path's existing CA handling, so it is
    // not re-tested here. `127.0.0.1`, not `HOST`, because this is the
    // no-proxy baseline — `HOST` only resolves via the proxies below.
    const { res } = await fetchAs(`https://127.0.0.1:${backend.port}/`, undefined, { enforce: false, capture: true });
    expect(res.status).toBe(200);
  });

  it('through a plain (non-inspecting) proxy: works, carries the real AS certificate through untouched', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startPlainProxy(backend.port); cleanups.push(proxy.close);
    process.env.NODE_EXTRA_CA_CERTS = asCert.certFile;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    const { res } = await fetchAs(`https://${HOST}:${backend.port}/`, undefined, { enforce: false });
    expect(res.status).toBe(200);
  });

  it('through a TLS-inspecting proxy, WITHOUT --ca-file: fails with the clear "untrusted issuer" message pointing at --ca-file', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startInspectingProxy(backend.port); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    // Deliberately NOT trusting company.root here — this is the "nobody has
    // run --ca-file yet" case.

    await expect(fetchAs(`https://${HOST}:${backend.port}/`, undefined, { enforce: false }))
      .rejects.toThrow(/untrusted|config set ca-file|--ca-file/i);
  });

  it('through a TLS-inspecting proxy, WITH --ca-file (the company root): works', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startInspectingProxy(backend.port); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NODE_EXTRA_CA_CERTS = company.root.certFile; // `--ca-file <company-root>`

    const { res } = await fetchAs(`https://${HOST}:${backend.port}/`, undefined, { enforce: false });
    expect(res.status).toBe(200);
  });

  it('pin-tls ON + a TLS-inspecting proxy, even WITH --ca-file: refused, naming the TLS-inspecting-proxy possibility', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);

    // Capture the REAL pin directly (unproxied, via 127.0.0.1 — no proxy is
    // configured yet) first — this is what an operator's earlier, legitimate
    // sign-in would have captured.
    process.env.NODE_EXTRA_CA_CERTS = asCert.certFile;
    const { capturedSpkiHex } = await fetchAs(`https://127.0.0.1:${backend.port}/`, undefined, { enforce: true, capture: true });
    expect(capturedSpkiHex).toMatch(/^[0-9a-f]{64}$/);

    // Now put a TLS-inspecting proxy in the path, WITH the company root
    // trusted (so this is not merely the "untrusted issuer" case above) —
    // the pin must still refuse, because the inspecting proxy's leaf key
    // differs from the real AS's.
    const proxy = await startInspectingProxy(backend.port); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NODE_EXTRA_CA_CERTS = company.root.certFile;

    const err = await fetchAs(`https://${HOST}:${backend.port}/`, undefined, {
      enforce: true,
      pinnedSpkiHex: capturedSpkiHex,
    }).then(
      () => { throw new Error('expected fetchAs to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AsTlsMismatchError);
    expect((err as Error).message).toMatch(/TLS-inspecting proxy/i);
    expect((err as Error).message).toMatch(/exempt/i);
  });

  it('REFUSAL (loopback bypass): a loopback Authority Server is reached directly even with a broken proxy configured', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    process.env.NODE_EXTRA_CA_CERTS = asCert.certFile;
    // Nothing listens here — if loopback calls were (wrongly) routed through
    // this "proxy", the connection would fail/hang instead of succeeding.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';

    // `capture: true` for the same reason as the "direct" test above — it's
    // the mode that re-reads env per call, needed to mutate
    // NODE_EXTRA_CA_CERTS at runtime within this test process. The property
    // under test here (loopback is never proxied) is exercised identically
    // either way: `buildTlsDispatcher` calls `selectProxyUrl` regardless of
    // which branch of `fetchAs` reached it.
    const { res } = await fetchAs(`https://127.0.0.1:${backend.port}/`, undefined, { enforce: false, capture: true });
    expect(res.status).toBe(200);
  });

  it('CONTROL CHECK: with proxy selection stubbed to never select a proxy, the same "through proxy" call fails', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startPlainProxy(backend.port); cleanups.push(proxy.close);
    process.env.NODE_EXTRA_CA_CERTS = asCert.certFile;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    vi.resetModules();
    vi.doMock('../src/lib/proxy-env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/lib/proxy-env')>();
      return { ...actual, selectProxyUrl: () => undefined };
    });
    try {
      const { fetchAs: fetchAsWithProxyWiringDisabled } = await import('../src/lib/as-tls-pin');
      // HOST never resolves via real DNS — without the proxy, this can only
      // ever fail. That failure IS the proof that the passing test above
      // depends on the proxy-selection wiring, not an accidental direct route.
      await expect(
        fetchAsWithProxyWiringDisabled(`https://${HOST}:${backend.port}/`, undefined, { enforce: false }),
      ).rejects.toThrow();
    } finally {
      vi.doUnmock('../src/lib/proxy-env');
      vi.resetModules();
    }
  });
});
