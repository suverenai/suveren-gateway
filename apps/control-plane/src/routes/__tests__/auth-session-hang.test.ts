/**
 * Regression test for the 2026-10-02 production incident: `POST /auth/login`
 * hung FOREVER (0% CPU, no logs, curl eventually gave up but the gateway
 * process never did) once the session exchange to the Authority Server
 * talked to a connection that went silent — a dead/zombie keep-alive socket
 * in production; simulated here by a real HTTPS server that accepts the
 * `/api/auth/session` request and then never answers it at all.
 *
 * Root cause: neither `fetchAs` (as-tls-pin.ts) nor this route's own call to
 * it carried an `AbortSignal` — every OTHER AS call in this codebase did
 * (challenge: 5s, pubkey: 5s, E2EE background calls: 5s), but the session
 * exchange — the one call every single login attempt makes — did not. A
 * promise with no timeout against a connection that never answers waits
 * forever, by definition.
 *
 * Nothing here is mocked: a real self-signed certificate (openssl, like
 * auth-pin-tls.test.ts), a real HTTPS server standing in for the Authority
 * Server, the real `createAuthRouter`, and the real `fetchAs`/undici stack.
 *
 * Secondary regression covered below: the per-call undici `Agent` the
 * capturing/pinned branches of `fetchAs` build was never closed — every
 * sign-in attempt (successful or not) leaked one open TLS connection,
 * forever, in a long-running process. That is the "many idle ESTABLISHED
 * connections" half of the same incident.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server as HttpsServer } from 'node:https';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { canonicalize } from '@hap/core';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';
import { writePairing } from '../../lib/as-pairing';
import { fetchAs, spkiSha256Hex } from '../../lib/as-tls-pin';

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

const certDir = mkdtempSync(join(tmpdir(), 'auth-session-hang-certs-'));
const certFile = join(certDir, 'a.cert.pem');
const keyFile = join(certDir, 'a.key.pem');

beforeAll(() => {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;

interface ZombieAs {
  url: string;
  close: () => Promise<void>;
  sessionHits: number;
}

/** A real HTTPS server standing in for the Authority Server: answers the
 *  signing-key challenge correctly, then goes completely silent on
 *  `/api/auth/session` — never calls `res.end()` / writes anything — exactly
 *  what a dead/zombie keep-alive socket looks like from the caller's side:
 *  the TCP connection is open, nothing is wrong at the transport layer, and
 *  no response ever arrives. */
function startZombieAs(kp: SigningKeypair): Promise<ZombieAs> {
  let sessionHits = 0;
  const app = express();
  app.use(express.json());
  app.post('/api/as/challenge', (req, res) => {
    const { nonce } = (req.body ?? {}) as { nonce?: string };
    res.json(signChallenge(nonce ?? '', kp.privateKey));
  });
  app.post('/api/auth/session', () => {
    sessionHits += 1;
    // Deliberately never respond.
  });
  app.use((_req, res) => res.status(404).end());

  const server: HttpsServer = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `https://127.0.0.1:${port}`,
        get sessionHits() { return sessionHits; },
        // closeAllConnections (Node 18.2+) is required here, not plain
        // close(): a request that got no response never ends, so a bare
        // server.close() would itself hang waiting for that connection.
        close: () => new Promise<void>((r) => {
          (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
          server.close(() => r());
        }),
      } as ZombieAs);
    });
  });
}

/** A real HTTPS server that answers EVERY request immediately — used for the
 *  dispatcher-leak regression below, where the point is a normal, healthy
 *  exchange still must not leak its Agent. */
function startHealthyAs(kp: SigningKeypair): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post('/api/as/challenge', (req, res) => {
    const { nonce } = (req.body ?? {}) as { nonce?: string };
    res.json(signChallenge(nonce ?? '', kp.privateKey));
  });
  const server: HttpsServer = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `https://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
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
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'auth-session-hang-'));
}

async function login(gwUrl: string): Promise<Response> {
  return fetch(`${gwUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
  });
}

