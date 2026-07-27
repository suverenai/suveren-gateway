import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Vault } from '../lib/vault';
import { loadDenials, selectDenials, type DenialRecordView } from '../lib/denials-reader';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'cp-denials-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const rec = (over: Partial<DenialRecordView> = {}): DenialRecordView => ({
  ts: Date.now(), tool: 'get_message', integrationId: 'gmail', profile: 'email',
  reason: 'age', detail: 'older than the 90-day window', ...over,
});

describe('loadDenials (control-plane reads what the MCP server wrote)', () => {
  it('returns [] when no file exists', () => {
    expect(loadDenials(tmp(), () => { throw new Error('should not decrypt'); })).toEqual([]);
  });

  it('reads a plaintext denials.json (vault-less fallback)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'denials.json'), JSON.stringify({ version: 1, records: [rec({ detail: 'x' })] }));
    expect(loadDenials(dir, () => { throw new Error('no'); })).toHaveLength(1);
  });

  it('CROSS-APP crypto: decrypts what the MCP-server scheme encrypted, via the control-plane Vault', async () => {
    const dir = tmp();
    // The vault key is PBKDF2(apiKey, salt) — derive it the same way the gateway does.
    const vault = new Vault(dir);
    await vault.deriveAndSetKey('test-api-key');
    const key = Buffer.from(vault.getVaultKeyHex(), 'hex');

    // Write denials.enc.json the way the MCP-server DenialLog would.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify({ version: 1, records: [rec({ detail: 'SENTINEL', target: 'Family', reason: 'resource' })] });
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    writeFileSync(join(dir, 'denials.enc.json'), JSON.stringify({
      version: 1, blob: { iv: iv.toString('hex'), ciphertext: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex') },
    }));

    const got = loadDenials(dir, blob => vault.decrypt(blob));
    expect(got).toHaveLength(1);
    expect(got[0].detail).toBe('SENTINEL');
    expect(got[0].target).toBe('Family');
  });
});

describe('selectDenials', () => {
  const recs = [rec({ ts: 1000 }), rec({ ts: 3000 }), rec({ ts: 2000 })];
  it('sorts newest-first and reports the full count', () => {
    const { count, records } = selectDenials(recs);
    expect(count).toBe(3);
    expect(records.map(r => r.ts)).toEqual([3000, 2000, 1000]);
  });
  it('applies since (ms) and reports pre-limit count', () => {
    const { count, records } = selectDenials(recs, { since: 2000 });
    expect(records.map(r => r.ts)).toEqual([3000, 2000]);
    expect(count).toBe(2);
  });
  it('applies limit but count is the full total', () => {
    const { count, records } = selectDenials(recs, { limit: 1 });
    expect(records.map(r => r.ts)).toEqual([3000]);
    expect(count).toBe(3);
  });
});
