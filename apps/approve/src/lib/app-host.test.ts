import { describe, it, expect, afterEach } from 'vitest';
import { encryptProposalContent } from '@hap/core';
import { bindPhoneHost, phoneHost } from './app-host';
import { FakeAs, registerPhone, testRuntime } from './test-kit';

afterEach(() => bindPhoneHost(null));

async function bound() {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  await registerPhone(rt, as);
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('session');
  const account = (await rt.accounts.read())!;
  const keys = (await rt.keys.publicKeys())!;
  bindPhoneHost({ reader: rt.reader, keys: rt.keys, ownKeyId: account.key_id, userId: opened.session.user.id });
  return { as, rt, keys };
}

describe('the phone\'s side of the approval card\'s host seam', () => {
  it('fails visibly when the app is not signed in: it never serves a guess', async () => {
    await expect(phoneHost.data.decryptProposalContent({ ciphertext: 'x', keys: {} })).rejects.toThrow(/not signed in/);
    await expect(phoneHost.data.getProposal('p1')).rejects.toThrow(/not signed in/);
  });

  it('opens sealed content with this phone\'s own wrap', async () => {
    const { keys } = await bound();
    const args = { to: 'anna@example.com' };
    const { content, proposalContentHash } = await encryptProposalContent(args, [{ did: 'did:key:z6Mkowner', publicKey: keys.readPub }]);
    const wire = { ciphertext: content.ciphertext, keys: {}, device_keys: { [keys.keyId]: content.encrypted_keys['did:key:z6Mkowner'] }, proposalContentHash };
    const { plaintext } = await phoneHost.data.decryptProposalContent(wire as never);
    expect(JSON.parse(plaintext)).toEqual(args);
  });

  it('reads a proposal with the phone\'s session, and the card\'s own polling does not count as use', async () => {
    const { as, rt } = await bound();
    as.byId.set('p1', { id: 'p1', createdAt: 1, tool: 'x__y', status: 'pending' });
    as.clock += 3590;
    expect((await phoneHost.data.getProposal('p1')).id).toBe('p1');
    as.clock += 20;
    expect(rt.session.bearer()).toBeNull();
  });

  it('what only the gateway page knows is answered with a refusal or an empty list, never an invented value', async () => {
    await bound();
    const d = phoneHost.data;
    await expect(d.getProfile('x')).rejects.toBeTruthy();
    await expect(d.getProposalPreview('p')).rejects.toBeTruthy();
    await expect(d.getProposalRequestContext('p')).rejects.toBeTruthy();
    await expect(d.saveShownSnapshot('p', {} as never)).rejects.toBeTruthy();
    await expect(d.getMyReceiptsPage()).rejects.toBeTruthy();
    expect(await d.listProfiles()).toEqual([]);
    expect(await d.getIntegrationManifests()).toEqual({ manifests: [] });
    expect(await d.getAuthorizationUsage('a')).toBeNull();
    expect(phoneHost.useOpenMandateScreen()).toBeNull();
    expect(phoneHost.useSimulationMode()).toBeNull();
  });

  it('the session hook names the Personal domain once signed in', async () => {
    await bound();
    expect(phoneHost.useSession()).toEqual({ mode: 'personal', group: null, groupId: null, domain: 'user-1' });
  });
});
