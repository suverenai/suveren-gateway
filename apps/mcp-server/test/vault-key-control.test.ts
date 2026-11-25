/**
 * The MCP server's side of a vault-key change, through the handlers
 * bin/http.ts serves (/internal/rekey, /internal/key-state, /internal/configure)
 * with the real stores. The control plane decides which key to configure from
 * what the server reports, never from its own record.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GateStore, type GateEntry } from '../src/lib/gate-store';
import { DenialLog } from '../src/lib/denial-log';
import { VaultKeyControl, keyFingerprint } from '../src/lib/vault-key-control';
import { rekeyDirectory } from '../src/lib/rekey';

const entry = (id: string): GateEntry => ({
  authorizationId: id, path: 'email@0.4', profileId: 'email@0.4',
  gateContent: { intent: 'secret intent' }, storedAt: new Date().toISOString(),
});
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'vkc-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function server(dir: string) {
  const gates = new GateStore(dir);
  const denials = new DenialLog(dir);
  const control = new VaultKeyControl(dir, [gates, denials]);
  return { gates, denials, control };
}
const hex = (k: Buffer) => k.toString('hex');
const keys = () => ({ oldKey: randomBytes(32), newKey: randomBytes(32) });
const seed = (s: ReturnType<typeof server>, key: Buffer) => {
  s.control.setKey(key);
  s.gates.set('a1', entry('a1')); s.gates.set('a2', entry('a2'));
  s.denials.record({ ts: Date.now(), tool: 't', integrationId: 'mail', profile: null, detail: 'd' });
};
const readable = (dir: string, key: Buffer) => {
  const s = server(dir); s.control.setKey(key);
  return { gates: s.gates.getAll().length, denials: s.denials.getRecent().length };
};

describe('/internal/key-state', () => {
  it('says which key the stores are sealed with and which is in memory, by fingerprint, never the key', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir);
    expect(s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) }).body.sealedWith).toBe('empty');
    seed(s, oldKey);
    const r = s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(r.body).toEqual({ sealedWith: 'old', inMemory: 'old', fingerprint: keyFingerprint(oldKey) });
    expect(JSON.stringify(r.body)).not.toContain(hex(oldKey));
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) }).body).toMatchObject({ sealedWith: 'new', inMemory: 'new' });
  });

  it('refuses malformed keys', () => {
    expect(server(tmp()).control.state({ oldKeyHex: 'zz', newKeyHex: 'zz' }).status).toBe(400);
    expect(server(tmp()).control.rekey({}).status).toBe(400);
  });
});

describe('/internal/rekey', () => {
  it('re-seals every store, switches them, and nothing reads as empty with the new key', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    const r = s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(r.status).toBe(200);
    expect(readable(dir, newKey)).toEqual({ gates: 2, denials: 1 });
    expect(readable(dir, oldKey)).toEqual({ gates: 0, denials: 0 });
  });

  it('is idempotent: a second run (the reply was lost and the control plane asks again) changes nothing', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    const before = readFileSync(join(dir, 'gates.enc.json'), 'utf-8');
    const again = s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(again.body).toMatchObject({ reSealed: 0 });
    expect(readFileSync(join(dir, 'gates.enc.json'), 'utf-8')).toBe(before);
    expect(readable(dir, newKey)).toEqual({ gates: 2, denials: 1 });
  });

  it('resumes after a partial run: one file already on the new key, one still on the old', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    // a run that died after the first file
    rekeyDirectory(dir, oldKey, newKey, { only: ['denials.enc.json'] });
    expect(s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) }).body.sealedWith).toBe('mixed');
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) }).body.sealedWith).toBe('new');
    expect(readable(dir, newKey)).toEqual({ gates: 2, denials: 1 });
  });

  it('re-seals the copies a store set aside (*.enc.json.corrupt-*), so the old key opens nothing', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    writeFileSync(join(dir, 'gates.enc.json.corrupt-123'), readFileSync(join(dir, 'gates.enc.json')));
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    const g = new GateStore(dir);
    // the set-aside copy opens with the new key, not the old
    const copy = readFileSync(join(dir, 'gates.enc.json.corrupt-123'), 'utf-8');
    writeFileSync(join(dir, 'gates.enc.json'), copy);
    g.setVaultKey(newKey);
    expect(g.getAll()).toHaveLength(2);
    const stale = new GateStore(dir); stale.setVaultKey(oldKey);
    expect(stale.getAll()).toHaveLength(0);
    expect(readdirSync(dir).some(n => n.includes('.corrupt-'))).toBe(true); // kept, not deleted
  });

  it('leaves the control plane\'s own files alone', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    const mine = JSON.stringify({ version: 1, credentials: {}, verifier: { iv: 'aa', ciphertext: 'bb', tag: 'cc' } });
    writeFileSync(join(dir, 'vault.enc.json'), mine);
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });
    expect(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).toBe(mine);
  });
});

describe('the lost-reply case, with the control plane deciding from state', () => {
  it('the re-key was applied and the reply lost: state says new, so the new key is the one to configure; nothing is lost', () => {
    const dir = tmp(); const { oldKey, newKey } = keys();
    const s = server(dir); seed(s, oldKey);
    s.control.rekey({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) });       // applied; the reply is lost
    const st = s.control.state({ oldKeyHex: hex(oldKey), newKeyHex: hex(newKey) }).body;
    expect(st.sealedWith).toBe('new');
    s.control.setKey(st.sealedWith === 'new' ? newKey : oldKey);               // configure with what the server reports
    s.gates.set('a3', entry('a3'));
    expect(readable(dir, newKey).gates).toBe(3);
  });
});
