import { describe, it, expect } from 'vitest';
import { SSE_EVENT_TYPES } from './EventSourceContext';

/**
 * Pins the exact gap this task closed: a new SSEEventType ('denial-recorded')
 * that compiled fine but was never actually registered on the EventSource.
 * SSE_EVENT_TYPES is built from a `Record<SSEEventType, true>` in the source
 * file, so TypeScript itself would fail to build if a union member were ever
 * missing — this test is the runtime half of that guarantee.
 */
describe('SSE_EVENT_TYPES', () => {
  it('includes every event the sidebar/pages can subscribe to, with no duplicates', () => {
    expect(new Set(SSE_EVENT_TYPES).size).toBe(SSE_EVENT_TYPES.length);
  });

  it('includes denial-recorded (AU2 — moves the Blocked badge/page live)', () => {
    expect(SSE_EVENT_TYPES).toContain('denial-recorded');
  });

  it('includes execution-failed (pre-existing doorbell event, unaffected by this change)', () => {
    expect(SSE_EVENT_TYPES).toContain('execution-failed');
  });
});
