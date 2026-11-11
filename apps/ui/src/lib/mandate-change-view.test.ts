import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeRow, MandateDiff } from '@hap/core/mandate-change';
import {
  gatewayFacts, lastsUntilMeaning, modeMeaning, refusalLine, rowLabel, rowMeaning, rowValue, staysLines, tagClass, valueName, waitingWarning, whenText,
  type ChangeFacts,
} from './mandate-change-view';
import { applyChangeForEdit } from './mandate-change-edit';

const empty: MandateDiff = { rows: [], stays: [] };
const facts: ChangeFacts = { limitReached: [{ field: 'f', label: 'Per day', limit: 5, days: 3, ofDays: 7 }], today: [{ field: 'f', label: 'Per day', current: 5 }], waiting: 2 };

describe('the card\'s fixed sentences', () => {
  it('states how often the limit was reached and that today\'s count stays', () => {
    expect(gatewayFacts(facts, empty)).toEqual(['The limit of 5 was reached on 3 days of the last 7.', 'Today\'s count stays: 5 already used.']);
  });
  it('a version move says the count restarts, never that it stays', () => {
    const lines = gatewayFacts(facts, { ...empty, versionMove: { from: 'a@1', to: 'a@2' } });
    expect(lines).toContainEqual(expect.stringMatching(/restarts/));
    expect(lines.some((l) => /stays/.test(l))).toBe(false);
  });
  it('warns about waiting requests, in the singular too, and only when there are any', () => {
    expect(waitingWarning(2)).toBe('2 waiting requests under the old mandate will be closed.');
    expect(waitingWarning(1)).toBe('1 waiting request under the old mandate will be closed.');
    expect(waitingWarning(0)).toBeNull();
    expect(waitingWarning(undefined)).toBeNull();
  });
  it('unknown is said as unknown, never as none', () => {
    expect(waitingWarning(null)).toMatch(/could not check/);
  });
  it('a More tag and a Changed tag look like the more important one; Less does not', () => {
    expect(tagClass('More')).toBe('mc-more');
    expect(tagClass('Changed')).toBe('mc-more');
    expect(tagClass('New')).toBe('mc-more');
    expect(tagClass('Less')).toBe('mc-less');
  });
  it('values carry their unit', () => {
    expect(rowValue({ unit: 'currency:EUR' }, 1000)).toBe('EUR 1000');
    expect(rowValue({ unit: 'percent' }, 10)).toBe('10%');
    expect(rowValue({ unit: 'count' }, 5)).toBe('5');
    expect(rowValue({}, null)).toBe('—');
  });
  it('the unchanged rest reads in words', () => {
    expect(staysLines({ ...empty, stays: [{ label: 'Up to', value: '3' }, { label: 'mode', value: 'review' }, { label: 'lasts-until', value: '1800000000' }, { label: 'intent', value: '' }] }))
      .toEqual(['Up to: 3', 'Review Each Action', expect.stringMatching(/^Lasts until/), 'Why it\'s for']);
  });
});

describe('"Change it myself" starts from the signed mandate plus the sealed differences', () => {
  const old = { bounds: { a: 1, b: 2, profile: 'x' }, context: { c: 'one' }, intent: 'Old words.', deferredCommitmentDomains: ['d'], expiresAt: 1000 };
  it('applies only sealed rows; the rest is the signed values', () => {
    const p = applyChangeForEdit(old, {
      change: { ...empty, rows: [{ section: 'limit', field: 'a', label: 'A', before: 1, after: 9, tag: 'More' }, { section: 'scope', field: 'c', label: 'C', before: 'one', after: null, tag: 'Gone' }] },
      intent: 'New words.',
    }, 100);
    expect(p.bounds).toEqual({ a: 9, b: 2, profile: 'x' });
    expect(p.context).toEqual({});
    expect(p.gateContent.intent).toBe('New words.');
    expect(p.templateMode).toBe('review');
    expect(p.templateTtl).toBe(900);
  });
  it('the proposed end date wins; the signed intent stays when no new one is proposed', () => {
    const p = applyChangeForEdit(old, { change: { ...empty, lastsUntil: { before: 1000, after: 5000, tag: 'More' } } }, 100);
    expect(p.templateTtl).toBe(4900);
    expect(p.gateContent.intent).toBe('Old words.');
  });
});

