/**
 * Codes on screen read by the names a person knows — from the manifests and the
 * profile catalog the gateway serves, by what the profile declares about a
 * field. Made-up connectors, kinds and areas throughout: no name may be built in.
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import type { ChangeRow, MandateDiff } from '@hap/core/mandate-change';
import { connectorName, scopeValueName, scopeValueNames } from './display-names';
import { blockedView, sourceLineText } from './blocked-view';
import { valueName, rowMeaning, staysLines } from './mandate-change-view';
import { inTicket } from './ticket-what-was-done';
import type { DenialRecord } from './sp-client';

const MANIFESTS = [
  { id: 'vault', name: 'Document Vault', documents: { scan: { label: 'scanned page {id}', title: 'Scanned pages' } } },
  { id: 'helpdesk', name: 'Help Desk' },
];
const CATALOG = [
  { id: 'example.test/tickets@0.1', name: 'Old tickets' },
  { id: 'example.test/tickets@0.2', name: 'Support tickets' },
  { id: 'example.test/ledger@1.0', name: 'Bookkeeping' },
];
const SOURCES_FIELD = { displayName: 'Allowed sources', format: 'connector:kind' };
const AREAS_FIELD = { displayName: 'Areas it may propose', valuesFrom: 'profiles' };
const PLAIN_FIELD = { displayName: 'Allowed domains' };

describe('connectorName', () => {
  it("is the manifest's name; the id when no manifest names it", () => {
    expect(connectorName('helpdesk', MANIFESTS)).toBe('Help Desk');
    expect(connectorName('nobody', MANIFESTS)).toBe('nobody');
    expect(connectorName('helpdesk', undefined)).toBe('helpdesk');
  });
});

describe('scopeValueName — by what the profile declares about the field', () => {
  const src = { manifests: MANIFESTS, catalog: CATALOG };
  it('a document source by its manifest title', () => {
    expect(scopeValueName(SOURCES_FIELD, 'vault:scan', src)).toBe('Scanned pages');
    expect(scopeValueNames(SOURCES_FIELD, 'vault:scan,vault:other', src)).toBe('Scanned pages, vault:other');
  });
  it("an area by its newest profile's name", () => {
    expect(scopeValueNames(AREAS_FIELD, 'tickets,ledger', src)).toBe('Support tickets, Bookkeeping');
  });
  it('an undeclared field, or names still loading: the stored value', () => {
    expect(scopeValueName(PLAIN_FIELD, 'tickets', src)).toBe('tickets');
    expect(scopeValueName(AREAS_FIELD, 'tickets', {})).toBe('tickets');
    expect(scopeValueName(SOURCES_FIELD, 'vault:scan', {})).toBe('vault:scan');
  });
});

describe('Blocked page — a scope refusal names the value, the connector by its manifest', () => {
  const profile = {
    id: 'example.test/outbox@0.1',
    scopeSchema: { fields: { may_attach: SOURCES_FIELD, may_propose: AREAS_FIELD, allowed_domains: PLAIN_FIELD } },
  } as unknown as AgentProfile;
  const rec = (over: Partial<DenialRecord>): DenialRecord => ({
    ts: 1, tool: 'helpdesk__reply', integrationId: 'helpdesk', profile: profile.id, detail: 'd', kind: 'scope', ...over,
  });
  const names = { manifests: MANIFESTS, catalog: CATALOG };

  it('a document source: its title, not "connector:kind"', () => {
    expect(blockedView(rec({ field: 'may_attach', value: 'vault:scan' }), profile, undefined, names).sentence)
      .toBe('"Scanned pages" is not within your mandate\'s allowed sources.');
  });
  it('areas: their names', () => {
    expect(blockedView(rec({ field: 'may_propose', value: 'ledger' }), profile, undefined, names).sentence)
      .toBe('"Bookkeeping" is not within your mandate\'s areas it may propose.');
  });
  it('an address or domain stays as it is', () => {
    expect(blockedView(rec({ field: 'allowed_domains', value: 'x.example' }), profile, undefined, names).sentence)
      .toBe('"x.example" is not within your mandate\'s allowed domains.');
  });
  it('the source line names the connector by its manifest', () => {
    expect(sourceLineText(blockedView(rec({ field: 'allowed_domains', value: 'x' }), profile, undefined, names).sourceLine))
      .toMatch(/^Help Desk · helpdesk__reply/);
  });
});

describe('mandate change card — areas by name', () => {
  const row: ChangeRow = {
    section: 'scope', field: 'may_propose', label: 'Areas it may propose', before: 'tickets', after: 'tickets,ledger',
    tag: 'More', added: ['ledger'], removed: [], emptyMeans: 'anything', valuesFrom: 'profiles',
  };
  const names = { manifests: MANIFESTS, catalog: CATALOG };
  it('the added value and the sentence under the row', () => {
    expect(valueName(row, 'ledger', names)).toBe('Bookkeeping');
    expect(rowMeaning(row, names)).toBe('This allows more than before: also Bookkeeping.');
  });
  it('"Stays the same" names the areas too', () => {
    const diff: MandateDiff = { rows: [], stays: [{ label: 'Areas it may propose', value: 'tickets,ledger', valuesFrom: 'profiles' }] };
    expect(staysLines(diff, names)).toEqual(['Areas it may propose: Support tickets, Bookkeeping']);
  });
  it('a plain manifest list (the older call shape) still names document sources', () => {
    expect(valueName({ format: 'connector:kind' }, 'vault:scan', MANIFESTS)).toBe('Scanned pages');
  });
});

describe('inTicket — an object item is read by the property the mapping declares', () => {
  it('`item` names the property; without it an object is not the signed value', () => {
    const guests = [{ address: 'a@x.example' }, { address: 'b@y.example' }];
    const ctx = { guests: 'a@x.example,b@y.example' };
    expect(inTicket(guests, { field: 'guests', transform: 'join', item: 'address' } as never, ctx)).toBe(true);
    expect(inTicket(guests, { field: 'guests', transform: 'join' }, ctx)).toBe(false);
  });
});
