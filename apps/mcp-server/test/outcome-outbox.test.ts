/**
 * Outcome Outbox — RJ4 ("Reject or ask for a change", 2026-10-11 brief,
 * decision 3). Pins: deliver each outcome exactly once, several outcomes in
 * one appended line each, 7-day expiry for undelivered rows, survival
 * across a restart (fresh instance, same data dir), and encryption at rest
 * once a vault key is set — mirrors denial-log.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { OutcomeOutbox, formatOutcomeLine, wrapWithOutcomeOutbox, type OutcomeOutboxEntry } from '../src/lib/outcome-outbox';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'outcome-outbox-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const entry = (over: Partial<OutcomeOutboxEntry> = {}): Omit<OutcomeOutboxEntry, 'deliveredAt'> => ({
  proposalId: 'p1', outcome: 'rejected', who: 'andreas', decidedAt: Date.now(), ...over,
});

describe('OutcomeOutbox — record / deliver once', () => {
  it('a fresh outbox has nothing undelivered', () => {
    expect(new OutcomeOutbox(tmp()).getUndelivered()).toHaveLength(0);
  });

  it('a recorded outcome is undelivered until markDelivered', () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry());
    expect(box.getUndelivered()).toHaveLength(1);
    box.markDelivered(['p1']);
    expect(box.getUndelivered()).toHaveLength(0);
  });

  it('recordIfNew is a no-op for a proposal already known, delivered or not', () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ note: 'first' }));
    box.recordIfNew(entry({ note: 'second (ignored)' }));
    expect(box.size).toBe(1);
    box.markDelivered(['p1']);
    box.recordIfNew(entry({ note: 'third (still ignored, already delivered)' }));
    expect(box.size).toBe(1);
    expect(box.getUndelivered()).toHaveLength(0);
  });

  it('markDelivered is idempotent and only touches the ids given', () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ proposalId: 'p1' }));
    box.recordIfNew(entry({ proposalId: 'p2' }));
    box.markDelivered(['p1']);
    box.markDelivered(['p1']); // second call: no-op, must not throw
    expect(box.getUndelivered().map(e => e.proposalId)).toEqual(['p2']);
  });
});

describe('OutcomeOutbox — multiple outcomes', () => {
  it('several undelivered outcomes all come back, oldest first', () => {
    const box = new OutcomeOutbox(tmp());
    const now = Date.now();
    box.recordIfNew(entry({ proposalId: 'p1', decidedAt: now - 2000 }));
    box.recordIfNew(entry({ proposalId: 'p2', decidedAt: now - 3000 }));
    box.recordIfNew(entry({ proposalId: 'p3', decidedAt: now - 1000 }));
    expect(box.getUndelivered().map(e => e.proposalId)).toEqual(['p2', 'p1', 'p3']);
  });
});

describe('OutcomeOutbox — persistence survives a restart', () => {
  it('an undelivered entry is still there for a fresh instance on the same dir', () => {
    const dir = tmp();
    new OutcomeOutbox(dir).recordIfNew(entry());
    const restarted = new OutcomeOutbox(dir);
    expect(restarted.getUndelivered()).toHaveLength(1);
  });

  it('a delivered entry stays delivered for a fresh instance (not redelivered)', () => {
    const dir = tmp();
    const box = new OutcomeOutbox(dir);
    box.recordIfNew(entry());
    box.markDelivered(['p1']);
    const restarted = new OutcomeOutbox(dir);
    expect(restarted.getUndelivered()).toHaveLength(0);
    expect(restarted.size).toBe(1);
  });
});

describe('OutcomeOutbox — encryption at rest', () => {
  it('persists plaintext without a key and reloads', () => {
    const dir = tmp();
    new OutcomeOutbox(dir).recordIfNew(entry({ who: 'andreas@sublin.app' }));
    expect(existsSync(join(dir, 'outcome-outbox.json'))).toBe(true);
    expect(new OutcomeOutbox(dir).size).toBe(1);
  });

  it('encrypts at rest once a vault key is set (no plaintext content on disk)', () => {
    const dir = tmp();
    const box = new OutcomeOutbox(dir);
    box.setVaultKey(randomBytes(32));
    box.recordIfNew(entry({ note: 'SECRET-SENTINEL-NOTE', who: 'andreas@sublin.app' }));
    expect(existsSync(join(dir, 'outcome-outbox.enc.json'))).toBe(true);
    const onDisk = readFileSync(join(dir, 'outcome-outbox.enc.json'), 'utf-8');
    expect(onDisk).not.toContain('SECRET-SENTINEL-NOTE');
    expect(onDisk).not.toContain('andreas@sublin.app');
  });

  it('round-trips through encryption', () => {
    const dir = tmp();
    const key = randomBytes(32);
    const a = new OutcomeOutbox(dir); a.setVaultKey(key); a.recordIfNew(entry({ note: 'kept' }));
    const b = new OutcomeOutbox(dir); b.setVaultKey(key);
    expect(b.getUndelivered()[0]?.note).toBe('kept');
  });

  it('migrates plaintext -> encrypted when a key arrives, deleting the plaintext file', () => {
    const dir = tmp();
    const box = new OutcomeOutbox(dir);
    box.recordIfNew(entry());
    expect(existsSync(join(dir, 'outcome-outbox.json'))).toBe(true);
    box.setVaultKey(randomBytes(32));
    expect(existsSync(join(dir, 'outcome-outbox.enc.json'))).toBe(true);
    expect(existsSync(join(dir, 'outcome-outbox.json'))).toBe(false);
  });
});

describe('OutcomeOutbox — 7-day expiry', () => {
  it('drops an undelivered entry older than 7 days on the next write', () => {
    const box = new OutcomeOutbox(tmp());
    const now = Date.now();
    box.recordIfNew(entry({ proposalId: 'old', decidedAt: now - 8 * 24 * 60 * 60 * 1000 }));
    box.recordIfNew(entry({ proposalId: 'new', decidedAt: now }));
    expect(box.getUndelivered().map(e => e.proposalId)).toEqual(['new']);
  });

  it('drops an old entry on load too (a fresh instance after the window passed)', () => {
    const dir = tmp();
    const now = Date.now();
    const box = new OutcomeOutbox(dir);
    box.recordIfNew(entry({ proposalId: 'old', decidedAt: now }));
    // Simulate 8 days passing: a fresh instance loads the same file, then a
    // later write re-evaluates age against "now" — covered by the write-path
    // test above. This test pins that LOAD also prunes, not only write.
    vi.useFakeTimers();
    vi.setSystemTime(now + 8 * 24 * 60 * 60 * 1000);
    const restarted = new OutcomeOutbox(dir);
    expect(restarted.size).toBe(0);
    vi.useRealTimers();
  });
});

describe('formatOutcomeLine — decision 3\'s exact wording', () => {
  it('rejected', () => {
    expect(formatOutcomeLine(entry({ outcome: 'rejected', who: 'Lena Gruber', proposalId: 'p9' }) as OutcomeOutboxEntry))
      .toBe('[Suveren gateway] Since your last call: proposal p9 was REJECTED by Lena Gruber.');
  });

  it('change_needed carries the note in quotes', () => {
    expect(formatOutcomeLine(entry({ outcome: 'change_needed', who: 'Lena Gruber', note: 'Lower the discount', proposalId: 'p9' }) as OutcomeOutboxEntry))
      .toBe('[Suveren gateway] Since your last call: proposal p9 was SENT BACK FOR A CHANGE by Lena Gruber: "Lower the discount".');
  });

  it('replaced never names who or carries a note', () => {
    const line = formatOutcomeLine(entry({ outcome: 'replaced', who: 'Lena Gruber', proposalId: 'p9' }) as OutcomeOutboxEntry);
    expect(line).toBe('[Suveren gateway] Since your last call: proposal p9 was REPLACED by the person\'s own mandate.');
    expect(line).not.toContain('Lena Gruber');
  });
});

describe('wrapWithOutcomeOutbox — the one wrapper', () => {
  function toolResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  it('nothing pending -> the reply is returned completely unchanged', async () => {
    const box = new OutcomeOutbox(tmp());
    const handler = vi.fn().mockResolvedValue(toolResult('ok'));
    const wrapped = wrapWithOutcomeOutbox(box, handler);
    const result = await wrapped({ some: 'args' });
    expect(result).toEqual(toolResult('ok'));
  });

  it('a missing outbox (e.g. a partial state mock) degrades to passing the reply through untouched', async () => {
    const handler = vi.fn().mockResolvedValue(toolResult('ok'));
    const wrapped = wrapWithOutcomeOutbox(undefined, handler);
    await expect(wrapped({ some: 'args' })).resolves.toEqual(toolResult('ok'));
  });

  it('appends ONE extra text content item and marks it delivered', async () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ proposalId: 'p1', outcome: 'rejected', who: 'Lena' }));
    const handler = vi.fn().mockResolvedValue(toolResult('ok'));
    const wrapped = wrapWithOutcomeOutbox(box, handler);
    const result = await wrapped() as { content: Array<{ text?: string }> };
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe('ok');
    expect(result.content[1].text).toContain('REJECTED by Lena');
    expect(box.getUndelivered()).toHaveLength(0);
  });

  it('several outcomes -> one line each, in the single appended item', async () => {
    const box = new OutcomeOutbox(tmp());
    const now = Date.now();
    box.recordIfNew(entry({ proposalId: 'p1', outcome: 'rejected', who: 'Lena', decidedAt: now - 2000 }));
    box.recordIfNew(entry({ proposalId: 'p2', outcome: 'change_needed', who: 'Tom', note: 'Shorter', decidedAt: now - 1000 }));
    const handler = vi.fn().mockResolvedValue(toolResult('ok'));
    const wrapped = wrapWithOutcomeOutbox(box, handler);
    const result = await wrapped() as { content: Array<{ text?: string }> };
    expect(result.content).toHaveLength(2);
    const lines = result.content[1].text!.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('proposal p1 was REJECTED by Lena');
    expect(lines[1]).toContain('proposal p2 was SENT BACK FOR A CHANGE by Tom: "Shorter"');
  });

  it('delivered once: a second call after delivery gets nothing extra', async () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ proposalId: 'p1' }));
    const handler = vi.fn().mockResolvedValue(toolResult('ok'));
    const wrapped = wrapWithOutcomeOutbox(box, handler);
    const first = await wrapped() as { content: Array<{ text?: string }> };
    expect(first.content).toHaveLength(2);
    const second = await wrapped() as { content: Array<{ text?: string }> };
    expect(second.content).toHaveLength(1);
  });

  it('works across proxied, builtin and gateway-tool-shaped handlers alike (any call signature)', async () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ proposalId: 'p1' }));
    // A gateway tool handler takes one args object; a proxied/builtin tool
    // handler takes (args, extra) — the wrapper must not care which.
    const proxiedLike = vi.fn().mockResolvedValue(toolResult('proxied-ok'));
    const wrapped = wrapWithOutcomeOutbox(box, proxiedLike);
    const result = await wrapped({ foo: 'bar' }, { signal: new AbortController().signal }) as { content: Array<{ text?: string }> };
    expect(proxiedLike).toHaveBeenCalledWith({ foo: 'bar' }, { signal: expect.anything() });
    expect(result.content[0].text).toBe('proxied-ok');
    expect(result.content[1].text).toContain('REJECTED');
  });

  it('a malformed result (no content array) is returned as-is, without throwing', async () => {
    const box = new OutcomeOutbox(tmp());
    box.recordIfNew(entry({ proposalId: 'p1' }));
    const handler = vi.fn().mockResolvedValue({ isError: true });
    const wrapped = wrapWithOutcomeOutbox(box, handler);
    await expect(wrapped()).resolves.toEqual({ isError: true });
    // Nothing delivered in this case — undelivered stays undelivered for the next real reply.
    expect(box.getUndelivered()).toHaveLength(1);
  });
});

describe('outcomeEntryFor — which rejections become an outbox entry', () => {
  const NOW = 1_800_000_000_000;
  const sec = (ms: number) => Math.floor(ms / 1000);
  const p = (atMs: number, extra: Record<string, unknown> = {}) => ({
    id: 'p1', rejectedBy: { userId: 'u', domain: 'owner', at: sec(atMs), ...extra },
  });

  it('only proposals this gateway submitted', async () => {
    const { outcomeEntryFor } = await import('../src/lib/outcome-outbox');
    expect(outcomeEntryFor(p(NOW - 1000), false, 'u', NOW)).toBeNull();
    expect(outcomeEntryFor(p(NOW - 1000), true, 'u', NOW)).not.toBeNull();
  });

  it('uses the DECISION time (AS seconds → ms), not the time first seen', async () => {
    const { outcomeEntryFor } = await import('../src/lib/outcome-outbox');
    const e = outcomeEntryFor(p(NOW - 60_000, { outcome: 'change_needed', note: 'n' }), true, 'u', NOW)!;
    expect(e.decidedAt).toBe(sec(NOW - 60_000) * 1000);
    expect(e).toMatchObject({ outcome: 'change_needed', note: 'n' });
  });

  it('a decision older than 7 days is never admitted — so a pruned entry cannot come back as new', async () => {
    const { outcomeEntryFor, OUTCOME_MAX_AGE_MS } = await import('../src/lib/outcome-outbox');
    expect(outcomeEntryFor(p(NOW - OUTCOME_MAX_AGE_MS - 5_000), true, 'u', NOW)).toBeNull();
  });

  it('a row without an outcome reads as rejected; the above-cap rejection wins', async () => {
    const { outcomeEntryFor } = await import('../src/lib/outcome-outbox');
    expect(outcomeEntryFor(p(NOW - 1000), true, 'u', NOW)!.outcome).toBe('rejected');
    const both = { id: 'p2', rejectedBy: { userId: 'a', at: sec(NOW - 1000) }, approverRejectedBy: { userId: 'b', at: sec(NOW - 500), outcome: 'change_needed' as const, note: 'x' } };
    expect(outcomeEntryFor(both, true, 'b', NOW)).toMatchObject({ outcome: 'change_needed', note: 'x' });
  });
});
