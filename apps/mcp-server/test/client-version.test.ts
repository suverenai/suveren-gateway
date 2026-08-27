/**
 * The gateway identifies itself on every Authority Server call.
 *
 * Why it matters: until now the AS could not tell which gateway was calling,
 * so "how many deployed gateways would this contract change break?" had no
 * answer, and an older client got an opaque rejection instead of "upgrade to
 * X". These headers are advisory — the AS must never authorize on them — but
 * they have to actually arrive, on every endpoint rather than just receipts,
 * or the population they describe is skewed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SPClient } from '../src/lib/sp-client';
import { GATEWAY_VERSION, HAP_CORE_VERSION, clientVersionHeaders } from '../src/lib/client-version';

function capture() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('clientVersionHeaders', () => {
  it('reports a gateway version and a hap-core version', () => {
    const h = clientVersionHeaders();
    expect(h['x-suveren-gateway-version']).toBe(GATEWAY_VERSION);
    expect(h['x-hap-core-version']).toBe(HAP_CORE_VERSION);
  });

  it('resolves the SHARED hap-core version, not a placeholder', () => {
    // hap-core is the real compatibility axis — two implementations on
    // different versions can disagree about canonical bytes. A value that
    // silently degraded to "unknown" here would hide exactly that.
    expect(HAP_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('never throws and never yields an empty value', () => {
    // Resolution walks the filesystem and must degrade, not fail: an
    // unresolvable version may not take down every AS call.
    for (const v of Object.values(clientVersionHeaders())) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('reports the DISTRIBUTED version, never the internal workspace 0.1.0', () => {
    // apps/mcp-server/package.json is 0.1.0 and would be meaningless to an
    // operator being told which build to upgrade.
    expect(GATEWAY_VERSION).not.toBe('0.1.0');
  });
});

describe('SPClient sends the headers', () => {
  it('attaches them to an AS request', async () => {
    const calls = capture();
    const client = new SPClient('http://as.test');
    await client.getPublicKey().catch(() => { /* response shape is irrelevant here */ });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].headers['x-suveren-gateway-version']).toBe(GATEWAY_VERSION);
    expect(calls[0].headers['x-hap-core-version']).toBe(HAP_CORE_VERSION);
  });

  it('does not let them displace auth or content-type headers', async () => {
    const calls = capture();
    const client = new SPClient('http://as.test');
    client.setApiKey('secret-key');
    await client.getPublicKey().catch(() => {});

    expect(calls[0].headers['X-API-Key']).toBe('secret-key');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].headers['x-suveren-gateway-version']).toBe(GATEWAY_VERSION);
  });
});
