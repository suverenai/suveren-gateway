/**
 * After a mandate change whose old mandate could not be revoked at the
 * Authority Server: when the gateway has stopped honouring the old one locally,
 * the change is reported as done (not as a failed action), with the approved
 * wording. Only when the local stop also failed does it stay an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cp = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('../../cp-mandate', () => ({ controlPlaneMandate: vi.fn(async () => cp.result) }));
vi.mock('../../mandate-change', async (orig) => ({
  ...(await orig<typeof import('../../mandate-change')>()),
  readSignedMandate: () => ({ old: { authorizationId: 'authz_old' }, short: 'sales', authorization: {} }),
}));

import { setupBuiltin } from '../setup';
import type { BuiltinDeps } from '../index';
import { loadProfiles } from '../../profile-loader';

// The built-ins read their read gate from their own profile when they are built.
loadProfiles();

function changeHandler() {
  const b = setupBuiltin({} as unknown as BuiltinDeps);
  const tool = b.tools.find((t) => t.name === 'change_mandate');
  if (!tool) throw new Error('change_mandate missing');
  return (args: Record<string, unknown>) => tool.handler(args);
}

describe('change_mandate — old mandate not yet revoked at the AS', () => {
  beforeEach(() => { cp.result = {}; });

  it('stopped locally: reported as done, with the approved words, not an error', async () => {
    cp.result = { ok: true, authorizationId: 'authz_new', profileId: 'sales@1.0', groupName: 'Personal', mode: 'review', revokeError: 'status 503', oldStoppedLocally: true };
    const r = await changeHandler()({ mandate_id: 'authz_old' });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    const text = (r as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('The change is in place. The old mandate is no longer used on this computer. It will be ended on suveren.ai as soon as possible.');
    expect(text).not.toMatch(/still live/);
  });

  it('not stopped locally either: still an error that names the old mandate as live', async () => {
    cp.result = { ok: true, authorizationId: 'authz_new', profileId: 'sales@1.0', groupName: 'Personal', mode: 'review', revokeError: 'status 503' };
    const r = await changeHandler()({ mandate_id: 'authz_old' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((r as { content: Array<{ text: string }> }).content[0].text).toMatch(/still live with its old limits/);
  });
});


