/**
 * Registry side of "a connector replaced by another" (manifest `replaces`).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { planReplacement, configFromManifest } from '../src/lib/connector-replacement';
import { loadManifests, getManifest } from '../src/lib/manifest-loader';
import type { IntegrationConfig } from '../src/lib/integration-registry';

loadManifests(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations'));
const mail = getManifest('mail')!;
const cfg = (over: Partial<IntegrationConfig>): IntegrationConfig => ({
  id: 'x', name: 'x', command: 'c', args: [], envKeys: {}, profile: 'email', enabled: true, ...over,
});

describe('configFromManifest(mail)', () => {
  const c = configFromManifest(mail);
  it('the Google token does not block a start under the test mailbox (optional env), the rest maps as Activate does', () => {
    expect(c.envKeys).toEqual({});
    expect(c.optionalEnvKeys).toMatchObject({
      EMAIL_MODE: 'mail.mode', EMAIL_LIVE_ADAPTER: 'mail.liveAdapter', CLIENT_ID: 'mail.clientId',
      CLIENT_SECRET: 'mail.clientSecret', REFRESH_TOKEN: 'mail.refreshToken',
    });
    expect(c.command).toBe('email-mcp');
    expect(c.npmPackage).toBe('@humanagencyp/email-mcp');
    expect(c.enabled).toBe(true);
  });
  it('carries a given read window, else the manifest default', () => {
    expect(configFromManifest(mail, { readAgeDays: 7 }).readAgeDays).toBe(7);
    expect(configFromManifest(mail).readAgeDays).toBe(30);
  });
});

describe('planReplacement', () => {
  it('old enabled, replacement absent: remove old, add the replacement with the old read window', () => {
    const p = planReplacement([cfg({ id: 'gmail', readAgeDays: 14 })], mail, 'gmail', true);
    expect(p.removeOld).toBe(true);
    expect(p.targetAction).toBe('added');
    expect(p.add!.id).toBe('mail');
    expect(p.add!.readAgeDays).toBe(14);
  });
  it('old enabled, replacement present but off: remove old, switch the replacement on, keep its settings', () => {
    const p = planReplacement([cfg({ id: 'gmail' }), cfg({ id: 'mail', enabled: false, readAgeDays: 3 })], mail, 'gmail', true);
    expect(p).toEqual({ removeOld: true, targetAction: 'enabled' });
  });
  it('old enabled, replacement already on: only the old goes', () => {
    expect(planReplacement([cfg({ id: 'gmail' }), cfg({ id: 'mail' })], mail, 'gmail', true))
      .toEqual({ removeOld: true, targetAction: 'none' });
  });
  it('old disabled: only the old goes, nothing is switched on unasked', () => {
    expect(planReplacement([cfg({ id: 'gmail', enabled: false })], mail, 'gmail', true))
      .toEqual({ removeOld: true, targetAction: 'none' });
  });
  it('no credentials were moved: only the old goes', () => {
    expect(planReplacement([cfg({ id: 'gmail' })], mail, 'gmail', false)).toEqual({ removeOld: true, targetAction: 'none' });
  });
  it('old not registered: nothing happens (idempotent second run)', () => {
    expect(planReplacement([cfg({ id: 'mail' })], mail, 'gmail', true)).toEqual({ removeOld: false, targetAction: 'none' });
  });
});
