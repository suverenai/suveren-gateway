/**
 * Opt-in TLS certificate pinning (`config set pin-tls on`) through the REAL
 * sign-in flow: a local HTTPS "Authority Server" with a REAL self-signed
 * certificate (generated via `openssl` in beforeAll), real certificate
 * swaps on the SAME host:port, and the actual Node TLS stack. Nothing here
 * mocks the TLS layer — see as-tls-pin.test.ts for the module-level
 * equivalent without the HTTP routes.
 *
 * The signing-key pin is PRE-SEEDED in every test here (via writePairing,
 * not a live sign-in) rather than captured through `GET /api/as/pubkey`'s
 * plain, unpinned fetch: that call uses the bare global `fetch`, which only
 * trusts a self-signed certificate if `NODE_EXTRA_CA_CERTS` was set before
 * THIS Node process started (bundle/server.js's own doc comment — it reads
 * that env var once, at boot, which is why production re-execs for it).
 * Setting it live, mid-test, cannot retroactively make the already-running
 * vitest worker's bare fetch trust a new cert — so this suite tests the
 * dimension that matters here (the TLS pin) against a gateway that already
 * completed its signing-key pairing, exactly like turning `pin-tls on` for
 * an ALREADY-paired Authority Server (the CLI's own documented case). The
 * challenge and session calls below DO support this dynamically — they go
 * through fetchAs's own per-call Agent (as-tls-pin.ts's `effectiveCa()`),
 * which reads `NODE_EXTRA_CA_CERTS` fresh on every call rather than relying
 * on a cached boot-time trust store.
 *
 * The scenarios from the spec this covers:
 *  - sign in, pin-tls on → the certificate pin is captured.
 *  - a "relay" with its OWN certificate (separately trusted via a
 *    `--ca-file`-equivalent — plain TLS validation alone would accept it)
 *    answers the SAME url:port → sign-in is refused, and the stand-in
 *    NEVER receives X-API-Key.
 *  - the SAME key, reissued under a NEW certificate (renewal) → still
 *    accepted — the pin is the key, not the certificate.
 *  - pin-tls off → today's behaviour (covered already by
 *    auth-pairing.test.ts / auth-challenge.test.ts over plain HTTP; not
 *    repeated here).
 *
 * The fake AS listens on port 0 (OS-assigned) — this suite runs alongside
 * other workspaces' own TLS test servers under `pnpm -r test`, and a FIXED
 * port here collided with one of theirs (EADDRINUSE, CI macOS). "Same URL"
 * cert-swap tests capture the first server's assigned port and explicitly
 * rebind the SECOND server to that exact number after closing the first.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@hap/core';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';
import { readPairing, writePairing } from '../../lib/as-pairing';
import { spkiSha256Hex } from '../../lib/as-tls-pin';

interface SigningKeypair {
  publicKeyHex: string;
  privateKey: KeyObject;
}

function realEd25519Keypair(): SigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return { publicKeyHex: Buffer.from(jwk.x!, 'base64url').toString('hex'), privateKey };
}

function signChallenge(nonce: string, privateKey: KeyObject): Record<string, unknown> {
  const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) };
  const bytes = Buffer.concat([Buffer.from('hap-as-challenge\u0000', 'utf-8'), Buffer.from(canonicalize(unsigned), 'utf-8')]);
  const signature = cryptoSign(null, bytes, privateKey).toString('base64url');
  return { ...unsigned, signature };
}

const certDir = mkdtempSync(join(tmpdir(), 'auth-pin-tls-certs-'));

interface Cert {
  certFile: string;
  keyFile: string;
}

function opensslNewCert(name: string): Cert {
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

/** A NEW certificate for an EXISTING key — the "renewal, same key" shape. */
function opensslRenewCert(name: string, existing: Cert): Cert {
  const certFile = join(certDir, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', existing.keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { certFile, keyFile: existing.keyFile };
}

let certA: Cert;
let certARenewed: Cert; // same key as certA, new certificate
let certB: Cert; // a completely different keypair — the "relay" shape

beforeAll(() => {
  certA = opensslNewCert('a');
  certARenewed = opensslRenewCert('a-renewed', certA);
  certB = opensslNewCert('b');
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;

interface FakeHttpsAs {
  url: string;
  port: number;
  close: () => Promise<void>;
  sessionCalls: Array<{ apiKey: string | undefined }>;
}

/** A real HTTPS server, standing in for the Authority Server, implementing
 *  the two routes a sign-in with an already-pinned signing key touches
 *  (`/api/as/challenge`, `/api/auth/session`) — `/api/as/pubkey` is
 *  deliberately NOT needed here (see module doc comment).
 *
 *  @param port 0 (default) lets the OS assign a free port — read back via
 *  the resolved `port`/`url`. Pass an explicit port to rebind the SAME
 *  number a prior (now-closed) server in this test was assigned, for the
 *  "same URL, different certificate" shape. */
function startFakeHttpsAs(cert: Cert, getKeypair: () => SigningKeypair, port = 0): Promise<FakeHttpsAs> {
  const sessionCalls: Array<{ apiKey: string | undefined }> = [];
  const app = express();
  app.use(express.json());
  app.post('/api/as/challenge', (req, res) => {
    const { nonce } = (req.body ?? {}) as { nonce?: string };
    res.json(signChallenge(nonce ?? '', getKeypair().privateKey));
  });
  app.post('/api/auth/session', (req, res) => {
    sessionCalls.push({ apiKey: req.headers['x-api-key'] as string | undefined });
    res.json({ user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 });
  });
  app.use((_req, res) => res.status(404).end());

  const server: HttpsServer = createServer(
    { cert: readFileSync(cert.certFile), key: readFileSync(cert.keyFile) },
    app,
  );
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const assigned = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `https://127.0.0.1:${assigned}`,
        port: assigned,
        close: () => new Promise<void>((r) => server.close(() => r())),
        sessionCalls,
      });
    });
  });
}

