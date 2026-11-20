import { describe, it, expect } from 'vitest';
import { b64uEncode, buildPairingMessage, randomBytes } from '@hap/core/device-keys';
import { Mailbox, pairingKeysOf } from './mailbox';
import { AsApi } from './as-api';
import { FakeAs } from './test-kit';

async function box() {
  const as = await FakeAs.create();
  const keys = await pairingKeysOf({ secret: b64uEncode(randomBytes(32)) });
  as.mailboxes.set(keys.pairingId, { messages: [] });
  return { as, keys, mailbox: new Mailbox(new AsApi(as), keys) };
}

describe('the pairing mailbox from the phone\'s side', () => {
  it('derives the same ids from the same secret, and different ones from another', async () => {
    const secret = b64uEncode(randomBytes(32));
    const a = await pairingKeysOf({ secret });
    const b = await pairingKeysOf({ secret });
    expect(a.pairingId).toBe(b.pairingId);
    expect(b64uEncode(a.macKey)).toBe(b64uEncode(b.macKey));
    expect((await pairingKeysOf({ secret: b64uEncode(randomBytes(32)) })).pairingId).not.toBe(a.pairingId);
  });

  it('what is sent can be read back, with its MAC checked; the server stores the MAC, never the secret', async () => {
    const { as, keys, mailbox } = await box();
    expect(await mailbox.send('challenge', { r_a: b64uEncode(randomBytes(32)) })).toEqual({ ok: true });
    const r = await mailbox.poll();
    expect(r.ok && Object.keys(r.messages)).toEqual(['challenge']);
    const stored = JSON.stringify(as.mailboxes.get(keys.pairingId));
    expect(stored).not.toContain(b64uEncode(keys.macKey));
  });

  it('a message whose MAC is wrong, whose body has an extra member, or whose kind is unknown, stops the pairing', async () => {
    for (const bad of [
      { kind: 'challenge', body: { r_a: b64uEncode(randomBytes(32)) }, mac: b64uEncode(randomBytes(32)) },
      { kind: 'commit', body: { c: 'sha256:' + '0'.repeat(64), extra: 1 }, mac: b64uEncode(randomBytes(32)) },
      { kind: 'bogus', body: {}, mac: b64uEncode(randomBytes(32)) },
    ]) {
      const { as, keys, mailbox } = await box();
      as.mailboxes.get(keys.pairingId)!.messages.push(bad);
      expect(await mailbox.poll()).toEqual({ ok: false, code: 'bad_message' });
    }
  });

  it('a body changed after it was MACed is refused', async () => {
    const { as, keys, mailbox } = await box();
    const m = await buildPairingMessage(keys.macKey, 'challenge', { r_a: b64uEncode(randomBytes(32)) });
    as.mailboxes.get(keys.pairingId)!.messages.push({ ...m, body: { r_a: b64uEncode(randomBytes(32)) } });
    expect(await mailbox.poll()).toEqual({ ok: false, code: 'bad_message' });
  });

  it('a kind that appears twice is refused, even when both are valid', async () => {
    const { as, keys, mailbox } = await box();
    const a = await buildPairingMessage(keys.macKey, 'challenge', { r_a: b64uEncode(randomBytes(32)) });
    const b = await buildPairingMessage(keys.macKey, 'challenge', { r_a: b64uEncode(randomBytes(32)) });
    as.mailboxes.get(keys.pairingId)!.messages.push(a, b);
    expect(await mailbox.poll()).toEqual({ ok: false, code: 'bad_message' });
  });

  it('a mailbox that does not exist, and a server that cannot be reached, are told apart from a bad message', async () => {
    const { as, keys, mailbox } = await box();
    as.mailboxes.delete(keys.pairingId);
    expect(await mailbox.poll()).toEqual({ ok: false, code: 'mailbox_missing' });
    as.down = true;
    expect(await mailbox.poll()).toEqual({ ok: false, code: 'as_unreachable' });
  });
});
