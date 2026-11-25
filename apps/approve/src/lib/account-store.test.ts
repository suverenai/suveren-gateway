import { describe, it, expect } from 'vitest';
import { AccountStore, HeadRefusedError, type StoredAccount } from './account-store';
import { MemoryKv } from './kv';

const h = (c: string) => 'sha256:' + c.repeat(64);
const account = (): StoredAccount => ({
  v: 1, as_url: 'https://as.test', as_key: 'a'.repeat(64), root_did: 'did:key:z6Mkx', key_id: 'k'.repeat(43), label: 'My iPhone',
  head: { seq: 3, hash: h('1') }, check: { rp_id: 'approve.test', cred_id: 'cred' }, paired_at: 1,
});

describe('the stored account (public facts only)', () => {
  it('writes once, reads back, and refuses a second write: a phone that is paired does not pair again', async () => {
    const s = new AccountStore(new MemoryKv());
    expect(await s.read()).toBeNull();
    await s.write(account());
    expect(await s.read()).toEqual(account());
    await expect(s.write(account())).rejects.toThrow();
  });

  it('the head only moves forward; a lower one is a rollback, the same number with another hash a fork', async () => {
    const s = new AccountStore(new MemoryKv());
    await s.write(account());
    await s.advance({ seq: 3, hash: h('1') });
    await s.advance({ seq: 4, hash: h('2') });
    expect((await s.read())!.head).toEqual({ seq: 4, hash: h('2') });
    await expect(s.advance({ seq: 3, hash: h('1') })).rejects.toMatchObject({ reason: 'rollback' });
    await expect(s.advance({ seq: 4, hash: h('9') })).rejects.toBeInstanceOf(HeadRefusedError);
    await expect(s.advance({ seq: 4, hash: h('9') })).rejects.toMatchObject({ reason: 'fork' });
    expect((await s.read())!.head).toEqual({ seq: 4, hash: h('2') });
  });

  it('a record that is there but not what this code wrote is an error, never "not paired"', async () => {
    const kv = new MemoryKv();
    await kv.set('account', { v: 2 });
    await expect(new AccountStore(kv).read()).rejects.toThrow();
  });

  it('holds no secret: nothing in the record looks like a key, a code or a token', async () => {
    const kv = new MemoryKv();
    const s = new AccountStore(kv);
    await s.write(account());
    expect(Object.keys((await kv.get('account')) as object).sort()).toEqual(['as_key', 'as_url', 'check', 'head', 'key_id', 'label', 'paired_at', 'root_did', 'v']);
  });

  it('says once that the app was updated, the first time a new build starts', async () => {
    const s = new AccountStore(new MemoryKv());
    expect(await s.buildChanged('abc')).toBe(false); // first ever start
    expect(await s.buildChanged('abc')).toBe(false);
    expect(await s.buildChanged('def')).toBe(true);
    expect(await s.buildChanged('def')).toBe(false);
  });

  it('clear forgets the account', async () => {
    const s = new AccountStore(new MemoryKv());
    await s.write(account());
    await s.clear();
    expect(await s.read()).toBeNull();
  });
});
