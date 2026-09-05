/**
 * Execution journal — the Gatekeeper's "one execution per ticket" record.
 *
 * Pins the semantics the committed-proposal path relies on: write-ahead
 * intent, refusal of any second begin() for the same ticket regardless of
 * state, disk re-read on every lookup (cross-process), and loud failure on
 * an unreadable file rather than a silent "nothing ran".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hap-journal-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ExecutionJournal', () => {
  it('begin() persists an intent row BEFORE the caller runs anything', () => {
    const j = new ExecutionJournal(dir);
    const r = j.begin({ ticketId: 't1', proposalId: 'p1', tool: 'x__y', argsHash: 'sha256:a' });
    expect(r.ok).toBe(true);

    // On disk already — a crash right now leaves evidence, not silence.
    const file = JSON.parse(readFileSync(join(dir, 'execution-journal.json'), 'utf8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({ ticketId: 't1', state: 'intent', pid: process.pid });
  });

  it('refuses a second begin() for the same ticket in every state', () => {
    const j = new ExecutionJournal(dir);
    const row = { ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' };
    expect(j.begin(row).ok).toBe(true);

    const whileIntent = j.begin(row);
    expect(whileIntent.ok).toBe(false);
    if (!whileIntent.ok) expect(whileIntent.existing.state).toBe('intent');

    j.complete('t1', 'done');
    const afterDone = j.begin(row);
    expect(afterDone.ok).toBe(false);
    if (!afterDone.ok) expect(afterDone.existing.state).toBe('done');
  });

  it('complete() records failed as a terminal state distinct from done', () => {
    const j = new ExecutionJournal(dir);
    j.begin({ ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' });
    j.complete('t1', 'failed');
    expect(j.get('t1')?.state).toBe('failed');
    expect(j.get('t1')?.finishedAt).toBeTypeOf('number');
  });

  it('complete() on an unknown ticket is a programming error, not a no-op', () => {
    const j = new ExecutionJournal(dir);
    expect(() => j.complete('never-begun', 'done')).toThrow(/no row/);
  });

  it('sees rows written by another instance (cross-process semantics)', () => {
    const a = new ExecutionJournal(dir);
    const b = new ExecutionJournal(dir);
    a.begin({ ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' });
    // b never wrote anything and holds no cache — it must still refuse.
    const r = b.begin({ ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' });
    expect(r.ok).toBe(false);
  });

  it('an unreadable journal refuses rather than reporting "nothing executed"', () => {
    writeFileSync(join(dir, 'execution-journal.json'), '{not json');
    const j = new ExecutionJournal(dir);
    expect(() => j.get('t1')).toThrow(/unreadable/);
    expect(() => j.begin({ ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' })).toThrow(/unreadable/);
  });

  it('accepts a .json path as well as a directory, like the other stores', () => {
    const j = new ExecutionJournal(join(dir, 'gates.enc.json'));
    j.begin({ ticketId: 't1', tool: 'x__y', argsHash: 'sha256:a' });
    expect(existsSync(join(dir, 'execution-journal.json'))).toBe(true);
  });
});

describe('hashToolArgs', () => {
  it('is insensitive to key order at every depth', () => {
    expect(hashToolArgs({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashToolArgs({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it('distinguishes different arguments', () => {
    expect(hashToolArgs({ commit: 'abc' })).not.toBe(hashToolArgs({ commit: 'abd' }));
  });
});
