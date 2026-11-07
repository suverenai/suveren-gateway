/**
 * /vault routes with a shared sign-in group, over real HTTP with a real Vault.
 * Only the MCP bridge is replaced (it is the wire to the other process); what
 * the control plane PUSHES to it is what these tests assert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const pushed: Array<[string, Record<string, string>]> = [];
const oauth = (scopes: string[]) => ({
  authUrl: 'a', tokenUrl: 't', scopes,
  credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' },
  tokenStorage: 'refreshToken',
  signInGroup: { id: 'google', name: 'Google' },
});
const MANIFESTS = [
  { id: 'gmail', credentials: { fields: [{ key: 'clientId', type: 'text' }, { key: 'clientSecret', type: 'password' }] }, oauth: oauth(['m']) },
  { id: 'calendar', credentials: { fields: [{ key: 'clientId', type: 'text' }, { key: 'clientSecret', type: 'password' }] }, oauth: oauth(['c']) },
];
vi.mock('../lib/mcp-bridge', () => ({
  getManifests: async () => ({ manifests: MANIFESTS }),
  pushServiceCredentials: async (id: string, c: Record<string, string>) => { pushed.push([id, c]); },
}));

import { Vault } from '../lib/vault';
import { createVaultRouter } from '../routes/vault';

let dir: string; let vault: Vault; let srv: Server; let base: string;

beforeEach(async () => {
  pushed.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'vault-group-'));
  vault = new Vault(dir);
  await vault.deriveAndSetKey('test-key-not-a-secret');
  const app = express();
  app.use('/vault', express.json(), createVaultRouter(vault));
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/vault/credentials`;
});
afterEach(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });

const put = (name: string, body: object) =>
  fetch(`${base}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('shared sign-in group in the vault routes', () => {
  it('saving only the group client settings (no token yet) pushes nothing: members have no sign-in to run on', async () => {
    expect((await put('sign-in:google', { clientId: 'cid', clientSecret: 'csecret' })).status).toBe(200);
    expect(pushed).toEqual([]);
  });

  it('an unknown group is refused', async () => {
    expect((await put('sign-in:nope', { clientId: 'x' })).status).toBe(404);
  });

  it('MIGRATION: a member with its own token keeps it until the group holds a token', async () => {
    vault.setCredential('gmail', { clientId: 'old', clientSecret: 'os', refreshToken: 'old-gmail-token' });
    await put('sign-in:google', { clientId: 'new', clientSecret: 'ns' });
    const gm = pushed.filter(([id]) => id === 'gmail').at(-1)![1];
    expect(gm.refreshToken).toBe('old-gmail-token');
    expect(gm.clientId).toBe('old');
  });

  it('a group token reaches every member, including one with no entry of its own', async () => {
    vault.setCredential('sign-in:google', { clientId: 'g', clientSecret: 'gs', refreshToken: 'group-token' });
    await put('sign-in:google', { _note: 'touch' });
    const byId = Object.fromEntries(pushed);
    expect(byId.gmail.refreshToken).toBe('group-token');
    expect(byId.calendar.refreshToken).toBe('group-token');
  });

  it('GET of a member shows it connected through the group, hints only (never the token)', async () => {
    vault.setCredential('sign-in:google', { clientId: 'g', clientSecret: 'gs', refreshToken: 'group-token-value-1234567890' });
    const body = await (await fetch(`${base}/calendar`)).json() as { configured: boolean; secrets: Record<string, unknown>; fields: Record<string, string> };
    expect(body.configured).toBe(true);
    expect(Object.keys(body.secrets)).toContain('refreshToken');
    expect(JSON.stringify(body)).not.toContain('group-token-value-1234567890');
    expect(body.fields.clientId).toBe('g');
  });

  it('changing the group client drops its token: it was issued to the old client', async () => {
    vault.setCredential('sign-in:google', { clientId: 'old', clientSecret: 'os', refreshToken: 'tok', _oauthAccount: 'a@b.c' });
    await put('sign-in:google', { clientId: 'new', clientSecret: 'ns' });
    const g = vault.getCredential('sign-in:google')!;
    expect(g.clientId).toBe('new');
    expect(g.refreshToken).toBeUndefined();
    expect(g._oauthAccount).toBeUndefined();
  });

  it('dry run says "this signs the group out" and changes nothing', async () => {
    vault.setCredential('sign-in:google', { clientId: 'old', clientSecret: 'os', refreshToken: 'tok' });
    const r = await fetch(`${base}/sign-in%3Agoogle?dryRun=1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'new' }) });
    expect(await r.json()).toEqual({ ok: true, dryRun: true, signsOut: true, members: ['gmail', 'calendar'] });
    expect(vault.getCredential('sign-in:google')).toEqual({ clientId: 'old', clientSecret: 'os', refreshToken: 'tok' });
    expect(pushed).toEqual([]);
  });

  it('dry run for an unchanged client says it does not sign out', async () => {
    vault.setCredential('sign-in:google', { clientId: 'same', clientSecret: 'ss', refreshToken: 'tok' });
    const r = await fetch(`${base}/sign-in%3Agoogle?dryRun=1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'same' }) });
    expect((await r.json() as { signsOut: boolean }).signsOut).toBe(false);
  });

  it('the real save reports signedOut', async () => {
    vault.setCredential('sign-in:google', { clientId: 'old', clientSecret: 'os', refreshToken: 'tok' });
    expect(await (await put('sign-in:google', { clientId: 'new' })).json()).toEqual({ ok: true, signedOut: true });
    expect(await (await put('sign-in:google', { clientId: 'new' })).json()).toEqual({ ok: true, signedOut: false });
  });

  it('re-saving the same client keeps the token', async () => {
    vault.setCredential('sign-in:google', { clientId: 'same', clientSecret: 'ss', refreshToken: 'tok' });
    await put('sign-in:google', { clientId: 'same', clientSecret: 'ss' });
    expect(vault.getCredential('sign-in:google')!.refreshToken).toBe('tok');
  });
});
