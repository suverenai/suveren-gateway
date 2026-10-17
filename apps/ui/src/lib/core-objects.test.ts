import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import type { ExecutionReceipt, IntegrationManifest } from './sp-client';
import type { AreaCatalogEntry } from './area';
import {
  parseTicketFilter, matchesTicketFilter, areaName, ageLabel, waitingLabel, deadlineLabel,
  shortTicketId, isToday, groupAutomatic, mandatesAtWork, nearLimit,
} from './core-objects';

const catalog: AreaCatalogEntry[] = [{ id: 'x/customers@0.10', name: 'Customers' }];

const NOW = new Date(2026, 9, 16, 10, 0, 0).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);

function receipt(over: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    id: 'abcd-1234-efgh',
    groupId: 'g',
    userId: 'u',
    attestationHash: 'h',
    authorizationId: 'authz_1',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/customers@0.10',
    path: 'customers',
    action: 'crm__create_contact',
    executionContext: { action_type: 'write' },
    cumulativeState: { daily: { amount: 0, count: 1 }, monthly: { amount: 0, count: 1 } },
    timestamp: sec(NOW - 60_000),
    signature: 's',
    ...over,
  };
}

const manifests = [
  {
    id: 'crm', name: 'CRM',
    toolGating: { overrides: { create_contact: { actionLabel: 'Contact created' } } },
  },
] as unknown as IntegrationManifest[];

const profile = {
  boundsSchema: {
    fields: {
      write_daily_max: { boundType: { kind: 'cumulative_count', window: 'daily', appliesTo: ['write'] } },
    },
  },
} as unknown as AgentProfile;

describe('ticket filter', () => {
  it('parses only known values; unknown shows all', () => {
    expect(parseTicketFilter('automatic')).toBe('automatic');
    expect(parseTicketFilter('approved')).toBe('approved');
    expect(parseTicketFilter('bogus')).toBe('all');
    expect(parseTicketFilter(null)).toBe('all');
  });
  it('automatic = no proposal id; approved = has one', () => {
    const auto = receipt({});
    const appr = receipt({ proposalId: 'p1' });
    expect(matchesTicketFilter(auto, 'automatic')).toBe(true);
    expect(matchesTicketFilter(appr, 'automatic')).toBe(false);
    expect(matchesTicketFilter(appr, 'approved')).toBe(true);
    expect(matchesTicketFilter(auto, 'all') && matchesTicketFilter(appr, 'all')).toBe(true);
  });
});

describe('object line parts', () => {
  // UI spec §13.1/§13.2 (2026-10-17): area is always the profile's own name
  // — never the mandate's title any more (that moved to ObjectLine's
  // separate "Mandate: …" line, see lib/area.ts `showMandateLine`).
  it('area = the profile\'s name, regardless of any mandate', () => {
    expect(areaName('x/customers@0.10', catalog)).toBe('Customers');
    expect(areaName('x/customers@0.9', catalog)).toBe('Customers'); // same family, older grant
  });
  it('ages and waiting time', () => {
    expect(ageLabel(NOW - 20_000, NOW)).toBe('just now');
    expect(ageLabel(NOW - 5 * 60_000, NOW)).toBe('5 min');
    expect(ageLabel(NOW - 2 * 3600_000, NOW)).toBe('2 h');
    expect(ageLabel(NOW - 49 * 3600_000, NOW)).toBe('2 days');
    expect(waitingLabel(sec(NOW - 5 * 60_000), NOW)).toBe('waiting 5 min');
  });
  it('deadline only inside the last 24 h, never once expired', () => {
    expect(deadlineLabel(sec(NOW + 48 * 3600_000), NOW)).toBeNull();
    expect(deadlineLabel(sec(NOW - 1000), NOW)).toBeNull();
    expect(deadlineLabel(sec(NOW + 3 * 3600_000), NOW, 'en-GB')).toMatch(/^Decide by .+ — otherwise it won't run$/);
  });
  it('short ticket id', () => {
    expect(shortTicketId('abcd-1234-efgh')).toBe('abcd1234');
  });
  it('today is the local calendar day', () => {
    expect(isToday(sec(NOW - 60_000), NOW)).toBe(true);
    expect(isToday(sec(NOW - 24 * 3600_000), NOW)).toBe(false);
  });
});

describe('groupAutomatic', () => {
  it('skips approved tickets, groups per mandate + action, new groups first', () => {
    const lastSeen = NOW - 10 * 60_000;
    const groups = groupAutomatic(
      [
        receipt({ id: 'a1', timestamp: sec(NOW - 60 * 60_000) }),
        receipt({ id: 'a2', timestamp: sec(NOW - 5 * 60_000) }),
        receipt({ id: 'p1', proposalId: 'prop', timestamp: sec(NOW - 2 * 60_000) }),
        receipt({ id: 'b1', authorizationId: 'authz_2', timestamp: sec(NOW - 30 * 60_000) }),
      ],
      { catalog, manifests, lastSeenMs: lastSeen },
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ area: 'Customers', system: 'CRM', label: 'Contact created', count: 2, newCount: 1 });
    expect(groups[0].tickets.map((t) => t.id)).toEqual(['a2', 'a1']);
    expect(groups[1]).toMatchObject({ area: 'Customers', count: 1, newCount: 0 });
  });
});

describe('mandatesAtWork', () => {
  it('same-second tickets: the higher running count is the newest', () => {
    const ts = sec(NOW - 60_000);
    const list = mandatesAtWork(
      [
        receipt({ id: 'x3', timestamp: ts, cumulativeState: { daily: { amount: 0, count: 3 }, monthly: { amount: 0, count: 3 } } }),
        receipt({ id: 'x2', timestamp: ts, cumulativeState: { daily: { amount: 0, count: 2 }, monthly: { amount: 0, count: 2 } } }),
      ].reverse(),
      { nowMs: NOW, catalog, manifests, boundsOf: () => ({ write_daily_max: 20 }), profileOf: () => profile },
    );
    expect(list[0]).toMatchObject({ used: 3, limit: 20 });
  });

  it('only mandates with a ticket today; usage from the newest; closest to the limit first', () => {
    const list = mandatesAtWork(
      [
        receipt({ authorizationId: 'authz_1', timestamp: sec(NOW - 120_000), cumulativeState: { daily: { amount: 0, count: 17 }, monthly: { amount: 0, count: 40 } } }),
        receipt({ authorizationId: 'authz_1', timestamp: sec(NOW - 60_000), cumulativeState: { daily: { amount: 0, count: 18 }, monthly: { amount: 0, count: 41 } } }),
        receipt({ authorizationId: 'authz_2', timestamp: sec(NOW - 60_000), cumulativeState: { daily: { amount: 0, count: 3 }, monthly: { amount: 0, count: 3 } } }),
        receipt({ authorizationId: 'authz_3', timestamp: sec(NOW - 30 * 3600_000) }),
      ],
      {
        nowMs: NOW,
        catalog,
        manifests,
        boundsOf: (id) => (id === 'authz_1' ? { write_daily_max: 20 } : { write_daily_max: 10 }),
        profileOf: () => profile,
      },
    );
    expect(list.map((m) => m.authorizationId)).toEqual(['authz_1', 'authz_2']);
    expect(list[0]).toMatchObject({ area: 'Customers', used: 18, limit: 20 });
    expect(nearLimit(list[0])).toBe(true);
    expect(nearLimit(list[1])).toBe(false);
  });
});