function startGateway(vault: Vault, asUrl: string, dataDir: string) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/auth', createAuthRouter(vault, noopAuth, noopRateLimit, undefined, { asUrl, dataDir }));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server: HttpServer = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'auth-pin-tls-'));
}

/** Writes <dataDir>/config.json with pinTls: true — same shape
 *  `suveren-gateway config set pin-tls on` produces. */
function enablePinTls(dataDir: string): void {
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pinTls: true }, null, 2));
}

async function login(gwUrl: string): Promise<Response> {
  return fetch(`${gwUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
  });
}

// Every server/gateway started by a test registers its close() here —
// drained unconditionally in afterEach, so an assertion failure partway
// through a multi-phase test can never leak a listening port into the next
// test (which is exactly what caused EADDRINUSE before this was an array:
// a `.close()` written as a bare `await` statement never runs once an
// `expect(...)` above it throws).
let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  if (originalExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
});

describe('POST /auth/login — opt-in TLS pinning (config set pin-tls on), real TLS', () => {
  it('captures the TLS pin on first sign-in, alongside the signing-key pin', async () => {
    const kp = realEd25519Keypair();
    process.env.NODE_EXTRA_CA_CERTS = certA.certFile;
    const as = await startFakeHttpsAs(certA, () => kp); cleanups.push(as.close);
    const dataDir = tmp();
    enablePinTls(dataDir);
    writePairing(dataDir, as.url, kp.publicKeyHex); // signing key already paired; TLS pin not yet
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir); cleanups.push(gw.close);

    const res = await login(gw.url);

    expect(res.status).toBe(200);
    expect(as.sessionCalls).toHaveLength(1);
    expect(as.sessionCalls[0].apiKey).toBe('hap_test');
    const pairing = readPairing(dataDir);
    expect(pairing?.tlsSpkiPinHex).toBeDefined();

    // Sanity: the captured pin really is THIS certificate's SPKI — computed
    // via a real TLS connection to the still-running server (the same thing
    // spkiSha256Hex is used on in production), not re-derived by hand.
    const liveCert = await new Promise<Parameters<typeof spkiSha256Hex>[0]>((resolve, reject) => {
      // No `servername` — Node rejects an IP literal there (SNI is a
      // hostname concept); this connects to 127.0.0.1 directly.
      const socket = tlsConnect(
        { host: '127.0.0.1', port: as.port, ca: readFileSync(certA.certFile) },
        () => { resolve(socket.getPeerCertificate(true)); socket.end(); },
      );
      socket.on('error', reject);
    });
    expect(pairing?.tlsSpkiPinHex).toBe(spkiSha256Hex(liveCert));
  });

  it('REFUSAL: a relay with its OWN certificate on the SAME URL is refused (409 as_tls_mismatch) — the stand-in never receives X-API-Key', async () => {
    const kp = realEd25519Keypair();
    const dataDir = tmp();
    enablePinTls(dataDir);
    setInternalSecret('test-secret');

    // First, pin against certA.
    process.env.NODE_EXTRA_CA_CERTS = certA.certFile;
    const as1 = await startFakeHttpsAs(certA, () => kp); cleanups.push(as1.close);
    writePairing(dataDir, as1.url, kp.publicKeyHex);
    const gw1 = await startGateway(new Vault(dataDir), as1.url, dataDir); cleanups.push(gw1.close);
    const first = await login(gw1.url);
    expect(first.status).toBe(200);
    const pinnedHex = readPairing(dataDir)?.tlsSpkiPinHex;
    expect(pinnedHex).toBeDefined();
    await gw1.close();
    await as1.close();

    // Now something else answers the SAME url:port with certB (its OWN,
    // separately-trusted-via-CA-file certificate) — still signs correctly
    // with the SAME Ed25519 key (kp), to isolate that it is specifically the
    // TLS pin (not the Ed25519 challenge) that catches this.
    process.env.NODE_EXTRA_CA_CERTS = certB.certFile;
    const as2 = await startFakeHttpsAs(certB, () => kp, as1.port); cleanups.push(as2.close);
    const gw2 = await startGateway(new Vault(dataDir), as1.url, dataDir); cleanups.push(gw2.close);

    const second = await login(gw2.url);

    expect(second.status).toBe(409);
    const body = await second.json() as { error?: string };
    expect(body.error).toBe('as_tls_mismatch');
    expect(as2.sessionCalls, 'the API key must never reach a relay presenting a different certificate').toHaveLength(0);
    // The pin must not have been silently replaced.
    expect(readPairing(dataDir)?.tlsSpkiPinHex).toBe(pinnedHex);
  });

  it('a certificate RENEWAL under the SAME key is still accepted — the pin is the key, not the certificate', async () => {
    const kp = realEd25519Keypair();
    const dataDir = tmp();
    enablePinTls(dataDir);
    setInternalSecret('test-secret');

    process.env.NODE_EXTRA_CA_CERTS = certA.certFile;
    const as1 = await startFakeHttpsAs(certA, () => kp); cleanups.push(as1.close);
    writePairing(dataDir, as1.url, kp.publicKeyHex);
    const gw1 = await startGateway(new Vault(dataDir), as1.url, dataDir); cleanups.push(gw1.close);
    const first = await login(gw1.url);
    expect(first.status).toBe(200);
    const pinnedHex = readPairing(dataDir)?.tlsSpkiPinHex;
    await gw1.close();
    await as1.close();

    // Renewed certificate, SAME private key — a different cert file/serial,
    // identical SPKI.
    process.env.NODE_EXTRA_CA_CERTS = certARenewed.certFile;
    const as2 = await startFakeHttpsAs(certARenewed, () => kp, as1.port); cleanups.push(as2.close);
    const gw2 = await startGateway(new Vault(dataDir), as1.url, dataDir); cleanups.push(gw2.close);

    const second = await login(gw2.url);

    expect(second.status).toBe(200);
    expect(as2.sessionCalls).toHaveLength(1);
    expect(as2.sessionCalls[0].apiKey).toBe('hap_test');
    // Still the SAME pin — no silent re-pin, nothing changed.
    expect(readPairing(dataDir)?.tlsSpkiPinHex).toBe(pinnedHex);
  });
});

/** The live SPKI SHA-256 of whatever's listening at `port`, trusting
 *  `caFile` — used to build the EXACT value an operator's out-of-band
 *  `--expect-fingerprint` check would have produced. */
async function liveSpkiHex(caFile: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: readFileSync(caFile) }, () => {
      const hex = spkiSha256Hex(socket.getPeerCertificate(true));
      socket.end();
      resolve(hex);
    });
    socket.on('error', reject);
  });
}

describe('pin-tls on: a fingerprint staged via --expect-fingerprint (config.json, before any TLS pin exists)', () => {
  it('matches the first verified challenge — accepted, and promoted into as-pairing.json', async () => {
    const kp = realEd25519Keypair();
    process.env.NODE_EXTRA_CA_CERTS = certA.certFile;
    const as = await startFakeHttpsAs(certA, () => kp); cleanups.push(as.close);
    const realHex = await liveSpkiHex(certA.certFile, as.port);

    const dataDir = tmp();
    // Signing-key pairing already exists (see the module doc comment for
    // why — the bare pubkey fetch can't trust a self-signed cert mid-test),
    // but NO TLS pin yet: exactly what `bundle/bin/suveren-gateway.js`'s
    // `config set pin-tls on --expect-fingerprint` stages when it can't
    // write straight into as-pairing.json.
    writePairing(dataDir, as.url, kp.publicKeyHex);
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pinTls: true, pinTlsExpectedFingerprint: realHex }));
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir); cleanups.push(gw.close);

    const res = await login(gw.url);

    expect(res.status).toBe(200);
    expect(readPairing(dataDir)?.tlsSpkiPinHex).toBe(realHex);
    // The staging field's job is done — cleared, not left stale.
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8')).pinTlsExpectedFingerprint).toBeUndefined();
  });

  it("REFUSAL: does NOT match the first verified challenge's live certificate — refused, never promoted, never silently accepted", async () => {
    const kp = realEd25519Keypair();
    process.env.NODE_EXTRA_CA_CERTS = certA.certFile;
    const as = await startFakeHttpsAs(certA, () => kp); cleanups.push(as.close);

    const dataDir = tmp();
    writePairing(dataDir, as.url, kp.publicKeyHex);
    const wrongHex = '0'.repeat(64); // what the operator typed does NOT match certA
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pinTls: true, pinTlsExpectedFingerprint: wrongHex }));
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir); cleanups.push(gw.close);

    const res = await login(gw.url);

    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_tls_mismatch');
    expect(readPairing(dataDir)?.tlsSpkiPinHex).toBeUndefined();
    // The staged (wrong) value is left alone — not silently cleared or
    // replaced by whatever the live certificate actually is.
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8')).pinTlsExpectedFingerprint).toBe(wrongHex);
  });
});
