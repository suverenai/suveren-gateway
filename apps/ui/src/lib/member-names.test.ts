import { describe, it, expect } from 'vitest';
import { buildMemberNameMap, namesFor, nameWithYou } from './member-names';

describe('buildMemberNameMap', () => {
  it('prefers name+email when both are known from the global user list', () => {
    const map = buildMemberNameMap([{ id: 'u1', name: 'Andreas', email: 'a@x.com' }]);
    expect(map.get('u1')).toBe('Andreas (a@x.com)');
  });

  it('falls back to just name, then just email, then the id', () => {
    expect(buildMemberNameMap([{ id: 'u1', name: 'Andreas' }]).get('u1')).toBe('Andreas');
    expect(buildMemberNameMap([{ id: 'u1', email: 'a@x.com' }]).get('u1')).toBe('a@x.com');
    expect(buildMemberNameMap([{ id: 'u1' }]).get('u1')).toBe('u1');
  });

  it('group members override the global list, keyed by userId OR id', () => {
    const map = buildMemberNameMap(
      [{ id: 'u1', name: 'Stale Name' }],
      [{ userId: 'u1', name: 'Andreas', email: 'a@x.com' }],
    );
    expect(map.get('u1')).toBe('Andreas (a@x.com)');
  });

  it('a group member missing both name and email leaves the global-list entry untouched', () => {
    const map = buildMemberNameMap(
      [{ id: 'u1', name: 'Andreas', email: 'a@x.com' }],
      [{ userId: 'u1' }],
    );
    expect(map.get('u1')).toBe('Andreas (a@x.com)');
  });

  it('a group member with no id-ish field at all is skipped, not crashed on', () => {
    expect(() => buildMemberNameMap([], [{ name: 'Nobody' }])).not.toThrow();
  });
});

describe('namesFor', () => {
  it('resolves every id through the map, falling back to the id itself', () => {
    const map = new Map([['u1', 'Andreas']]);
    expect(namesFor(['u1', 'u2'], map)).toEqual(['Andreas', 'u2']);
  });

  it('empty input yields empty output', () => {
    expect(namesFor([], new Map())).toEqual([]);
  });
});

describe('nameWithYou', () => {
  const map = new Map([['u1', 'Andreas'], ['u2', 'Lisa']]);

  it('appends "(you)" for the current user', () => {
    expect(nameWithYou('u2', map, 'u2')).toBe('Lisa (you)');
  });

  it('does not append anything for someone else', () => {
    expect(nameWithYou('u1', map, 'u2')).toBe('Andreas');
  });

  it('falls back to the raw id when unresolved, still appending "(you)" correctly', () => {
    expect(nameWithYou('u3', map, 'u3')).toBe('u3 (you)');
  });
});
