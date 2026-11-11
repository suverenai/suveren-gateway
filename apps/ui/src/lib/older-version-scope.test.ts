import { describe, it, expect } from 'vitest';
import { loadOlderVersionItems } from './older-version-scope';
import type { PendingItem } from './sp-client';

// Made-up area with other field names than any shipped profile: nothing depends on Email.
const fields = {
  rooms: { displayName: 'Bookable rooms' },
  buildings: { displayName: 'Bookable buildings' },
};
const bounds = { fields: { book_daily_max: { boundType: { kind: 'cumulative_count' }, appliesTo: ['book'] } } };
const V1 = { id: 'x/venue@1', name: 'Venue', version: '1', boundsSchema: bounds, scopeSchema: { fields } };
const V2 = { id: 'x/venue@2', name: 'Venue', version: '2', boundsSchema: bounds, scopeSchema: { fields, atLeastOne: [{ fields: ['rooms', 'buildings'], requiredFor: ['book'] }] } };

function item(id: string, profile_id: string, frame: Record<string, string | number>): PendingItem {
  return { authorization_id: id, profile_id, title: `Mandate ${id}`, frame } as unknown as PendingItem;
}

function reader(scopes: Record<string, Record<string, string> | null>) {
  const read: string[] = [];
  return {
    read,
    r: {
      listProfiles: async () => [{ id: V1.id }, { id: V2.id }] as never,
      getProfile: async (id: string) => (id === V1.id ? V1 : V2),
      getGateContent: async (id: string) => { read.push(id); return scopes[id] === null ? null : { context: scopes[id] }; },
    },
  };
}

describe('the dashboard line for an open mandate under an older version', () => {
  it('points out an older mandate that sets none of the group while it allows the action', async () => {
    const { r } = reader({ a: {}, b: { rooms: 'r1' }, c: {} });
    const items = await loadOlderVersionItems([
      item('a', V1.id, { book_daily_max: 3 }),
      item('b', V1.id, { book_daily_max: 3 }),
      item('c', V1.id, { book_daily_max: 0 }),
      item('d', V2.id, { book_daily_max: 3 }),
    ], r);
    expect(items).toEqual([{
      authorizationId: 'a',
      label: 'Older version',
      detail: 'Mandate a names no bookable room or building. Venue 2 requires one: open it under Mandates and press Edit to replace it.',
    }]);
  });

  it('says nothing about a mandate whose scope this gateway does not hold', async () => {
    const { r } = reader({ a: null });
    expect(await loadOlderVersionItems([item('a', V1.id, { book_daily_max: 3 })], r)).toEqual([]);
  });
});
