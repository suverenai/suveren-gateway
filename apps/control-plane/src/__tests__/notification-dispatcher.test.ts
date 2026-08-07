import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationDispatcher, type DispatcherOptions } from '../lib/notification-dispatcher';

/**
 * The dispatcher's job is to be quiet. These tests pin the behaviours that make
 * it quiet, because each of them looks like a bug from the outside and will be
 * "fixed" by someone who does not know they were deliberate.
 */
describe('NotificationDispatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make(overrides: Partial<DispatcherOptions> = {}) {
    const notifyFn = vi.fn();
    const d = new NotificationDispatcher({
      notifyFn: notifyFn as never,
      settingsFn: (() => ({ desktopNotifications: true })) as never,
      ...overrides,
    });
    return { d, notifyFn };
  }

  it('collapses a burst into exactly one notification', () => {
    const { d, notifyFn } = make();
    for (let i = 0; i < 5; i++) d.onTrigger();
    expect(notifyFn).not.toHaveBeenCalled(); // debounced, nothing yet

    vi.advanceTimersByTime(5_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it('says nothing about WHAT is waiting', () => {
    const { d, notifyFn } = make();
    d.onTrigger();
    vi.advanceTimersByTime(5_000);

    const [title, message] = notifyFn.mock.calls[0];
    expect(title).toBe('Suveren');
    expect(message).toBe('Something is waiting for your review.');
    // No amounts, names, tools, or ids may ever appear here.
    expect(message).not.toMatch(/€|\$|@|proposal|refund/i);
  });

  it('stays silent during the cooldown, then sends one summary', () => {
    const { d, notifyFn } = make();
    d.onTrigger();
    vi.advanceTimersByTime(5_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);

    // A second event 10s later: nothing until the 60s cooldown expires.
    d.onTrigger();
    vi.advanceTimersByTime(10_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(notifyFn).toHaveBeenCalledTimes(2);
  });

  it('does not fire again when nothing happened during the cooldown', () => {
    const { d, notifyFn } = make();
    d.onTrigger();
    vi.advanceTimersByTime(5_000 + 60_000 + 1_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it('reports unusual volume distinctly — presence and a count, still no content', () => {
    const { d, notifyFn } = make();
    for (let i = 0; i < 12; i++) d.onTrigger();
    vi.advanceTimersByTime(5_000);

    const message = notifyFn.mock.calls[0][1] as string;
    expect(message).toBe('Unusual volume: 12 requests in the last minute.');
  });

  it('honours the setting at fire time, not at subscribe time', () => {
    let enabled = true;
    const notifyFn = vi.fn();
    const d = new NotificationDispatcher({
      notifyFn: notifyFn as never,
      settingsFn: (() => ({ desktopNotifications: enabled })) as never,
    });

    enabled = false; // turned off after construction
    d.onTrigger();
    vi.advanceTimersByTime(5_000);
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it('still notifies when the settings file is unreadable', () => {
    const notifyFn = vi.fn();
    const d = new NotificationDispatcher({
      notifyFn: notifyFn as never,
      settingsFn: (() => { throw new Error('ENOENT'); }) as never,
    });
    d.onTrigger();
    vi.advanceTimersByTime(5_000);
    // A broken preferences file must not silence the doorbell.
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });
});
