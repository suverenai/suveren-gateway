import { describe, it, expect } from 'vitest';
import { matchShownHashEntry, shownStatus, otherApproversNote, formatReadAt } from './au10-shown-view';
import type { ShownHashes } from './sp-client';

describe('matchShownHashEntry', () => {
  it('matches by "by" regardless of key shape', () => {
    const shownHashes: ShownHashes = { 'domain:owner': { hash: 'sha256:a', by: 'user-1', at: 1 } };
    const { entry, otherCount } = matchShownHashEntry(shownHashes, 'user-1', 'owner');
    expect(entry).toEqual({ hash: 'sha256:a', by: 'user-1', at: 1 });
    expect(otherCount).toBe(0);
  });

  it('falls back to the domain key when "by" is a different (teammate) user', () => {
    const shownHashes: ShownHashes = { 'domain:acme': { hash: 'sha256:a', by: 'teammate-1', at: 1 } };
    const { entry } = matchShownHashEntry(shownHashes, 'me', 'acme');
    expect(entry).toEqual({ hash: 'sha256:a', by: 'teammate-1', at: 1 });
  });

  it('prefers a direct "by" match over the domain fallback', () => {
    const shownHashes: ShownHashes = {
      'domain:acme': { hash: 'sha256:team', by: 'teammate-1', at: 1 },
      'approver:me': { hash: 'sha256:mine', by: 'me', at: 2 },
    };
    const { entry } = matchShownHashEntry(shownHashes, 'me', 'acme');
    expect(entry?.hash).toBe('sha256:mine');
  });

  it('no match at all when neither "by" nor the domain key fits', () => {
    const shownHashes: ShownHashes = { 'approver:someone-else': { hash: 'sha256:a', by: 'someone-else', at: 1 } };
    const { entry, otherCount } = matchShownHashEntry(shownHashes, 'me', 'owner');
    expect(entry).toBeUndefined();
    expect(otherCount).toBe(1);
  });

  it('counts OTHER entries besides the matched one (several required approvers)', () => {
    const shownHashes: ShownHashes = {
      'approver:me': { hash: 'sha256:mine', by: 'me', at: 1 },
      'approver:alice': { hash: 'sha256:a', by: 'alice', at: 2 },
      'approver:bob': { hash: 'sha256:b', by: 'bob', at: 3 },
    };
    const { entry, otherCount } = matchShownHashEntry(shownHashes, 'me', null);
    expect(entry?.hash).toBe('sha256:mine');
    expect(otherCount).toBe(2);
  });

  it('empty/absent map yields no entry and no others', () => {
    expect(matchShownHashEntry(undefined, 'me', 'owner')).toEqual({ entry: undefined, otherCount: 0 });
    expect(matchShownHashEntry({}, 'me', 'owner')).toEqual({ entry: undefined, otherCount: 0 });
  });

  it('no domain fallback attempted when currentDomain is null/undefined', () => {
    const shownHashes: ShownHashes = { 'domain:acme': { hash: 'sha256:a', by: 'teammate-1', at: 1 } };
    expect(matchShownHashEntry(shownHashes, 'me', null).entry).toBeUndefined();
    expect(matchShownHashEntry(shownHashes, 'me', undefined).entry).toBeUndefined();
  });
});

describe('shownStatus', () => {
  it('off-device wins regardless of the hashes', () => {
    expect(shownStatus({ offDevice: true, recordedHash: 'sha256:a', localHash: 'sha256:a' })).toBe('off-device');
    expect(shownStatus({ offDevice: true, recordedHash: undefined, localHash: undefined })).toBe('off-device');
  });

  it('unchecked when there is no recorded entry for this user at all', () => {
    expect(shownStatus({ offDevice: false, recordedHash: undefined, localHash: 'sha256:a' })).toBe('unchecked');
  });

  it('verified when the local hash matches the recorded one', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: 'sha256:a' })).toBe('verified');
  });

  it('mismatch when the local hash differs from the recorded one', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: 'sha256:b' })).toBe('mismatch');
  });

  it('mismatch (never "verified") when the local hash is missing but one was recorded', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: undefined })).toBe('mismatch');
  });
});

describe('otherApproversNote', () => {
  it('undefined when there is nothing else to mention', () => {
    expect(otherApproversNote(0)).toBeUndefined();
  });
  it('singular phrasing for exactly one other', () => {
    expect(otherApproversNote(1)).toBe('1 other approver recorded their own.');
  });
  it('plural phrasing for more than one', () => {
    expect(otherApproversNote(3)).toBe('3 other approvers recorded their own.');
  });
});

describe('formatReadAt', () => {
  it('renders an HH:MM-shaped string', () => {
    expect(formatReadAt(Date.now())).toMatch(/\d{1,2}:\d{2}/);
  });
});
