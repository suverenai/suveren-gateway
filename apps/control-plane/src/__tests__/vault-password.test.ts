/**
 * PasswordUnsealProvider (device-keys plan step 5): scrypt with parameters in
 * the vault header, a vault key wrapped by the password key, a vault from the
 * last released gateway moved to the password with everything intact.
 *
 * Low scrypt cost (N=1024) keeps the suite fast; one test pins the default.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, DEFAULT_SCRYPT_PARAMS } from '../lib/vault';
import { rekeyDirectory, sealedWith, CONTROL_PLANE_FILES } from '../lib/rekey';
import type { McpRekeyClient } from '../lib/vault';

/** The MCP server's side of the contract, on a folder (shared with the vault here): what it reports and what it re-seals. */
function folderClient(dir: string, behaviour: { failRekey?: boolean; applyThenFail?: boolean; failState?: boolean } = {}): McpRekeyClient & { rekeyCalls: number } {
  const c = {
    rekeyCalls: 0,
    async state(o: string, n: string) {
      if (behaviour.failState) throw new Error('unreachable');
      return { sealedWith: sealedWith(dir, Buffer.from(o, 'hex'), Buffer.from(n, 'hex'), { skip: CONTROL_PLANE_FILES }) };
    },
    async rekey(o: string, n: string) {
      c.rekeyCalls++;
      if (behaviour.failRekey) throw new Error('mcp down');
      rekeyDirectory(dir, Buffer.from(o, 'hex'), Buffer.from(n, 'hex'), { skip: CONTROL_PLANE_FILES });
      if (behaviour.applyThenFail) throw new Error('reply lost');
    },
  };
  return c;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'vault-password-'));
const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const header = (dir: string) => JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8'));

/** What today's released gateway leaves behind: a vault opened by the account key, with a credential and another sealed store. */
async function legacyVault(dir: string) {
  const v = new Vault(dir, FAST);
  await v.deriveAndSetKey('hap_account_key');
  v.setCredential('gmail', { token: 'secret-token-1' });
  v.setCredential('crm', { key: 'secret-2' });
  // A store the MCP server writes with the vault key (mandates, tickets, ...).
  writeFileSync(join(dir, 'mandates.enc.json'), JSON.stringify({ items: [v.encrypt('a-mandate')] }));
  return v;
}