/** The live SPKI SHA-256 of whatever's listening at `port` — same helper as
 *  auth-pin-tls.test.ts, used here for an orthogonal reason: NOT to test
 *  pin-tls itself, but to route the session call through `fetchAs`'s
 *  PINNED branch (its own per-call Agent, reading `NODE_EXTRA_CA_CERTS`
 *  fresh) rather than the bare, unpinned branch's global fetch dispatcher —
 *  which caches Node's trust store at process boot, so it can never be made
 *  to trust a self-signed certificate set mid-test (see auth-pin-tls.test.ts's
 *  module doc comment). Pin-tls is a TEST-ONLY device here; the bug this
 *  file regression-tests is in `fetchAs`/the route itself, present on every
 *  branch — confirmed separately against the real default (pin-tls off)
 *  path with a real spawned gateway process and a real suveren.ai-shaped
 *  zombie connection (see the incident report this test accompanies). */
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

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  if (originalExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
});

describe('POST /auth/login — a dead/zombie connection to the Authority Server must never hang sign-in forever', () => {
  it(
    'times out and answers 502 as_unreachable instead of hanging — reproduces the 2026-10-02 incident',
    async () => {
      const kp = realEd25519Keypair();
      process.env.NODE_EXTRA_CA_CERTS = certFile;
      const as = await startZombieAs(kp); cleanups.push(as.close);
      const asPort = Number(new URL(as.url).port);
      const tlsPinHex = await liveSpkiHex(certFile, asPort);
      const dataDir = tmp();
      // Signing-key pairing AND the TLS pin pre-seeded, pin-tls on — see
      // `liveSpkiHex`'s doc comment for why: this routes both the challenge
      // and (critically) the session call through `fetchAs`'s PINNED
      // branch, which — unlike the bare/default branch — builds its own
      // per-call Agent reading `NODE_EXTRA_CA_CERTS` fresh, so it can
      // actually trust a certificate set mid-test. The bug and the fix are
      // both in `fetchAs` itself (every branch), so this still exercises
      // them faithfully.
      writePairing(dataDir, as.url, kp.publicKeyHex, { tlsSpkiPinHex: tlsPinHex });
      writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pinTls: true }));
      setInternalSecret('test-secret');
      const gw = await startGateway(new Vault(dataDir), as.url, dataDir); cleanups.push(gw.close);

      const t0 = Date.now();
      const res = await login(gw.url);
      const elapsedMs = Date.now() - t0;

      // The actual production symptom was "never responds" — curl timing
      // out at 30s while the process kept running. The bound here (well
      // under the AS_FETCH timeout + the login route's own signal) proves
      // this resolves at all; the exact number only needs to be comfortably
      // short of "forever".
      expect(elapsedMs, 'must not hang indefinitely').toBeLessThan(13_000);
      expect(as.sessionHits, 'the session exchange really was attempted against the zombie connection').toBe(1);
      expect(res.status).toBe(502);
      const body = await res.json() as { error?: string; message?: string };
      expect(body.error).toBe('as_unreachable');
    },
    { timeout: 20_000 },
  );
});

describe('fetchAs (as-tls-pin.ts) — the per-call Agent for a captured/pinned connection must not leak', () => {
  it('closes the Agent it built once the call settles, even on a normal, healthy exchange', async () => {
    const kp = realEd25519Keypair();
    process.env.NODE_EXTRA_CA_CERTS = certFile;
    const as = await startHealthyAs(kp); cleanups.push(as.close);

    const closeSpy = vi.spyOn(Agent.prototype, 'close');
    try {
      const { res } = await fetchAs(
        `${as.url}/api/as/challenge`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'n' }) },
        { enforce: false, capture: true },
      );
      expect(res.status).toBe(200);
      await res.json(); // consume the body, as every real caller does

      // closeAfter() fires the close() call off the back of the same
      // promise fetchAs already awaited — no extra tick needed in
      // practice, but one is allowed for the fire-and-forget .catch/.finally
      // chain to actually run. Not asserting an exact call count: undici's
      // own `DispatcherBase.close()` recurses once internally to bridge its
      // promise/callback dual API, so one logical `.close()` call already
      // shows up as 2 — the only thing that matters here is "at least one",
      // i.e. not zero (leaked, as it was before this fix).
      await new Promise((r) => setTimeout(r, 20));

      expect(closeSpy.mock.calls.length, 'buildCapturingDispatcher\'s Agent must be closed, not abandoned').toBeGreaterThan(0);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
