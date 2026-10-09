/**
 * V7 — version compat check (protocol.md -> Version negotiation).
 *
 * GET /api/as/compat is checked once at startup (shared-state.ts's
 * checkAsCompat, called from bin/http.ts). When the paired Authority Server
 * does not list this package's protocol version among `supportedVersions`,
 * every gated tool call must refuse BEFORE any local check, ticket request,
 * or execution — the incompatibility is structural, not a per-call AS
 * refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SharedState } from '../src/lib/shared-state';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { DiscoveredTool } from '../src/lib/integration-manager';
import type { IntegrationManager } from '../src/lib/integration-manager';

const BASE = 'http://as.test';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('SharedState#checkAsCompat', () => {
  it('sets asVersionRefusal when the AS does not list our protocol version', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.6'] }));
    const state = new SharedState(BASE);
    expect(state.asVersionRefusal).toBeNull();

    await state.checkAsCompat();

    expect(state.asVersionRefusal).not.toBeNull();
    expect(state.asVersionRefusal).toContain('0.6');
  });

  it('leaves asVersionRefusal null when the AS lists our protocol version', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.7'] }));
    const state = new SharedState(BASE);

    await state.checkAsCompat();

    expect(state.asVersionRefusal).toBeNull();
  });

  it('clears a prior refusal once the AS becomes compatible (re-check)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.6'] }));
    const state = new SharedState(BASE);
    await state.checkAsCompat();
    expect(state.asVersionRefusal).not.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.7'] }));
    await state.checkAsCompat();
    expect(state.asVersionRefusal).toBeNull();
  });

  it('does not set a refusal when the AS is merely unreachable (not this check\'s concern)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const state = new SharedState(BASE);

    await state.checkAsCompat();

    expect(state.asVersionRefusal).toBeNull();
  });

  // Regression: the REAL production suveren.ai, still pre-v0.7 at the time
  // this check shipped, answers /api/as/compat with no `supportedVersions`
  // field at all (its own shape predates this check). Reading it as a bare
  // array (`compat.supportedVersions.includes(...)`) threw on the floating
  // promise this is awaited from (`void state.checkAsCompat()` at startup)
  // — an unhandled rejection, which crashed the WHOLE process against a
  // real pre-migration AS, every other in-flight request included.
  it('treats a pre-v0.7 AS response (no supportedVersions field) as incompatible, not a crash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      protocolVersion: '0.6',
      minGatewayVersion: null,
      you: { gatewayVersion: null, hapCoreVersion: null, description: 'x', identified: false },
    }));
    const state = new SharedState(BASE);

    await expect(state.checkAsCompat()).resolves.toBeUndefined();

    expect(state.asVersionRefusal).not.toBeNull();
    expect(state.asVersionRefusal).toContain('0.6');
  });
});

describe('createGatedToolHandler — V7 fail-closed on asVersionRefusal', () => {
  const TOOL: DiscoveredTool = {
    originalName: 'create_charge',
    namespacedName: 'stripe__create_charge',
    integrationId: 'stripe',
    description: '',
    inputSchema: {},
    gating: {
      profile: 'charge',
      executionMapping: { amount: 'amount' },
      staticExecution: { action_type: 'charge' },
    } as unknown as DiscoveredTool['gating'],
  };

  it('refuses before any ticket request or execution, with no AS call at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.6'] }));
    const state = new SharedState(BASE);
    await state.checkAsCompat();
    expect(state.asVersionRefusal).not.toBeNull();

    const postReceipt = vi.fn();
    (state as unknown as { spClient: { postReceipt: typeof postReceipt; isUnlocked: () => boolean } }).spClient = {
      postReceipt,
      isUnlocked: () => true,
    };
    const callTool = vi.fn();
    const im = { getAllTools: () => [TOOL], callTool, isSimulationSafe: () => true } as unknown as IntegrationManager;

    const handler = createGatedToolHandler(TOOL, im, state);
    const result = await handler({ amount: 50 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0.6');
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs normally once compat is confirmed (no refusal)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { protocolVersion: '0.7', supportedVersions: ['0.7'] }));
    const state = new SharedState(BASE);
    await state.checkAsCompat();
    expect(state.asVersionRefusal).toBeNull();
  });
});