describe('Vault password', () => {
  it('stores scrypt parameters and a wrapped key in the header, never the password or the key', async () => {
    const dir = tmp();
    const v = await legacyVault(dir);
    const keyHex = v.getVaultKeyHex();
    await v.setPassword('correct horse battery', 'u1');
    const raw = readFileSync(join(dir, 'vault.enc.json'), 'utf-8');
    const h = header(dir).password;
    expect(h).toMatchObject({ v: 1, kdf: 'scrypt', N: 1024, r: 8, p: 1 });
    expect(h.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain('correct horse battery');
    expect(raw).not.toContain(keyHex);
  });

  it('uses a costly default (N=2^17, r=8) so a stolen vault file is expensive to guess against', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it('a vault made by today\'s gateway opens with the account key, moves to the password, and opens after a restart with the password only, every credential and store intact', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const keyBefore = old.getVaultKeyHex();
    const store = JSON.parse(readFileSync(join(dir, 'mandates.enc.json'), 'utf-8')).items[0];
    // The MCP server (sharing the folder) re-seals ITS files when asked; the vault
    // re-seals only its own and never touches the MCP server's before it confirms.
    const client = folderClient(dir);
    const realRekey = client.rekey;
    client.rekey = async (o, n) => {
      expect(JSON.parse(readFileSync(join(dir, 'mandates.enc.json'), 'utf-8')).items[0]).toEqual(store); // untouched so far
      await realRekey(o, n);
    };
    const moved = await old.setPassword('correct horse battery', 'u1', client);
    expect(moved.outcome).toBe('done');

    // restart
    const v = new Vault(dir, FAST);
    expect(v.isUnlocked()).toBe(false);
    expect(v.hasPassword()).toBe(true);
    expect(await v.unlockWithPassword('correct horse battery')).toBe(true);
    expect(v.unsealedByProvider()).toBe('password');
    expect(v.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect(v.getCredential('crm')).toEqual({ key: 'secret-2' });
    expect(v.getVaultKeyHex()).not.toBe(keyBefore);       // a fresh random key, not the account-derived one
    const resealed = JSON.parse(readFileSync(join(dir, 'mandates.enc.json'), 'utf-8')).items[0];
    expect(resealed).not.toEqual(store);
    expect(v.decrypt(resealed)).toBe('a-mandate');        // every other sealed store was re-sealed under it
  });

  it('a wrong password is refused and leaves the vault locked', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1');
    const v = new Vault(dir, FAST);
    expect(await v.unlockWithPassword('wrong password!!')).toBe(false);
    expect(v.isUnlocked()).toBe(false);
    expect(await v.verifyPassword('wrong password!!')).toBe(false);
  });

  it('changing the password re-wraps one key: the new password opens, the old one does not, credentials are byte-identical', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1');
    const credsBefore = JSON.stringify(header(dir).credentials);
    const wrapBefore = header(dir).password.wrapped.ciphertext;

    const v = new Vault(dir, FAST);
    expect(await v.changePassword('not the password', 'another long password')).toBe(false);
    expect(await v.changePassword('correct horse battery', 'another long password')).toBe(true);

    expect(JSON.stringify(header(dir).credentials)).toBe(credsBefore);
    expect(header(dir).password.wrapped.ciphertext).not.toBe(wrapBefore);

    const after = new Vault(dir, FAST);
    expect(await after.unlockWithPassword('correct horse battery')).toBe(false);
    expect(await after.unlockWithPassword('another long password')).toBe(true);
    expect(after.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect(after.getCredential('crm')).toEqual({ key: 'secret-2' });
  });

  it('a new vault gets a random key (not derived from the password) and opens only with the password', async () => {
    const a = new Vault(tmp(), FAST);
    const b = new Vault(tmp(), FAST);
    await a.createWithPassword('same password here', 'u1');
    await b.createWithPassword('same password here', 'u1');
    expect(a.getVaultKeyHex()).not.toBe(b.getVaultKeyHex());
    a.setCredential('x', { k: 'v' });
    const dir = (a as unknown as { dataDir: string }).dataDir;
    const again = new Vault(dir, FAST);
    expect(await again.unlockWithPassword('same password here')).toBe(true);
    expect(again.getCredential('x')).toEqual({ k: 'v' });
  });

  it('refuses to make a password vault over data it would make unreadable', async () => {
    const dir = tmp();
    await legacyVault(dir);
    await expect(new Vault(dir, FAST).createWithPassword('some long password', 'u1')).rejects.toThrow();
  });

  it('refuses to set a password while locked, or twice', async () => {
    const dir = tmp();
    await expect(new Vault(dir, FAST).setPassword('some long password', 'u1')).rejects.toThrow();
    const v = await legacyVault(dir);
    await v.setPassword('some long password', 'u1');
    await expect(v.setPassword('another long password', 'u1')).rejects.toThrow();
  });

  it('a vault header with absurd scrypt parameters is refused, not run', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1');
    const h = header(dir);
    h.password.N = 1 << 24;
    writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(h));
    expect(await new Vault(dir, FAST).unlockWithPassword('correct horse battery')).toBe(false);
  });

  it('a vault without a password reports none and behaves as before (the account key is the way in)', async () => {
    const dir = tmp();
    const v = await legacyVault(dir);
    expect(v.hasPassword()).toBe(false);
    expect(v.validateApiKey('hap_account_key')).toBe(true);
  });

  it('tells listeners when it locks, from any reason', async () => {
    const v = await legacyVault(tmp());
    let n = 0;
    v.onLocked(() => n++);
    v.lockExpired();
    expect(n).toBe(1);
  });

  it('the account key no longer opens anything after the move: it derives a key nothing is sealed with', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1');
    const v = new Vault(dir, FAST);
    const viaAccountKey = await v.deriveCandidateFromApiKey('hap_account_key');
    expect(v.keyMatch(viaAccountKey)).toBe('conflict');
    v.adopt(viaAccountKey);
    expect(() => v.getCredential('gmail')).toThrow();
    // not a single sealed blob on disk opens with the account-derived key
    const raw = readFileSync(join(dir, 'vault.enc.json'), 'utf-8');
    expect(raw).not.toContain('secret-token-1');
  });

  it('refuses to set a password when the account is unknown', async () => {
    const v = await legacyVault(tmp());
    await expect(v.setPassword('correct horse battery', null)).rejects.toThrow(/Account unknown/);
    await expect(v.setPassword('correct horse battery', undefined)).rejects.toThrow(/Account unknown/);
    expect(v.hasPassword()).toBe(false);
    await expect(new Vault(tmp(), FAST).createWithPassword('correct horse battery', '')).rejects.toThrow(/Account unknown/);
  });

  it('the account binding is part of what the wrap authenticates: stripping or changing it breaks the unwrap', async () => {
    for (const edit of [(h: Record<string, unknown>) => { delete h.accountId; }, (h: Record<string, unknown>) => { h.accountId = 'attacker'; }]) {
      const dir = tmp();
      const old = await legacyVault(dir);
      await old.setPassword('correct horse battery', 'u1');
      const f = JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8'));
      edit(f.password);
      writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(f));
      const v = new Vault(dir, FAST);
      expect(await v.unlockWithPassword('correct horse battery')).toBe(false);
      expect(v.isUnlocked()).toBe(false);
      expect(v.hasPassword()).toBe(true); // and never "no password"
    }
  });

  it('fails closed: a password header that is present but invalid, or a vault file that cannot be read, is a password vault that does not open', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1');
    const file = join(dir, 'vault.enc.json');
    const good = readFileSync(file, 'utf-8');

    const f = JSON.parse(good); f.password.kdf = 'x'; writeFileSync(file, JSON.stringify(f));
    expect(new Vault(dir, FAST).hasPassword()).toBe(true);
    const v = new Vault(dir, FAST);
    expect(await v.unlockWithPassword('correct horse battery')).toBe(false);

    writeFileSync(file, '{ not json');
    expect(new Vault(dir, { ...FAST, deviceKeys: true }).hasPassword()).toBe(true);
    // with the feature off, today's behaviour: an unreadable file counts as an empty vault
    expect(new Vault(dir, FAST).hasPassword()).toBe(false);
  });

  it('a move the MCP server has not confirmed stays pending and is finished later; nothing is lost', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const oldHex = old.getVaultKeyHex();
    const moved = await old.setPassword('correct horse battery', 'u1', folderClient(dir, { failRekey: true }));
    expect(moved.outcome).toBe('pending');
    expect(moved.mcpKeyHex).toBe(oldHex); // the OLD key: its files still fit it
    expect(header(dir).password.pending).toBeDefined();

    // restart, unlock: the marker is found and finished
    const v = new Vault(dir, FAST);
    expect(await v.unlockWithPassword('correct horse battery')).toBe(true);
    expect(v.hasPendingRekey()).toBe(true);
    const client = folderClient(dir);
    const r = await v.reconcileRekey(client);
    expect(r.outcome).toBe('done');
    expect(r.mcpKeyHex).toBe(v.getVaultKeyHex());
    expect(v.hasPendingRekey()).toBe(false);
    expect(header(dir).password.pending).toBeUndefined();
    expect(v.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('the MCP server applied the re-key but the reply was lost: it is configured with the NEW key, not the old', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const oldHex = old.getVaultKeyHex();
    const moved = await old.setPassword('correct horse battery', 'u1', folderClient(dir, { applyThenFail: true }));
    // the reply was lost, but what the server reports is the truth
    expect(moved.outcome).toBe('done');
    expect(moved.mcpKeyHex).toBe(old.getVaultKeyHex());
    expect(moved.mcpKeyHex).not.toBe(oldHex);
  });

  it('when what the MCP server is sealed with cannot be determined, nothing is configured', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const moved = await old.setPassword('correct horse battery', 'u1', folderClient(dir, { failState: true }));
    expect(moved.outcome).toBe('pending');
    expect(moved.mcpKeyHex).toBeNull();
  });

  it('a partial run (mixed) that cannot be resumed configures nothing; once resumed, the new key', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const oldKey = Buffer.from(old.getVaultKeyHex(), 'hex');
    // a second MCP file, so one can be on the new key and one on the old
    writeFileSync(join(dir, 'denials.enc.json'), JSON.stringify({ items: [old.encrypt('d')] }));
    const moved = await old.setPassword('correct horse battery', 'u1', {
      state: async (o, n) => ({ sealedWith: sealedWith(dir, Buffer.from(o, 'hex'), Buffer.from(n, 'hex'), { skip: CONTROL_PLANE_FILES }) }),
      rekey: async (o, n) => { rekeyDirectory(dir, Buffer.from(o, 'hex'), Buffer.from(n, 'hex'), { only: ['mandates.enc.json'] }); throw new Error('died halfway'); },
    });
    expect(oldKey).toBeDefined();
    expect(moved.outcome).toBe('pending');
    expect(moved.mcpKeyHex).toBeNull();
    const resumed = await old.reconcileRekey(folderClient(dir));
    expect(resumed.outcome).toBe('done');
    expect(resumed.mcpKeyHex).toBe(old.getVaultKeyHex());
  });

  it('locks with a visible reason after repeated failed attempts, and never hands out a key meanwhile', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    await old.setPassword('correct horse battery', 'u1', folderClient(dir, { failState: true }));
    const v = new Vault(dir, FAST);
    await v.unlockWithPassword('correct horse battery');
    const bad = folderClient(dir, { failState: true });
    expect((await v.reconcileRekey(bad)).outcome).toBe('pending');
    expect((await v.reconcileRekey(bad)).outcome).toBe('pending');
    const third = await v.reconcileRekey(bad);
    expect(third).toEqual({ outcome: 'locked', mcpKeyHex: null });
    expect(v.isUnlocked()).toBe(false);
    expect(v.getLockedReason()).toBe('rekey-incomplete');
  });

  it('when the move is complete the account key opens nothing: not the vault, not a set-aside copy, and the PBKDF2 salt is gone', async () => {
    const dir = tmp();
    const old = await legacyVault(dir);
    const oldKey = Buffer.from(old.getVaultKeyHex(), 'hex');
    const sealedBlob = JSON.parse(readFileSync(join(dir, 'mandates.enc.json'), 'utf-8')).items[0];
    writeFileSync(join(dir, 'mandates.enc.json.corrupt-1700000000000'), JSON.stringify({ items: [sealedBlob] }));
    expect(header(dir).salt).toBeDefined();
    const moved = await old.setPassword('correct horse battery', 'u1', folderClient(dir));
    expect(moved.outcome).toBe('done');
    expect(header(dir).salt).toBeUndefined();

    // every sealed blob on disk, in every *.enc.json* file, must refuse the account-derived key
    const { createDecipheriv } = await import('node:crypto');
    const opensWithOld = (b: { iv: string; ciphertext: string; tag: string }) => {
      try {
        const d = createDecipheriv('aes-256-gcm', oldKey, Buffer.from(b.iv, 'hex'));
        d.setAuthTag(Buffer.from(b.tag, 'hex')); d.update(Buffer.from(b.ciphertext, 'hex')); d.final(); return true;
      } catch { return false; }
    };
    const walk = (v: unknown): number => {
      if (!v || typeof v !== 'object') return 0;
      const o = v as Record<string, unknown>;
      if (typeof o.iv === 'string' && typeof o.ciphertext === 'string' && typeof o.tag === 'string') return opensWithOld(o as never) ? 1 : 0;
      return Object.values(o).reduce<number>((n, c) => n + walk(c), 0);
    };
    const files = readdirSync(dir).filter(n => /\.enc\.json(\.corrupt-\d+)?$/.test(n));
    expect(files).toContain('mandates.enc.json.corrupt-1700000000000');
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (parsed.password) delete parsed.password; // the header wraps the NEW key under the password
      expect(walk(parsed), f).toBe(0);
    }
  });

  it('two parallel calls to set the password cannot both go ahead', async () => {
    const v = await legacyVault(tmp());
    const results = await Promise.allSettled([
      v.setPassword('correct horse battery', 'u1'),
      v.setPassword('another long password', 'u1'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it('every write of vault.enc.json is atomic: a write that cannot complete leaves the file as it was', async () => {
    const { mkdirSync } = await import('node:fs');
    const dir = tmp();
    const v = await legacyVault(dir);
    const before = readFileSync(join(dir, 'vault.enc.json'), 'utf-8');
    // the temp file cannot be created (its name is taken by a folder): a direct write would still succeed
    mkdirSync(join(dir, 'vault.enc.json.tmp'));
    expect(() => v.setCredential('late', { k: 'v' })).toThrow();
    expect(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).toBe(before);
    expect(() => v.deleteCredential('gmail')).toThrow();
    expect(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).toBe(before);
  });
});
