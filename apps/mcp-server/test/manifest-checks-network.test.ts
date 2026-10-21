/**
 * Load-time validation of the three generic manifest features from the ERP
 * local-production contract §7.2: D1 `checks`, D2 preview `when` (+ the
 * `displayOnly` read flag, amendment AM1), D3 top-level `network`. Each bad
 * shape refuses the manifest with a reason, like every other loader check.
 */
import { describe, it, expect } from 'vitest';
import { invalidChecksReason, invalidPreviewReason, invalidNetworkReason } from '../src/lib/manifest-loader';

const good = { key: 'k', label: 'A check', path: 'uid.vies.status', pass: ['valid'], fail: ['invalid'] };
const checks = (...list: unknown[]) => ({ checks: list });

describe('checks validation', () => {
  it('accepts both forms, forEach paths, {#} and [] inside placeholders', () => {
    expect(invalidChecksReason('t', checks(good))).toBeNull();
    expect(invalidChecksReason('t', checks({ ...good, blocking: true }))).toBeNull();
    expect(invalidChecksReason('t', checks({
      key: 'lp', label: 'Line price', forEach: 'lines', when: 'lines[].item_id', path: 'lines[].unit_price',
      compare: { op: 'eq', to: 'lines[].item.list_price' }, onTrue: 'pass', onFalse: 'notice',
      detail: 'line {#}: {lines[].unit_price|money}[ — {lines[].item.list_price|money}]',
    }))).toBeNull();
    expect(invalidChecksReason('t', checks({ key: 'n', label: 'n', path: 'x', compare: { op: 'gt', to: 0 } }))).toBeNull();
    expect(invalidChecksReason('t', checks({ ...good, when: { path: 'customer_id.tax_mode', in: ['reverse_charge'] } }))).toBeNull();
  });

  it.each([
    [{ ...good, colour: 'red' }, /unknown key "colour"/],
    [{ ...good, path: 'a..b' }, /invalid path/],
    [{ ...good, path: 'lines[].x' }, /forEach is not "lines"/],
    [{ key: 'k', label: 'l', path: 'p' }, /exactly one form/],
    [{ ...good, compare: { op: 'eq', to: 1 } }, /exactly one form/],
    [{ ...good, pass: [{}] }, /only strings, numbers, booleans or null/],
    [{ key: 'k', label: 'l', path: 'p', compare: { op: 'like', to: 1 } }, /compare.op/],
    [{ ...good, onTrue: 'pass' }, /compare only/],
    [{ key: 'k', label: 'l', path: 'p', compare: { op: 'eq', to: 1 }, onFalse: 'red' }, /onFalse must be one of/],
    [{ ...good, missing: 'ignore' }, /missing must be/],
    [{ ...good, blocking: 'yes' }, /blocking must be a boolean/],
    [{ ...good, label: 'x'.repeat(81) }, /at most 80/],
    [{ ...good, detail: '{a|money|percent}' }, /more than one format/],
    [{ ...good, detail: '{a|euro}' }, /unknown format/],
    [{ ...good, detail: 'line {#}' }, /\{#\} without forEach/],
    [{ ...good, detail: '[[x]]' }, /nested \[ \]/],
    [{ ...good, when: { path: 'x' } }, /when.in must be a non-empty list/],
    [{ ...good, when: { path: 'x', in: ['a'], not: 1 } }, /when has unknown key "not"/],
  ])('refuses %j', (decl, reason) => {
    expect(invalidChecksReason('t', checks(decl))).toMatch(reason);
  });

  it('refuses a duplicate key and more than 12 checks', () => {
    expect(invalidChecksReason('t', checks(good, good))).toMatch(/declared twice/);
    const many = Array.from({ length: 13 }, (_, i) => ({ ...good, key: `k${i}` }));
    expect(invalidChecksReason('t', checks(...many))).toMatch(/max 12/);
  });
});

describe('preview `when` / `displayOnly` validation', () => {
  const read = { tool: 'check_vat_id', args: { uid: 'uid' }, attach: 'uid' };
  it('accepts a plain path and a boolean', () => {
    expect(invalidPreviewReason('t', { preview: [{ ...read, when: 'uid', displayOnly: true }] })).toBeNull();
  });
  it('refuses a bad when, a non-boolean displayOnly, and displayOnly with version', () => {
    expect(invalidPreviewReason('t', { preview: [{ ...read, when: 'lines[].x' }] })).toMatch(/when must be/);
    expect(invalidPreviewReason('t', { preview: [{ ...read, displayOnly: 'yes' }] })).toMatch(/displayOnly must be a boolean/);
    expect(invalidPreviewReason('t', { preview: [{ ...read, displayOnly: true, version: { arg: 'r', field: 'r' } }] }))
      .toMatch(/cannot be both displayOnly and version-checked/);
  });
});

describe('network validation', () => {
  const entry = { modes: { live: ['local'] }, host: 'ec.europa.eu', purpose: 'VAT-ID check', sends: 'country and VAT ID' };
  it('accepts a list of declarations; absent is fine', () => {
    expect(invalidNetworkReason({ network: [entry, { host: 'api.example.com', purpose: 'p', sends: 's' }] })).toBeNull();
    expect(invalidNetworkReason({})).toBeNull();
  });
  it.each([
    [{ network: [] }, /non-empty list/],
    [{ network: [{ ...entry, host: 'https://ec.europa.eu/x' }] }, /bare host name/],
    [{ network: [{ ...entry, purpose: '' }] }, /purpose must be/],
    [{ network: [{ ...entry, sends: undefined }] }, /sends must be/],
    [{ network: [{ ...entry, modes: { live: [] } }] }, /modes.live must be/],
    [{ network: [{ ...entry, proxy: true }] }, /unknown key "proxy"/],
  ])('refuses %j', (m, reason) => {
    expect(invalidNetworkReason(m as never)).toMatch(reason);
  });
});
