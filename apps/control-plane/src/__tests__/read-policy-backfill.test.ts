import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `backfillReadPolicyDefaults` gives already-installed integrations the read
 * window their manifest declares. It runs unattended at every startup, so the
 * property that matters is that it only ever fills a GAP — it must never
 * overwrite a window the owner chose, in either direction.
 *
 * The bridge is mocked because this is about the fill/skip decision, not HTTP;
 * the endpoint round-trip is covered by the hap-e2e read-policy suite.
 */

const getIntegrations = vi.fn();
const setReadPolicy = vi.fn();

vi.mock('../lib/mcp-bridge', () => ({
  getIntegrations: (...a: unknown[]) => getIntegrations(...a),
  setReadPolicy: (...a: unknown[]) => setReadPolicy(...a),
}));

async function backfill(
  manifests: Array<Record<string, unknown>>,
  integrations: Array<{ id: string; readAgeDays?: number | null }>,
): Promise<void> {
  getIntegrations.mockResolvedValue({ integrations });
  const { backfillReadPolicyDefaults } = await import('../lib/read-policy-defaults');
  await backfillReadPolicyDefaults({ manifests });
}

beforeEach(() => {
  vi.resetModules();
  getIntegrations.mockReset();
  setReadPolicy.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('backfillReadPolicyDefaults', () => {
  const gmail = { id: 'gmail', readPolicy: { defaultAgeDays: 30 } };

  it('fills an integration that has no window yet', async () => {
    await backfill([gmail], [{ id: 'gmail', readAgeDays: null }]);
    expect(setReadPolicy).toHaveBeenCalledWith('gmail', 30);
  });

  it('fills when the field is absent entirely', async () => {
    await backfill([gmail], [{ id: 'gmail' }]);
    expect(setReadPolicy).toHaveBeenCalledWith('gmail', 30);
  });

  it('leaves an explicitly chosen window alone', async () => {
    await backfill([gmail], [{ id: 'gmail', readAgeDays: 7 }]);
    expect(setReadPolicy).not.toHaveBeenCalled();
  });

  it('NEVER overwrites 0 — "read nothing" is a choice, not a gap', async () => {
    // The dangerous one: a truthiness check would treat 0 as missing and
    // silently widen the agent's reach from nothing to 30 days, at startup,
    // with no user action.
    await backfill([gmail], [{ id: 'gmail', readAgeDays: 0 }]);
    expect(setReadPolicy).not.toHaveBeenCalled();
  });

  it('does not invent a window for integrations whose manifest declares none', async () => {
    // Calendar/CRM read by resource, not age — a default would be meaningless.
    await backfill([{ id: 'calendar' }], [{ id: 'calendar', readAgeDays: null }]);
    expect(setReadPolicy).not.toHaveBeenCalled();
  });

  it('ignores a malformed default rather than persisting it', async () => {
    const bad = [
      { id: 'x', readPolicy: { defaultAgeDays: -1 } },
      { id: 'x', readPolicy: { defaultAgeDays: 1.5 } },
      { id: 'x', readPolicy: { defaultAgeDays: '30' } },
    ];
    for (const m of bad) {
      setReadPolicy.mockReset();
      await backfill([m], [{ id: 'x', readAgeDays: null }]);
      expect(setReadPolicy).not.toHaveBeenCalled();
    }
  });

  it('does not throw when the gateway is unreachable', async () => {
    // Startup must never be blocked by this; a missing default degrades to the
    // signed grant bound, which still enforces a window.
    getIntegrations.mockRejectedValue(new Error('ECONNREFUSED'));
    const { backfillReadPolicyDefaults } = await import('../lib/read-policy-defaults');
    await expect(backfillReadPolicyDefaults({ manifests: [gmail] })).resolves.toBeUndefined();
  });
});
