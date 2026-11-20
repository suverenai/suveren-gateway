/** What the phone is shown of a change (lib/change-describe.ts): never a secret; old and new only for a `text` field of the manifest. */
import { describe, it, expect } from 'vitest';
import { describeChange } from '../lib/change-describe';

const M = [{ id: 'erp', name: 'ERP', credentials: { fields: [{ key: 'baseUrl', type: 'text', label: 'Address' }, { key: 'token', type: 'password' }] } }];
const stored = (v: Record<string, string> | null) => () => v;

describe('describeChange', () => {
  it('a services replacement: the text field old -> new, the secret field named only', () => {
    const d = describeChange('replace', 'erp', { route: 'services', op: 'put-replace', credentials: { baseUrl: 'https://b', token: 'tok-2' } }, M, stored({ baseUrl: 'https://a', token: 'tok-1' }));
    expect(d).toEqual({ connector: 'ERP', fields: [{ key: 'baseUrl', label: 'Address', secret: false, old: 'https://a', new: 'https://b' }, { key: 'token', secret: true }] });
    expect(JSON.stringify(d)).not.toContain('tok-');
  });

  it('an unknown connector: every field is a secret, the id is the name', () => {
    const d = describeChange('replace', 'other', { route: 'credentials', op: 'put-merge', fields: { a: 'x', b: 'y' } }, M, stored({ a: 'old' }));
    expect(d).toEqual({ connector: 'other', fields: [{ key: 'a', secret: true }, { key: 'b', secret: true }] });
  });

  it('a removal, an OAuth sign-in again, and the metadata key name no field; an unchanged text field is left out', () => {
    expect(describeChange('remove', 'erp', { route: 'credentials', op: 'delete' }, M, stored(null))!.fields).toEqual([]);
    expect(describeChange('replace', 'erp', { route: 'oauth', op: 'sign-in', integration: 'erp', group: null, replaces: ['erp'] }, M, stored(null))!.fields).toEqual([]);
    const d = describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: { __updatedAt: 'x', baseUrl: 'https://a' } }, M, stored({ baseUrl: 'https://a' }));
    expect(d!.fields).toEqual([]);
  });

  it('never a shortened view (L5): a value too long to show, too many fields, an unknown shape, an OAuth change that replaces other logins: null', () => {
    const long = 'x'.repeat(501);
    expect(describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: { baseUrl: long } }, M, stored(null))).toBeNull();
    expect(describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: { baseUrl: 'https://b' } }, M, stored({ baseUrl: long }))).toBeNull();
    expect(describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: { baseUrl: 7 } }, M, stored(null))).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, 'v']));
    expect(describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: many }, M, stored(null))).toBeNull();
    expect(describeChange('replace', 'erp', { route: 'something', op: 'new' }, M, stored(null))).toBeNull();
    expect(describeChange('replace', 'erp', null, M, stored(null))).toBeNull();
    expect(describeChange('replace', 'erp', { route: 'oauth', op: 'sign-in', integration: 'erp', group: 'g1', replaces: ['erp', 'crm'] }, M, stored(null))).toBeNull();
  });

  it('an unreadable store shows no old value', () => {
    const d = describeChange('replace', 'erp', { route: 'credentials', op: 'put-merge', fields: { baseUrl: 'https://b' } }, M, () => { throw new Error('locked'); });
    expect(d!.fields).toEqual([{ key: 'baseUrl', label: 'Address', secret: false, new: 'https://b' }]);
  });
});
