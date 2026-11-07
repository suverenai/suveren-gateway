/**
 * A retired connector (gmail) replaced by another one (mail), driven by the
 * manifest's `replaces`. Vault-side logic with the registry call injected;
 * the manifests are the shipped files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReplacements, mergeReplacedCredentials, adoptableKeys, type ReplacementDeps, type ReplacerManifest } from '../lib/connector-replacement';

const load = (id: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations', `${id}.json`), 'utf8')) as ReplacerManifest;
const mail = load('mail');
const calendar = load('calendar');
const MANIFESTS = [mail, calendar]; // gmail is not offered any more

function world(vault: Record<string, Record<string, string>>, replace?: ReplacementDeps['replaceIntegration']) {
  const log: string[] = [];
  const calls: Array<{ from: string; to: string; enableTarget: boolean }> = [];
  const deps: ReplacementDeps = {
    getCredential: n => (vault[n] ? { ...vault[n] } : null),
    setCredential: (n, f) => { vault[n] = { ...f }; },
    deleteCredential: n => { delete vault[n]; },
    replaceIntegration: replace ?? (async (from, to, o) => { calls.push({ from, to, enableTarget: o.enableTarget }); return { removedOld: true, targetAction: 'added' }; }),
    log: m => log.push(m),
  };
  return { deps, log, calls, vault };
}

const OLD = {
  clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken',
  _oauthAccount: 'andreas@example.com', _oauthScopes: 'openid gmail.modify gmail.send', _oauthConnectedAt: '2026-10-01T00:00:00Z',
  somethingTheNewOneDoesNotKnow: 'x',
};

describe('migrating a signed-in gmail (Andreas\'s live gateway)', () => {
  it('moves client + token + sign-in metadata to mail, chooses Gmail, drops unknown keys, deletes the old entry', async () => {
    const w = world({ gmail: { ...OLD } });
    const r = await runReplacements(MANIFESTS, w.deps);
    expect(r).toEqual([{ from: 'gmail', to: 'mail', status: 'migrated' }]);
    expect(w.vault.mail).toEqual({
      clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken',
      _oauthAccount: 'andreas@example.com', _oauthScopes: 'openid gmail.modify gmail.send', _oauthConnectedAt: '2026-10-01T00:00:00Z',
      mode: 'live', liveAdapter: 'gmail',
    });
    expect(w.vault.gmail).toBeUndefined();
    expect(w.calls).toEqual([{ from: 'gmail', to: 'mail', enableTarget: true }]);
  });

  it('a mail entry that was set up before (test mailbox, own database) keeps its other settings and is switched to Gmail', async () => {
    const w = world({ gmail: { ...OLD }, mail: { mode: 'simulation', databaseUrl: 'postgres://x' } });
    await runReplacements(MANIFESTS, w.deps);
    expect(w.vault.mail).toMatchObject({ mode: 'live', liveAdapter: 'gmail', databaseUrl: 'postgres://x', refreshToken: 'rtoken' });
  });

  it('is a no-op the second time (old entry gone, registry already swapped)', async () => {
    const w = world({ gmail: { ...OLD } });
    await runReplacements(MANIFESTS, w.deps);
    const calls = w.calls.length;
    const w2 = world(w.vault, async () => ({ removedOld: false, targetAction: 'none' }));
    expect(await runReplacements(MANIFESTS, w2.deps)).toEqual([{ from: 'gmail', to: 'mail', status: 'nothing-to-do' }]);
    expect(w2.log).toEqual([]);
    expect(w.calls.length).toBe(calls);
  });

  it('FAILURE: when the registry swap fails the old entry stays, the failure is logged, and a retry then succeeds', async () => {
    const vault: Record<string, Record<string, string>> = { gmail: { ...OLD } };
    const w = world(vault, async () => { throw new Error('MCP server unreachable'); });
    const r = await runReplacements(MANIFESTS, w.deps);
    expect(r[0]).toMatchObject({ status: 'failed', detail: 'MCP server unreachable' });
    expect(vault.gmail).toEqual(OLD);
    expect(w.log[0]).toMatch(/FAILED.*untouched.*next sign-in/);
    const w2 = world(vault);
    expect((await runReplacements(MANIFESTS, w2.deps))[0].status).toBe('migrated');
    expect(vault.gmail).toBeUndefined();
    expect(vault.mail.refreshToken).toBe('rtoken');
  });

  it('only the registry entry, no credentials (gmail was never set up): the target is not enabled', async () => {
    const w = world({});
    await runReplacements(MANIFESTS, w.deps);
    expect(w.calls).toEqual([{ from: 'gmail', to: 'mail', enableTarget: false }]);
    expect(w.vault.mail).toBeUndefined();
  });

  it('a connector that is still offered under its id is never replaced', async () => {
    const w = world({ gmail: { ...OLD } });
    expect(await runReplacements([...MANIFESTS, { id: 'gmail' }], w.deps)).toEqual([]);
    expect(w.vault.gmail).toEqual(OLD);
  });

  it('never prints a credential value in the log', async () => {
    const w = world({ gmail: { ...OLD } });
    await runReplacements(MANIFESTS, w.deps);
    const text = w.log.join('\n');
    for (const v of ['rtoken', 'csecret', 'cid']) expect(text).not.toContain(v);
  });
});

describe('helpers', () => {
  it('adoptableKeys: fields, env-mapped keys, OAuth keys and _oauth* metadata only', () => {
    const adopt = adoptableKeys(mail);
    for (const k of ['clientId', 'clientSecret', 'refreshToken', 'mode', 'liveAdapter', '_oauthAccount']) expect(adopt(k), k).toBe(true);
    expect(adopt('somethingTheNewOneDoesNotKnow')).toBe(false);
  });
  it('mergeReplacedCredentials: old values win over existing, set wins over both', () => {
    expect(mergeReplacedCredentials(mail, { clientId: 'old', mode: 'simulation' }, { clientId: 'new', databaseUrl: 'd' }, { mode: 'live' }))
      .toEqual({ clientId: 'old', databaseUrl: 'd', mode: 'live' });
  });
});
