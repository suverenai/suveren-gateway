import { describe, it, expect } from 'vitest';
import {
  deriveIntegrationState,
  POLL_MS_STARTING,
  POLL_MS_SETTLED,
} from './IntegrationStatusContext';
import type { McpIntegrationStatus } from '../lib/sp-client';

/**
 * Regression cover for a live bug: a healthy gateway displayed "Starting…"
 * indefinitely on the Integrations page.
 *
 * Two causes, both represented here:
 *   • the state precedence itself — `running` must win outright, so a running
 *     integration can never render as "Starting";
 *   • the startup window is evaluated during render, so nothing re-evaluates
 *     it unless a refresh happens. The fast poll rate is what makes the window
 *     able to expire at all, which is why the interval is asserted.
 */

const s = (o: Partial<McpIntegrationStatus>): McpIntegrationStatus => ({
  id: 'gmail', name: 'Gmail', running: false, toolCount: 0, readAgeDays: null, ...o,
});

describe('deriveIntegrationState', () => {
  it('reports loading only before the first fetch', () => {
    expect(deriveIntegrationState(undefined, 0, false)).toBe('loading');
    expect(deriveIntegrationState(s({ running: true }), 0, false)).toBe('loading');
  });

  it('running beats the startup window — the live bug', () => {
    // The exact symptom: integration is up, yet the card said "Starting…".
    // Running must win regardless of any window still being open.
    expect(deriveIntegrationState(s({ running: true, toolCount: 64 }), 3, true)).toBe('running');
    expect(deriveIntegrationState(s({ running: true }), 3, false)).toBe('running');
  });

  it('a real error is surfaced instead of a hopeful "Starting…"', () => {
    // Hiding a crash behind the window would delay the truth by 30 seconds.
    expect(deriveIntegrationState(s({ error: 'spawn failed' }), 2, true)).toBe('error');
  });

  it('paused (simulation block) beats both the startup window and a stray error — it is never coming up on its own', () => {
    // Regression target: before `paused` existed, the gateway reported this
    // case as `error`, which rendered a red "Crashed" chip and a Start button
    // that could never succeed for as long as simulation mode stayed on.
    expect(deriveIntegrationState(s({ paused: 'simulation' }), 2, true)).toBe('paused');
    expect(deriveIntegrationState(s({ paused: 'simulation', error: 'should never co-occur' }), 2, false)).toBe('paused');
  });

  it('running still beats paused, even if both were ever set together', () => {
    expect(deriveIntegrationState(s({ running: true, paused: 'simulation' }), 2, false)).toBe('running');
  });

  it('shows starting only while down AND inside the window', () => {
    expect(deriveIntegrationState(s({ running: false }), 2, true)).toBe('starting');
  });

  it('admits not-running once the window has passed', () => {
    // This is what must eventually happen; before the fix the window could
    // never expire, so this transition never occurred.
    expect(deriveIntegrationState(s({ running: false }), 2, false)).toBe('not-running');
  });

  it('treats a manifest with no registered integration as not-running', () => {
    expect(deriveIntegrationState(undefined, 2, true)).toBe('not-running');
    expect(deriveIntegrationState(undefined, 2, false)).toBe('not-running');
  });
});

describe('poll intervals', () => {
  it('polls fast enough that a stale card corrects in seconds, not minutes', () => {
    // The observed failure was a healthy gateway showing "Starting…" until the
    // 5-minute fallback fired, because the SSE event was missed during a
    // restart. Anything near the settled interval reproduces that.
    expect(POLL_MS_STARTING).toBeLessThanOrEqual(10_000);
    expect(POLL_MS_STARTING).toBeLessThan(POLL_MS_SETTLED / 10);
  });

  it('backs off once everything is healthy', () => {
    // Fast polling must not become the steady state — it runs on every open tab.
    expect(POLL_MS_SETTLED).toBeGreaterThanOrEqual(60_000);
  });
});
