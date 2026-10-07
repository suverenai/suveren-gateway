import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContactStore } from '../src/lib/agent-contact';

const dir = () => mkdtempSync(join(tmpdir(), 'agent-contact-'));

describe('AgentContactStore', () => {
  it('nothing recorded → null, and no file', () => {
    const d = dir();
    expect(new AgentContactStore(d).read()).toBeNull();
    expect(existsSync(join(d, 'agent-contact.json'))).toBe(false);
  });

  it('records the first contact with the client name and survives a restart', () => {
    const d = dir();
    const t0 = new Date('2026-10-07T10:00:00Z');
    new AgentContactStore(d).record({ name: 'claude-ai', version: '0.1.0' }, t0);
    const again = new AgentContactStore(d).read();
    expect(again).toEqual({ clientName: 'claude-ai', clientVersion: '0.1.0', firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString() });
  });

  it('keeps the first contact, moves the last one; a repeat within a minute is not written', () => {
    const d = dir();
    const s = new AgentContactStore(d);
    s.record({ name: 'Claude Code' }, new Date('2026-10-07T10:00:00Z'));
    s.record({ name: 'Claude Code' }, new Date('2026-10-07T10:00:30Z'));
    expect(s.read()?.lastSeenAt).toBe('2026-10-07T10:00:30.000Z');
    expect(JSON.parse(readFileSync(join(d, 'agent-contact.json'), 'utf8')).lastSeenAt).toBe('2026-10-07T10:00:00.000Z');
    s.record({ name: 'Claude Code' }, new Date('2026-10-07T10:02:00Z'));
    const disk = JSON.parse(readFileSync(join(d, 'agent-contact.json'), 'utf8'));
    expect(disk.firstSeenAt).toBe('2026-10-07T10:00:00.000Z');
    expect(disk.lastSeenAt).toBe('2026-10-07T10:02:00.000Z');
  });

  it('a different client is written at once; a missing name is named, not dropped', () => {
    const d = dir();
    const s = new AgentContactStore(d);
    s.record({ name: 'Claude Code' }, new Date('2026-10-07T10:00:00Z'));
    s.record(undefined, new Date('2026-10-07T10:00:10Z'));
    expect(JSON.parse(readFileSync(join(d, 'agent-contact.json'), 'utf8')).clientName).toBe('Unknown AI client');
  });
});
