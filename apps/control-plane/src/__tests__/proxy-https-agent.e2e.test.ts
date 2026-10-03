/**
 * `ConnectTunnelHttpsAgent` / `buildPinnedHttpsAgent` (proxy-https-agent.ts,
 * as-tls-pin.ts) — REAL network, separate from corporate-proxy.e2e.test.ts.
 *
 * `fetchAs` (tested there) and the control-plane's `/api` reverse proxy (the
 * ONE real caller of `buildPinnedHttpsAgent`, wired in index.ts) use TWO
 * independent mechanisms to tunnel through a proxy — undici's `ProxyAgent`
 * for `fetch`, and this hand-rolled `https.Agent` subclass for Node's native
 * `http(s).request` (which `http-proxy-middleware` uses). Covering only the
 * first would leave the one actually serving browser traffic to the
 * Authority Server unverified.
 *
 * `HOST` (not `127.0.0.1`) is used for every proxied case, deliberately: the
 * Authority Server URL decides ONCE, in `buildPinnedHttpsAgent`, whether a
 * proxy applies — and a loopback URL never is (see proxy-env.ts). Using
 * `127.0.0.1` here would make `selectProxyUrl` bypass the proxy entirely,
 * so the "through a proxy" tests would silently connect directly and pass
 * for the wrong reason — the exact false-positive this file exists to avoid.
 * `HOST` never resolves via real DNS, so the agent's own CONNECT tunnelling
 * is the only way these calls can succeed at all.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer, type Agent as HttpsAgentType } from 'node:https';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPinnedHttpsAgent, type AsFetchPinning } from '../lib/as-tls-pin';

const HOST = 'fake-as.proxytest.invalid'; // never resolves via real DNS
const certDir = mkdtempSync(join(tmpdir(), 'proxy-https-agent-'));

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
  writeFileSync(extFile, `subjectAltName=DNS:${HOST}\n`);
  const leafCert = join(certDir, 'inspected-leaf.cert.pem');
  execFileSync('openssl', [
    'x509', '-req', '-in', leafCsr,
    '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial',
    '-out', leafCert, '-days', '1', '-extfile', extFile,
  ], { stdio: 'ignore' });

  return { root: { certFile: rootCert, keyFile: rootKey }, leaf: { certFile: leafCert, keyFile: leafKey } };
}

/** SHA-256 of a certificate's SPKI, read straight off the PEM file — SPKI
 *  derivation itself is covered by as-tls-pin.test.ts; this just needs the
 *  real value to pin against. */
function spkiSha256Hex(certFile: string): string {
  const cert = new X509Certificate(readFileSync(certFile));
  return createHash('sha256').update(cert.publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
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

const ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

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

/** Every CONNECT this proxy receives is routed to `backendPort` on
 *  127.0.0.1, regardless of the requested host — see the module doc comment
 *  on why `HOST` is used throughout instead. */
function startPlainProxy(backendPort: number): Promise<{ close: () => Promise<void>; port: number }> {
  const allSockets = new Set<Socket>();
  const server = createNetServer((clientSocket) => {
    allSockets.add(clientSocket);
    clientSocket.on('close', () => allSockets.delete(clientSocket));
    readConnectRequest(clientSocket).then(() => {
      const upstream = netConnect(backendPort, '127.0.0.1');
      allSockets.add(upstream);
      upstream.on('close', () => allSockets.delete(upstream));
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      // Destroy both ends together on EITHER side's close/end/error — a
      // native `https.Agent`'s keep-alive=false teardown is a graceful
      // half-close (`end`), not an abrupt `error`, which `server.close()`
      // alone waits forever for if the two legs aren't torn down together.
      const cleanup = () => { clientSocket.destroy(); upstream.destroy(); };
      for (const ev of ['error', 'close', 'end'] as const) {
        clientSocket.on(ev, cleanup);
        upstream.on(ev, cleanup);
      }
    }).catch(() => clientSocket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        close: () => new Promise<void>((r) => {
          server.close(() => r());
          for (const s of allSockets) s.destroy();
        }),
        port,
      });
    });
  });
}

