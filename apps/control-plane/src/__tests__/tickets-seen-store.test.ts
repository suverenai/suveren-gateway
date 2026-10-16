/**
 * tickets-seen-store — the local "last seen Tickets at" display flag. Pins:
 * never-seen defaults to 0 (counts everything as new, the safe direction),
 * marking seen persists and returns the given ts, and a corrupt/missing
 * file never breaks the read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastSeenTicketsAt, markTicketsSeen } from '../lib/tickets-seen-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tickets-seen-'));
});

describe('tickets-seen-store', () => {
  it('defaults to 0 (never seen) when no file exists', () => {
    expect(readLastSeenTicketsAt(dir)).toBe(0);
  });

  it('marks seen and persists the given timestamp', () => {
    expect(markTicketsSeen(1_700_000_000_000, dir)).toBe(1_700_000_000_000);
    expect(readLastSeenTicketsAt(dir)).toBe(1_700_000_000_000);
    const onDisk = JSON.parse(readFileSync(join(dir, 'tickets-seen.json'), 'utf8'));
    expect(onDisk.lastSeenTicketsAt).toBe(1_700_000_000_000);
  });

  it('marking again overwrites the previous cutoff', () => {
    markTicketsSeen(100, dir);
    markTicketsSeen(200, dir);
    expect(readLastSeenTicketsAt(dir)).toBe(200);
  });

  it('falls back to now for invalid input', () => {
    const before = Date.now();
    const ts = markTicketsSeen(NaN, dir);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(readLastSeenTicketsAt(dir)).toBe(ts);
  });

  it('treats a corrupt or malformed file as never-seen (0), not a crash', () => {
    writeFileSync(join(dir, 'tickets-seen.json'), '{not json');
    expect(readLastSeenTicketsAt(dir)).toBe(0);
    writeFileSync(join(dir, 'tickets-seen.json'), JSON.stringify({ lastSeenTicketsAt: 'not a number' }));
    expect(readLastSeenTicketsAt(dir)).toBe(0);
  });
});
