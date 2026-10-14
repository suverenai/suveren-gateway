import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The control-plane-facing half of the live-badge fix: every call to
 * DenialLog.record() — read or write, local or Authority-Server-refused —
 * must tell the control plane exactly once, with the one payload-free event
 * type, and must never let that ping affect the denial itself. See
 * cp-notify.ts ("presence, never content") and
 * apps/control-plane/src/routes/internal-events.ts (the allowlist this event
 * must clear on the other end).
 */
vi.mock('../src/lib/cp-notify', () => ({
  notifyControlPlane: vi.fn().mockResolvedValue(undefined),
}));

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'denial-log-notify-')); dirs.push(d); return d; }
afterEach(() => { vi.clearAllMocks(); for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

describe('DenialLog.record — notifies the control plane', () => {
  it('fires denial-recorded exactly once per record() call', async () => {
    const { notifyControlPlane } = await import('../src/lib/cp-notify');
    const { DenialLog } = await import('../src/lib/denial-log');
    const log = new DenialLog(tmp());

    log.record({ ts: Date.now(), tool: 'get_message', integrationId: 'gmail', profile: 'email', reason: 'age', detail: 'old' });

    expect(notifyControlPlane).toHaveBeenCalledTimes(1);
    expect(notifyControlPlane).toHaveBeenCalledWith('denial-recorded');
  });

  it('fires once per denial, not once per gateway session — N records, N pings', async () => {
    const { notifyControlPlane } = await import('../src/lib/cp-notify');
    const { DenialLog } = await import('../src/lib/denial-log');
    const log = new DenialLog(tmp());

    for (let i = 0; i < 3; i++) {
      log.record({ ts: Date.now() + i, tool: 'create_contact', integrationId: 'crm', profile: 'customers', kind: 'scope', detail: 'blocked' });
    }

    expect(notifyControlPlane).toHaveBeenCalledTimes(3);
    for (const call of (notifyControlPlane as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call).toEqual(['denial-recorded']);
    }
  });

  it('still records (and persists) the denial even though notifyControlPlane is fire-and-forget', async () => {
    const { DenialLog } = await import('../src/lib/denial-log');
    const dir = tmp();
    const log = new DenialLog(dir);
    log.record({ ts: Date.now(), tool: 'get_message', integrationId: 'gmail', profile: 'email', reason: 'age', detail: 'old' });
    expect(log.size).toBe(1);
  });
});