/** Terminates the client's TLS with `company.leaf` (a DIFFERENT key than the
 *  real AS backend's) and nothing else — sufficient to prove a pin refuses
 *  it; no relaying needed for that. */
function startInspectingStub(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createNetServer((clientSocket) => {
    readConnectRequest(clientSocket).then(() => {
      const clientTls = new TLSSocket(clientSocket, {
        isServer: true,
        cert: readFileSync(company.leaf.certFile),
        key: readFileSync(company.leaf.keyFile),
      });
      clientTls.on('error', () => clientTls.destroy());
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

/** `https.request()` via `agent`, targeting `HOST` (not the real backend's
 *  address) — the same shape http-proxy's outgoing request takes. Resolves
 *  with the status code. */
function requestViaAgent(host: string, port: number, agent: HttpsAgentType): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host, port, path: '/', agent, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

describe('ConnectTunnelHttpsAgent / buildPinnedHttpsAgent — real network', () => {
  it('direct (no proxy configured): reaches the AS backend over 127.0.0.1', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const pinning: AsFetchPinning = { enforce: false };
    const agent = buildPinnedHttpsAgent(() => pinning, `https://127.0.0.1:${backend.port}`);
    agent.options.ca = [readFileSync(asCert.certFile)];

    expect(await requestViaAgent('127.0.0.1', backend.port, agent)).toBe(200);
    agent.destroy();
  });

  it('through a plain CONNECT proxy: tunnels through and reaches the real AS backend', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startPlainProxy(backend.port); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    const pinning: AsFetchPinning = { enforce: false };
    const agent = buildPinnedHttpsAgent(() => pinning, `https://${HOST}:${backend.port}`);
    agent.options.ca = [readFileSync(asCert.certFile)];

    expect(await requestViaAgent(HOST, backend.port, agent)).toBe(200);
    agent.destroy();
  });

  it('CONTROL CHECK: without HTTPS_PROXY, the same call (unresolvable HOST) fails — proving the test above really tunnelled', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const pinning: AsFetchPinning = { enforce: false };
    const agent = buildPinnedHttpsAgent(() => pinning, `https://${HOST}:${backend.port}`);
    agent.options.ca = [readFileSync(asCert.certFile)];

    await expect(requestViaAgent(HOST, backend.port, agent)).rejects.toThrow(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i);
    agent.destroy();
  });

  it('pin-tls ON, through a plain CONNECT proxy: the CORRECT pin is accepted (ca + checkServerIdentity both carried through the tunnel)', async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startPlainProxy(backend.port); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    const pinning: AsFetchPinning = { enforce: true, pinnedSpkiHex: spkiSha256Hex(asCert.certFile) };
    const agent = buildPinnedHttpsAgent(() => pinning, `https://${HOST}:${backend.port}`);
    agent.options.ca = [readFileSync(asCert.certFile)];

    expect(await requestViaAgent(HOST, backend.port, agent)).toBe(200);
    agent.destroy();
  });

  it("pin-tls ON, through a TLS-inspecting proxy presenting a DIFFERENT key: refused — the pin is enforced on the certificate seen THROUGH the tunnel, not the real backend's", async () => {
    const backend = await startAsBackend(asCert); cleanups.push(backend.close);
    const proxy = await startInspectingStub(); cleanups.push(proxy.close);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    const pinning: AsFetchPinning = { enforce: true, pinnedSpkiHex: spkiSha256Hex(asCert.certFile) };
    const agent = buildPinnedHttpsAgent(() => pinning, `https://${HOST}:${backend.port}`);
    // Trust the company root for CHAIN validity (so this fails on the PIN,
    // not merely on an untrusted issuer — the two must be distinguishable).
    agent.options.ca = [readFileSync(company.root.certFile)];

    await expect(requestViaAgent(HOST, backend.port, agent)).rejects.toThrow(/pin/i);
    agent.destroy();
  });
});
