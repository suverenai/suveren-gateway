import { describe, it, expect } from 'vitest';
import { b64uEncode, entryHash, rootKeyFromRecoveryCode, verifyChain } from '@hap/core/device-keys';
import { JoinDriver } from './join-driver';
import { RotateDriver, codeMadeOn, confirmCodeOf, maskEmail, rotateOffered } from './rotate-driver';
import { errorText } from '../texts';
import { FakeAs, FakePasskeys, PeerAdmitter, PeerComputer, seedAccount, testRuntime, type TestRuntime } from './test-kit';

const pk = (rt: TestRuntime) => rt.check as FakePasskeys;
const driverOf = (rt: TestRuntime) => new RotateDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now });

/** An identity made on a computer (its recovery code shown there), and this phone joined to it, with an open session. */
async function joined() {
  const as = await FakeAs.create();
  const mac = await PeerComputer.create('Office Mac');
  const { recoveryCode } = await seedAccount(as, mac);
  const rt = testRuntime(as);
  const admitter = new PeerAdmitter(as, mac);
  await admitter.open();
  const join = new JoinDriver({ keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, now: rt.now });
  await join.scanned(admitter.qrText);
  join.confirmReview();
  await join.submitName('My iPhone');
  await admitter.step(); await join.poll(); await admitter.step(); await admitter.confirm(); await join.poll();
  expect(join.get()).toEqual({ step: 'done' });
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('session');
  return { as, rt, mac, recoveryCode, me: (await rt.accounts.read())!.key_id };
}

