/**
 * The mode choice is derived from the SHIPPED manifests (content/integrations/*.json) — the same files the
 * gateway serves — so a manifest change that breaks the choice fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationManifest } from './sp-client';
import {
  oauthAppliesTo, modeOptions, currentOption, optionValues, choiceFieldKeys, splitFields, pausedTag, hasNoRealMode, NO_REAL_MODE_LINE,
} from './mode-choice';

const load = (id: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations', `${id}.json`), 'utf8')) as IntegrationManifest;
const crm = load('crm');
const erp = load('erp');
const mail = load('mail');

describe('modeOptions from the shipped manifests', () => {
  it('crm: Test data + On this computer, with the generic explanations', () => {
    const o = modeOptions(crm);
    expect(o.map(x => x.label)).toEqual(['Test data', 'On this computer']);
    expect(o[0]).toMatchObject({ key: 'simulation', mode: 'simulation', simulated: true, explanation: 'Practice data. Runs only while simulation mode is on.' });
    expect(o[1]).toMatchObject({ key: 'live:local', mode: 'live', adapter: 'local', simulated: false, explanation: 'Your own CRM data. Runs in production.' });
  });

  it('erp: the company file belongs to the local option only', () => {
    const o = modeOptions(erp);
    expect(o.map(x => x.label)).toEqual(['Test data', 'On this computer']);
    expect(o[0].fieldKeys).toEqual([]);
    expect(o[1].fieldKeys).toEqual(['companyFile']);
    expect(o[1].explanation).toBe('Your own ERP data. Runs in production.');
  });

  it('mail: Test mailbox + Gmail; the Gmail client fields belong to Gmail only', () => {
    const o = modeOptions(mail);
    expect(o.map(x => x.label)).toEqual(['Test mailbox', 'Gmail']);
    expect(o[1]).toMatchObject({ key: 'live:gmail', mode: 'live', adapter: 'gmail', simulated: false, fieldKeys: ['clientId', 'clientSecret'] });
    expect(hasNoRealMode(o)).toBe(false);
    expect(hasNoRealMode([o[0]])).toBe(true);
    expect(NO_REAL_MODE_LINE).toBe('This connector has no real mode. Disable it to use a real one.');
  });

  it('a manifest without simulation/modeLabels offers no choice', () => {
    expect(modeOptions({ name: 'X' })).toEqual([]);
  });

  it('a third option is added by the manifest alone', () => {
    const hub = {
      ...crm,
      modeLabels: { simulation: 'Test data', live: { local: 'Local', hubspot: 'HubSpot' } },
      modeOptions: { live: { local: { label: 'On this computer' }, hubspot: { label: 'HubSpot', explanation: 'Your HubSpot account.', fields: ['databaseUrl'] } } },
    } as IntegrationManifest;
    const o = modeOptions(hub);
    expect(o.map(x => x.key)).toEqual(['simulation', 'live:local', 'live:hubspot']);
    expect(o[2]).toMatchObject({ label: 'HubSpot', explanation: 'Your HubSpot account.', fieldKeys: ['databaseUrl'] });
    expect(optionValues(hub, o[2])).toEqual({ mode: 'live', liveAdapter: 'hubspot' });
  });
});

describe('what Save writes — from manifest keys, not typed', () => {
  it('simulation → mode=simulation only', () => {
    expect(optionValues(crm, modeOptions(crm)[0])).toEqual({ mode: 'simulation' });
  });
  it('local → mode=live + liveAdapter=local', () => {
    expect(optionValues(crm, modeOptions(crm)[1])).toEqual({ mode: 'live', liveAdapter: 'local' });
  });
  it('the choice fields are mode and adapter', () => {
    expect(choiceFieldKeys(erp)).toEqual(['mode', 'liveAdapter']);
    expect(choiceFieldKeys(mail)).toEqual(['mode', 'liveAdapter']);
  });
});

describe('recognising saved values', () => {
  it('unset mode → the manifest default (Test data)', () => {
    expect(currentOption(crm, {})?.key).toBe('simulation');
    expect(currentOption(crm, undefined)?.key).toBe('simulation');
  });
  it('old hand-typed live + local, any case/spacing → On this computer', () => {
    expect(currentOption(crm, { mode: 'live', liveAdapter: 'local' })?.key).toBe('live:local');
    expect(currentOption(erp, { mode: ' Live ', liveAdapter: ' LOCAL ' })?.key).toBe('live:local');
  });
  it('simulation with a leftover adapter is still Test data', () => {
    expect(currentOption(crm, { mode: 'simulation', liveAdapter: 'local' })?.key).toBe('simulation');
  });
  it('live without an adapter, or an unknown mode, matches nothing', () => {
    expect(currentOption(crm, { mode: 'live' })).toBeUndefined();
    expect(currentOption(crm, { mode: 'live', liveAdapter: 'sap' })).toBeUndefined();
    expect(currentOption(crm, { mode: 'banana' })).toBeUndefined();
  });
  it('mail: unset or simulation → its only option', () => {
    expect(currentOption(mail, {})?.key).toBe('simulation');
  });
});

describe('field visibility per option', () => {
  const keys = (fs: { key: string }[]) => fs.map(f => f.key);
  it('erp, Test data: no company file, everything optional under Advanced, mode/adapter never shown', () => {
    const p = splitFields(erp, currentOption(erp, {}));
    expect(keys(p.main)).toEqual([]);
    expect(keys(p.optionFields)).toEqual([]);
    expect(keys(p.hidden)).toEqual(['companyFile']);
    expect(keys(p.advanced)).toEqual(['databaseUrl', 'invoiceTemplate', 'quoteTemplate', 'viesCheck', 'viesUrl']);
  });
  it('erp, On this computer: the company file appears', () => {
    const p = splitFields(erp, currentOption(erp, { mode: 'live', liveAdapter: 'local' }));
    expect(keys(p.optionFields)).toEqual(['companyFile']);
    expect(keys(p.hidden)).toEqual([]);
    expect(keys(p.advanced)).not.toContain('companyFile');
  });
  it('crm: only the database URL, under Advanced', () => {
    const p = splitFields(crm, currentOption(crm, {}));
    expect(keys(p.advanced)).toEqual(['databaseUrl']);
    expect(p.main).toEqual([]);
  });
  it('mail: database URL under Advanced; the Gmail client fields only while Gmail is chosen', () => {
    expect(keys(splitFields(mail, currentOption(mail, {})).advanced)).toEqual(['databaseUrl']);
    expect(keys(splitFields(mail, currentOption(mail, {})).hidden)).toEqual(['clientId', 'clientSecret']);
    const gm = splitFields(mail, currentOption(mail, { mode: 'live', liveAdapter: 'gmail' }));
    expect(keys(gm.optionFields)).toEqual(['clientId', 'clientSecret']);
  });
  it('a connector with no mode choice keeps all its fields as they were', () => {
    const plain = { name: 'X', credentials: { fields: [{ key: 'a', label: 'A', type: 'text' as const }], envMapping: {} } };
    expect(keys(splitFields(plain, undefined).main)).toEqual(['a']);
  });
});

describe('the paused tags mirror each other', () => {
  const [sim, live] = modeOptions(crm);
  it('production: the practice option is paused', () => {
    expect(pausedTag(sim, false)).toBe('Paused in production');
    expect(pausedTag(live, false)).toBeNull();
  });
  it('simulation: the real option is paused', () => {
    expect(pausedTag(sim, true)).toBeNull();
    expect(pausedTag(live, true)).toBe('Paused in simulation');
  });
});

describe('oauthAppliesTo — the sign-in belongs to the chosen data source', () => {
  const calendar = load('calendar');
  it('mail: no sign-in for the test mailbox (unset, simulation, or an unrecognised mode)', () => {
    expect(oauthAppliesTo(mail, currentOption(mail, {}))).toBe(false);
    expect(oauthAppliesTo(mail, currentOption(mail, { mode: 'simulation' }))).toBe(false);
    expect(oauthAppliesTo(mail, currentOption(mail, { mode: 'live' }))).toBe(false); // adapter missing: nothing chosen yet
  });
  it('mail: sign-in with Google for Gmail only (case and spaces as the card reads them)', () => {
    expect(oauthAppliesTo(mail, currentOption(mail, { mode: 'live', liveAdapter: 'gmail' }))).toBe(true);
    expect(oauthAppliesTo(mail, currentOption(mail, { mode: ' LIVE ', liveAdapter: 'Gmail' }))).toBe(true);
  });
  it('a connector without forOption always has its sign-in; one without OAuth never', () => {
    expect(oauthAppliesTo(calendar, currentOption(calendar, {}))).toBe(true);
    expect(oauthAppliesTo(crm, currentOption(crm, { mode: 'live', liveAdapter: 'local' }))).toBe(false);
  });
});
