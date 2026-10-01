/**
 * SPClient's single-flight "tell the control plane once" flag for a TLS pin
 * mismatch (as-tls-pin.ts) must be RESET on a fresh sign-in
 * (`setSessionCookie`) — otherwise a SECOND relay episode after re-signing-in
 * never notifies the control plane again (the flag fired once, in a process
 * that never restarts), and the UI keeps showing "signed in" while every
 * gated call is silently refusing. Mirrors the SAME bug class
 * `sessionExpiredNotified` already guards against in session-expiry.test.ts.
 *
 * REAL TLS: a local HTTPS server with a real self-signed certificate
 * (generated via `openssl` in beforeAll) that never matches the pinned SPKI
 * on file — every call made through the pinned dispatcher mismatches, same
 * as a relay episode in production. `globalThis.fetch` is stubbed ONLY for
 * cp-notify's call to the control plane (a plain global `fetch`, unaffected
 * by the undici-based pinned dispatcher SPClient uses for the AS itself).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPClient } from '../src/lib/sp-client';
import { writePairing } from '../src/lib/as-pairing';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let notifyCalls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  notifyCalls = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/internal/event')) {
      notifyCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`unexpected global fetch to ${url} — the AS call should go through undici, not here`);
  });
  vi.stubGlobal('fetch', fetchMock);
  process.env.SUVEREN_INTERNAL_SECRET = 'test-secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUVEREN_INTERNAL_SECRET;
  delete process.env.NODE_EXTRA_CA_CERTS;
});

const certDir = mkdtempSync(join(tmpdir(), 'sp-client-tls-notify-certs-'));
const PORT = 18545;
const AS_URL = `https://127.0.0.1:${PORT}`;

beforeAll(() => {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'cert.key'), '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    const s = server; server = null;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function startServer(): Promise<void> {
  server = createServer(
    { cert: readFileSync(join(certDir, 'cert.pem')), key: readFileSync(join(certDir, 'cert.key')) },
    (_req, res) => res.end(JSON.stringify({ publicKey: 'aa' })),
  );
  return new Promise((resolve) => server!.listen(PORT, '127.0.0.1', () => resolve()));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sp-client-tls-notify-'));
}

describe('SPClient — TLS mismatch notify flag resets on a fresh session', () => {
  it('notifies again on a SECOND mismatch episode after setSessionCookie (re-sign-in)', async () => {
    process.env.NODE_EXTRA_CA_CERTS = join(certDir, 'cert.pem'); // the relay's cert IS CA-trusted
    await startServer();

    const dataDir = tmp();
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pinTls: true }));
    // A pin that will NEVER match this server's real certificate.
    writePairing(dataDir, AS_URL, 'deadbeef', { tlsSpkiPinHex: '0'.repeat(64) });

    const client = new SPClient(AS_URL, { maxAttempts: 1, delaysMs: [] }, dataDir);
    client.setSessionCookie('hap-session=abc');

    // Episode 1, call 1: mismatch, notified once.
    await expect(client.getPublicKey()).rejects.toThrow();
    expect(client.getLockReason()).toBe('as-tls-mismatch');
    expect(notifyCalls).toHaveLength(1);

    // Episode 1, call 2 (same session, no re-sign-in): single-flight — NOT notified again.
    await expect(client.getPublicKey()).rejects.toThrow();
    expect(notifyCalls).toHaveLength(1);

    // Re-sign-in — a fresh session must re-arm the notify flag.
    client.setSessionCookie('hap-session=def');
    expect(client.getLockReason()).toBeNull();

    // Episode 2: the relay is still there (same mismatching cert) — notified AGAIN.
    await expect(client.getPublicKey()).rejects.toThrow();
    expect(client.getLockReason()).toBe('as-tls-mismatch');
    expect(notifyCalls, 'tlsMismatchNotified was not reset on re-sign-in — the second episode never told the control plane').toHaveLength(2);
  });
});