// The SHIPPED manifests: the same files the mandate form's "What the AI may attach" selector reads.
const manifest = (id: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations', `${id}.json`), 'utf8'));
const manifests = [manifest('files'), manifest('erp')];

const sources = (over: Partial<ChangeRow>): ChangeRow => ({
  section: 'scope', field: 'allowed_attachment_sources', label: 'Allowed attachment sources', format: 'connector:kind', emptyMeans: 'nothing',
  before: null, after: 'files:file', tag: 'More', added: ['files:file'], removed: [], ...over,
});
const recipients = (over: Partial<ChangeRow>): ChangeRow => ({
  section: 'scope', field: 'allowed_recipients', label: 'Allowed recipients', emptyMeans: 'anything',
  before: 'a@x.example', after: 'a@x.example,b@x.example', tag: 'More', added: ['b@x.example'], removed: [], ...over,
});

describe('names the person knows, never internal codes', () => {
  it('a document source by the title the form shows; the field by the form\'s heading', () => {
    expect(valueName(sources({}), 'files:file', manifests)).toBe('Saved files');
    expect(valueName(sources({}), 'erp:invoice-pdf', manifests)).toBe('Issued invoice');
    expect(rowLabel(sources({}))).toBe('What the AI may attach');
  });
  it('any other field keeps the profile\'s name and its values', () => {
    expect(rowLabel(recipients({}))).toBe('Allowed recipients');
    expect(valueName(recipients({}), 'b@x.example', manifests)).toBe('b@x.example');
  });
  it('an unchanged source list is named too', () => {
    expect(staysLines({ ...empty, stays: [{ label: 'Allowed attachment sources', value: 'files:file,erp:invoice-pdf', format: 'connector:kind' }] }, manifests))
      .toEqual(['What the AI may attach: Saved files, Issued invoice']);
  });
});

describe('one sentence under each changed row, from the row alone', () => {
  it('document sources read in the form\'s own terms', () => {
    expect(rowMeaning(sources({}), manifests)).toBe('From now on, emails under this mandate may also carry: Saved files.');
    expect(rowMeaning(sources({ before: 'erp:invoice-pdf,files:file', after: 'files:file', tag: 'Less', added: [], removed: ['erp:invoice-pdf'] }), manifests))
      .toBe('From now on, emails under this mandate may no longer carry: Issued invoice.');
    expect(rowMeaning(sources({ before: 'files:file', after: null, tag: 'Less', added: [], removed: ['files:file'] }), manifests))
      .toBe('From now on, emails under this mandate carry text only.');
    expect(rowMeaning(sources({ before: 'erp:invoice-pdf', after: 'files:file', added: ['files:file'], removed: ['erp:invoice-pdf'] }), manifests))
      .toBe('From now on, emails under this mandate may also carry: Saved files; no longer: Issued invoice.');
  });
  it('any other list uses the generic form', () => {
    expect(rowMeaning(recipients({}), manifests)).toBe('This allows more than before: also b@x.example.');
    expect(rowMeaning(recipients({ before: 'a@x.example,b@x.example', after: 'a@x.example', tag: 'Less', added: [], removed: ['b@x.example'] }), manifests))
      .toBe('This allows less than before: no longer b@x.example.');
    expect(rowMeaning(recipients({ before: null, after: 'a@x.example', tag: 'Less', added: ['a@x.example'] }), manifests))
      .toBe('This allows less than before: only a@x.example from now on.');
    expect(rowMeaning(recipients({ before: 'a@x.example', after: null, tag: 'More', added: [], removed: ['a@x.example'] }), manifests))
      .toBe('This allows more than before: no longer only a@x.example.');
  });
  it('numbers, mode and end date', () => {
    const limit: ChangeRow = { section: 'limit', field: 'd', label: 'Per day', unit: 'count', before: 5, after: 15, tag: 'More' };
    expect(rowMeaning(limit, manifests)).toBe('This allows more than before: up to 15 instead of 5.');
    expect(rowMeaning({ ...limit, after: 1, tag: 'Less' }, manifests)).toBe('This allows less than before: up to 1 instead of 5.');
    expect(rowMeaning({ ...limit, unit: undefined, before: 'none', after: 'unlimited', tag: 'Changed' }, manifests)).toBe('This changes what is allowed: unlimited instead of none.');
    expect(modeMeaning('More')).toBe('From now on, your AI acts without asking you first.');
    expect(modeMeaning('Less')).toBe('From now on, your AI asks you before each action.');
    expect(lastsUntilMeaning('More')).toBe('This mandate lasts longer than before.');
    expect(lastsUntilMeaning('Less')).toBe('This mandate ends sooner than before.');
  });
});

describe('why: refusals the gateway recorded', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime();
  const at1042 = new Date(2026, 10, 11, 10, 42).getTime();
  const time = new Date(at1042).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const diff: MandateDiff = { ...empty, rows: [sources({}), recipients({})] };

  it('a refused saved file, in one sentence with its time', () => {
    expect(refusalLine({ field: 'allowed_attachment_sources', ts: at1042, values: ['files:file'] }, diff, manifests, now))
      .toBe(`Your AI was refused attaching Saved files today at ${time}, because this mandate did not allow it.`);
  });
  it('another list names the value and the field', () => {
    expect(refusalLine({ field: 'allowed_recipients', ts: at1042, values: ['b@x.example'] }, diff, manifests, now))
      .toBe(`Your AI was refused b@x.example (Allowed recipients) today at ${time}, because this mandate did not allow it.`);
  });
  it('yesterday and older days say so', () => {
    expect(whenText(at1042 - 86_400_000, now)).toBe(`yesterday at ${time}`);
    expect(whenText(at1042 - 3 * 86_400_000, now)).toMatch(/^on .+ at /);
  });
  it('the refusals come first in "From your gateway", at most two, and none is made up', () => {
    const f: ChangeFacts = { limitReached: [], today: [], waiting: 0, refused: [
      { field: 'allowed_attachment_sources', ts: at1042, values: ['files:file'] },
      { field: 'allowed_recipients', ts: at1042, values: ['b@x.example'] },
      { field: 'allowed_attachment_sources', ts: at1042 - 1, values: ['files:file'] },
    ] };
    const lines = gatewayFacts(f, diff, manifests, now);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Your AI was refused attaching Saved files/);
    expect(gatewayFacts({ ...f, refused: [] }, diff, manifests, now)).toEqual([]);
    expect(gatewayFacts({ limitReached: [], today: [], waiting: 0 }, diff, manifests, now)).toEqual([]);
  });
});