describe('replace the recovery code on the phone (DEC-85, mockup D1–D5)', () => {
  it('is offered to a phone that joined, says where the code was made, and goes away once this phone replaced it', async () => {
    const { as, rt, me, recoveryCode } = await joined();
    const s = rt.session.current()!;
    expect(rotateOffered(s.entries, s.chain, me)).toBe(true);
    expect(codeMadeOn(s.entries, s.chain)).toBe('Office Mac');

    const d = driverOf(rt);
    d.start();
    await d.submitOld(recoveryCode);
    const st = d.get();
    if (st.step !== 'new') throw new Error(st.step);
    await d.confirmNew(st.code);
    await as.confirmStaged();
    await d.poll();
    const after = rt.session.current()!;
    expect(rotateOffered(after.entries, after.chain, me)).toBe(false);
    expect(codeMadeOn(after.entries, after.chain)).toBe('My iPhone');
  });

  it('the whole way: old code, the new code once and typed again, one touch, the hand-off staged (nothing appended), the email confirmed, done', async () => {
    const { as, rt, me, recoveryCode } = await joined();
    const d = driverOf(rt);
    d.start();
    expect(d.get()).toEqual({ step: 'old', busy: false });
    await d.submitOld(recoveryCode);
    const st = d.get();
    expect(st.step).toBe('new');
    if (st.step !== 'new') return;
    expect(st.code).not.toBe(recoveryCode);
    const touches = pk(rt).proved.length;
    await d.confirmNew(st.code.toLowerCase());
    const waiting = d.get();
    expect(waiting.step).toBe('waiting');
    if (waiting.step !== 'waiting') return;
    expect(pk(rt).proved.length).toBe(touches + 1);
    // Nothing is appended before the email; the staged entry is a rotate-root the root key and this phone signed, checked by its touch.
    expect(as.entries).toHaveLength(2);
    const staged = as.staged[0];
    expect(staged).toMatchObject({ op: 'rotate-root', signer: 'root' });
    expect(staged.sigs.map((s) => s.by)).toEqual(['root', me]);
    expect(staged.checks.map((c) => c.by)).toEqual([me]);
    expect(waiting.confirmCode).toBe(await confirmCodeOf(await entryHash(staged)));
    expect(waiting.email).toBe(maskEmail('anna@example.com'));
    // The new code's root key is what the entry names.
    expect(staged.new_root).toBe(b64uEncode((await rootKeyFromRecoveryCode(st.code)).publicKey));
    // The codes never left the phone.
    expect(JSON.stringify(as.calls)).not.toContain(recoveryCode);
    expect(JSON.stringify(as.calls)).not.toContain(st.code);

    // Before the person confirms the link: still waiting.
    await d.poll();
    expect(d.get().step).toBe('waiting');
    await as.confirmStaged();
    await d.poll();
    expect(d.get()).toEqual({ step: 'done' });
    const state = await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    expect(state.root_pub).toBe(staged.new_root);
    // The done state holds no code.
    expect(JSON.stringify(d.get())).not.toContain(st.code);
  });

  it('a code that is not the account\'s, or not a code at all: said, nothing made', async () => {
    const { as, rt } = await joined();
    const d = driverOf(rt);
    d.start();
    await d.submitOld('not a code');
    expect(d.get()).toEqual({ step: 'old', busy: false, error: errorText('recovery_code_invalid') });
    const other = await FakeAs.create();
    const { recoveryCode: foreign } = await seedAccount(other, await PeerComputer.create('Elsewhere'));
    await d.submitOld(foreign);
    expect(d.get()).toEqual({ step: 'old', busy: false, error: errorText('recovery_code_wrong') });
    expect(as.staged).toHaveLength(0);
  });

  it('the new code typed wrong: said, no touch asked, nothing staged', async () => {
    const { as, rt, recoveryCode } = await joined();
    const d = driverOf(rt);
    d.start();
    await d.submitOld(recoveryCode);
    const st = d.get();
    if (st.step !== 'new') throw new Error(st.step);
    const touches = pk(rt).proved.length;
    await d.confirmNew(recoveryCode);
    expect(d.get()).toMatchObject({ step: 'new', code: st.code, error: errorText('new_code_mismatch') });
    expect(pk(rt).proved.length).toBe(touches);
    expect(as.staged).toHaveLength(0);
  });

  it('a cancelled touch: back to the new code, nothing staged', async () => {
    const { as, rt, recoveryCode } = await joined();
    const d = driverOf(rt);
    d.start();
    await d.submitOld(recoveryCode);
    const st = d.get();
    if (st.step !== 'new') throw new Error(st.step);
    pk(rt).cancelNext = true;
    await d.confirmNew(st.code);
    expect(d.get()).toMatchObject({ step: 'new', error: errorText('cancelled') });
    expect(as.staged).toHaveLength(0);
  });

  it('the hand-off runs out without the email: said, nothing changed', async () => {
    const { as, rt, recoveryCode } = await joined();
    const d = driverOf(rt);
    d.start();
    await d.submitOld(recoveryCode);
    const st = d.get();
    if (st.step !== 'new') throw new Error(st.step);
    await d.confirmNew(st.code);
    as.clock += 601;
    await d.poll();
    expect(d.get()).toEqual({ step: 'failed', error: errorText('handoff_expired') });
    expect(as.entries).toHaveLength(2);
  });

  it('a refused stage is said in words, never the code', async () => {
    const { as, rt, recoveryCode } = await joined();
    as.refuseStage = { status: 502, code: 'MAIL_FAILED' };
    const d = driverOf(rt);
    d.start();
    await d.submitOld(recoveryCode);
    const st = d.get();
    if (st.step !== 'new') throw new Error(st.step);
    await d.confirmNew(st.code);
    expect(d.get()).toEqual({ step: 'failed', error: errorText('mail_failed') });
  });

  it('the first device of an identity is not offered it (its code was made there)', async () => {
    const { rt, mac } = await joined();
    const s = rt.session.current()!;
    expect(rotateOffered(s.entries, s.chain, mac.keyId)).toBe(false);
  });

  it('maskEmail keeps the first letter and the domain', () => {
    expect(maskEmail('anna@example.com')).toBe('a•••@example.com');
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('@x')).toBeNull();
  });
});

describe('the six-digit code is the Authority Server\'s (its confirmCodeOf over the entry hash)', () => {
  it('matches the same computation done with node:crypto, for many hashes', async () => {
    const { createHash } = await import('node:crypto');
    for (let i = 0; i < 50; i++) {
      const h = 'sha256:' + createHash('sha256').update(String(i)).digest('hex');
      const d = createHash('sha256').update('suveren-recovery-confirm-v1\u0000', 'utf8').update(h, 'ascii').digest();
      expect(await confirmCodeOf(h)).toBe(String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0'));
    }
  });
});
