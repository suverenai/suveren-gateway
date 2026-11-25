import { describe, it, expect, vi } from 'vitest';
import { objectHash } from '@hap/core/device-keys';
import { pendingOf, readPendingPasskeys, approvePasskey, type PasskeyDeps } from './passkey-approve';
import { CheckError } from './check';

const NOW = 1_800_000_000;
const row = (o: Record<string, unknown> = {}) => ({ request_id: 'R'.repeat(22), cred_id: 'credX', rp_id: 'suveren.ai', code: '482913', created_at: NOW - 30, credential_at: NOW - 20, expires_at: NOW + 500, account: { email: 'owner@dev.local', name: 'Owner' }, ...o });

function deps(list: unknown[], o: { checkFails?: boolean; asAnswer?: { ok: boolean; code?: string; data?: unknown } } = {}) {
  const sent: unknown[] = [];
  const prove = vi.fn(async (_cred: string, hash: string) => { if (o.checkFails) throw new CheckError('failed'); return { hash } as never; });
  const d = {
    keys: { sign: async () => new Uint8Array(64) },
    check: { prove },
    api: {
      pendingPasskeys: async () => ({ ok: true, data: { pending: list } }),
      approvePasskey: async (body: unknown) => { sent.push(body); return o.asAnswer ?? { ok: true, data: { registered: true, cred_id: 'credX' } }; },
    },
    accounts: { read: async () => ({ root_did: 'did:key:root', key_id: 'k1', check: { rp_id: 'approve.suveren.ai', cred_id: 'phonecred' } }) },
    session: { bearer: () => 'b', current: () => ({ chain: { head: { seq: 3, hash: 'sha256:' + 'a'.repeat(64) } } }), noteUse: () => {} },
    now: () => NOW,
  } as unknown as PasskeyDeps;
  return { d, sent, prove };
}

describe('dashboard passkey on the phone', () => {
  it('only well-formed, unexpired entries of the list are kept', () => {
    expect(pendingOf(row(), NOW)).toMatchObject({ requestId: 'R'.repeat(22), code: '482913', email: 'owner@dev.local' });
    for (const bad of [row({ code: '12345' }), row({ request_id: 'short' }), row({ expires_at: NOW }), row({ rp_id: 'Bad Host' }), row({ account: null }), null, 'x']) expect(pendingOf(bad, NOW)).toBeNull();
  });

  it('approves exactly what the Authority Server lists: one touch over that object, signed, sent once', async () => {
    const { d, sent, prove } = deps([row()]);
    const [item] = await readPendingPasskeys(d);
    expect(await approvePasskey(d, item)).toBeNull();
    expect(sent).toHaveLength(1);
    const reg = (sent[0] as { register: Record<string, unknown> }).register;
    expect(reg).toEqual({ typ: 'suveren-passkey-register', v: 1, root_did: 'did:key:root', key_id: 'k1', chain_seq: 3, chain_head: 'sha256:' + 'a'.repeat(64), request_id: 'R'.repeat(22), cred_id: 'credX', rp_id: 'suveren.ai', issued_at: NOW });
    expect(prove).toHaveBeenCalledTimes(1);
    expect(prove.mock.calls[0][1]).toBe(await objectHash(reg as never));
  });

  it('a request no longer listed is refused before the touch; a failed touch sends nothing', async () => {
    const gone = deps([]);
    expect(await approvePasskey(gone.d, pendingOf(row(), NOW)!)).toBe('passkey_request_gone');
    expect(gone.prove).not.toHaveBeenCalled();
    const failed = deps([row()], { checkFails: true });
    expect(await approvePasskey(failed.d, pendingOf(row(), NOW)!)).toBe('check_failed');
    expect(failed.sent).toEqual([]);
  });

  it('the Authority Server\'s refusal comes back as its code', async () => {
    const { d } = deps([row()], { asAnswer: { ok: false, code: 'PASSKEY_REQUEST_USED' } });
    expect(await approvePasskey(d, pendingOf(row(), NOW)!)).toBe('PASSKEY_REQUEST_USED');
  });
});
