import { describe, it, expect } from 'vitest';
import { pathWrapParts } from './data-folder';

describe('pathWrapParts', () => {
  it('keeps a POSIX path intact when joined', () => {
    const p = '/Users/anna/.suveren';
    expect(pathWrapParts(p)).toEqual(['/', 'Users/', 'anna/', '.suveren']);
    expect(pathWrapParts(p).join('')).toBe(p);
  });
  it('keeps Windows backslashes and breaks after them', () => {
    const p = 'C:\\Users\\Anna Muster\\AppData\\Suveren';
    expect(pathWrapParts(p)).toEqual(['C:\\', 'Users\\', 'Anna Muster\\', 'AppData\\', 'Suveren']);
    expect(pathWrapParts(p).join('')).toBe(p);
  });
  it('handles an empty path', () => {
    expect(pathWrapParts('')).toEqual([]);
  });
});
