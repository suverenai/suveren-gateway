/**
 * archived-mandates-store — the local display flag. Pins: archiving is
 * idempotent, unarchive removes, bad ids are refused, and a corrupt file
 * yields an empty set instead of breaking the gateway.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readArchived,
  archiveMandate,
  unarchiveMandate,
  isValidMandateId,
} from '../lib/archived-mandates-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archived-mandates-'));
});

describe('archived-mandates-store', () => {
  it('starts empty when no file exists', () => {
    expect(readArchived(dir)).toEqual([]);
  });

  it('archives idempotently and persists', () => {
    archiveMandate('authz_a', dir);
    archiveMandate('authz_a', dir);
    archiveMandate('authz_b', dir);
    expect(readArchived(dir)).toEqual(['authz_a', 'authz_b']);
    const onDisk = JSON.parse(readFileSync(join(dir, 'archived-mandates.json'), 'utf8'));
    expect(onDisk.archived).toEqual(['authz_a', 'authz_b']);
  });

  it('unarchives', () => {
    archiveMandate('authz_a', dir);
    archiveMandate('authz_b', dir);
    expect(unarchiveMandate('authz_a', dir)).toEqual(['authz_b']);
    expect(unarchiveMandate('authz_missing', dir)).toEqual(['authz_b']);
  });

  it('refuses ids that are not path-safe', () => {
    expect(isValidMandateId('../etc/passwd')).toBe(false);
    expect(isValidMandateId('a b')).toBe(false);
    expect(isValidMandateId('')).toBe(false);
    expect(() => archiveMandate('../x', dir)).toThrow();
  });

  it('treats a corrupt file as empty and drops invalid entries', () => {
    writeFileSync(join(dir, 'archived-mandates.json'), '{not json');
    expect(readArchived(dir)).toEqual([]);
    writeFileSync(join(dir, 'archived-mandates.json'), JSON.stringify({ archived: ['authz_ok', '../bad', 7] }));
    expect(readArchived(dir)).toEqual(['authz_ok']);
  });
});
