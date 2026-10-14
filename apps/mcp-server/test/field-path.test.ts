/**
 * AU10 §8.1 — field-path resolver (doc/au10-request-context.md §8.1).
 * Written against the real Gmail `get_message` shape the contract names:
 * top-level `id`/`threadId`/`snippet`/`internalDate` (ms string),
 * `payload.headers` = `[{name, value}, ...]`.
 */
import { describe, it, expect } from 'vitest';
import { resolveFieldPath } from '../src/lib/field-path';

const gmailMessage = {
  id: 'msg-1',
  threadId: 'thr-1',
  snippet: 'Guten Morgen, unsere Anlage RF 55 steht seit heute früh...',
  internalDate: '1760000000000',
  payload: {
    headers: [
      { name: 'Date', value: 'Wed, 14 Oct 2026 09:55:00 +0200' },
      { name: 'From', value: 'Jürgen Kraus <j.kraus@bavaria-umform.de>' },
      { name: 'Message-ID', value: '<abc123@mail.gmail.com>' },
      { name: 'Subject', value: 'RF 55 Stillstand – Seriennummer 55-2291' },
      { name: 'To', value: 'verkauf@alpenwerk.example' },
    ],
  },
};

describe('resolveFieldPath — plain string path (unchanged behaviour)', () => {
  it('resolves a dotted path', () => {
    expect(resolveFieldPath(gmailMessage, 'snippet')).toBe(gmailMessage.snippet);
  });

  it('returns undefined for an unset path', () => {
    expect(resolveFieldPath(gmailMessage, undefined)).toBeUndefined();
  });
});

describe('resolveFieldPath — where/pick (Gmail header lookup)', () => {
  it('picks the Subject header value', () => {
    expect(resolveFieldPath(gmailMessage, { path: 'payload.headers', where: { name: 'Subject' }, pick: 'value' }))
      .toBe('RF 55 Stillstand – Seriennummer 55-2291');
  });

  it('where matching is case-insensitive for string values', () => {
    expect(resolveFieldPath(gmailMessage, { path: 'payload.headers', where: { name: 'subject' }, pick: 'value' }))
      .toBe('RF 55 Stillstand – Seriennummer 55-2291');
  });

  it('returns undefined when no element matches where', () => {
    expect(resolveFieldPath(gmailMessage, { path: 'payload.headers', where: { name: 'Cc' }, pick: 'value' })).toBeUndefined();
  });

  it('returns undefined when the path does not resolve to a list but where is set', () => {
    expect(resolveFieldPath(gmailMessage, { path: 'snippet', where: { name: 'Subject' }, pick: 'value' })).toBeUndefined();
  });
});

describe('resolveFieldPath — parse: address.name / address.email', () => {
  it('extracts the email address from "Name <a@b>"', () => {
    expect(resolveFieldPath(gmailMessage, {
      path: 'payload.headers', where: { name: 'From' }, pick: 'value', parse: 'address.email',
    })).toBe('j.kraus@bavaria-umform.de');
  });

  it('extracts the display name from "Name <a@b>"', () => {
    expect(resolveFieldPath(gmailMessage, {
      path: 'payload.headers', where: { name: 'From' }, pick: 'value', parse: 'address.name',
    })).toBe('Jürgen Kraus');
  });

  it('a bare address has no name', () => {
    const bareFrom = { payload: { headers: [{ name: 'From', value: 'j.kraus@bavaria-umform.de' }] } };
    expect(resolveFieldPath(bareFrom, { path: 'payload.headers', where: { name: 'From' }, pick: 'value', parse: 'address.name' }))
      .toBeUndefined();
  });

  it('a bare address parses as the email itself', () => {
    const bareFrom = { payload: { headers: [{ name: 'From', value: 'j.kraus@bavaria-umform.de' }] } };
    expect(resolveFieldPath(bareFrom, { path: 'payload.headers', where: { name: 'From' }, pick: 'value', parse: 'address.email' }))
      .toBe('j.kraus@bavaria-umform.de');
  });

  it('strips quotes from a quoted display name', () => {
    const quoted = { payload: { headers: [{ name: 'From', value: '"Kraus, Jürgen" <j.kraus@bavaria-umform.de>' }] } };
    expect(resolveFieldPath(quoted, { path: 'payload.headers', where: { name: 'From' }, pick: 'value', parse: 'address.name' }))
      .toBe('Kraus, Jürgen');
  });
});

describe('resolveFieldPath — parse: epoch-ms', () => {
  it('converts a numeric-string epoch-ms field to an ISO timestamp', () => {
    const resolved = resolveFieldPath(gmailMessage, { path: 'internalDate', parse: 'epoch-ms' });
    expect(resolved).toBe(new Date(1760000000000).toISOString());
  });

  it('converts a numeric epoch-ms field', () => {
    expect(resolveFieldPath({ at: 1760000000000 }, { path: 'at', parse: 'epoch-ms' }))
      .toBe(new Date(1760000000000).toISOString());
  });

  it('returns undefined for a non-numeric epoch-ms value', () => {
    expect(resolveFieldPath({ at: 'not-a-number' }, { path: 'at', parse: 'epoch-ms' })).toBeUndefined();
  });
});

describe('resolveFieldPath — missing data degrades to undefined, never throws', () => {
  it('a missing path resolves to undefined', () => {
    expect(resolveFieldPath({}, { path: 'nope.nested', pick: 'value' })).toBeUndefined();
  });

  it('pick on a non-object resolves to undefined', () => {
    expect(resolveFieldPath({ x: 'not-an-object' }, { path: 'x', pick: 'value' })).toBeUndefined();
  });
});
