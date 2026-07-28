/**
 * A locked gateway must not look like an unconfigured one.
 *
 * The gateway boots LOCKED by design, and autostart makes that state routine:
 * after a reboot it comes back, binds its port and answers happily, while
 * unable to read a single authorization.
 *
 * Reported as "No authorizations found", that is indistinguishable from a
 * correctly configured gateway belonging to someone who has not set anything
 * up. The agent then tells the user they have no authority, and the user goes
 * off to create an authorization they already have — when all they needed was
 * to enter their API key.
 *
 * Autostart makes the failure QUIETER, not louder: a dead gateway used to
 * produce an obvious connection error; now it connects fine and simply has no
 * authority. So the message has to carry the whole explanation and the fix.
 */
import { describe, it, expect } from 'vitest';
import { lockedNotice } from '../src/lib/locked-notice';

describe('lockedNotice', () => {
  it('says LOCKED, not "no authorizations"', () => {
    const notice = lockedNotice();
    expect(notice).toContain('LOCKED');
    // The exact phrase that caused the confusion must never appear.
    expect(notice.toLowerCase()).not.toContain('no authorizations found');
  });

  it('explicitly denies the wrong conclusion', () => {
    // Without this the agent may still infer "nothing is set up".
    expect(lockedNotice()).toContain('not the same as having no authorizations');
  });

  it('tells the agent to pass it on — the agent cannot fix this itself', () => {
    expect(lockedNotice()).toContain('TELL THE USER');
  });

  it('gives the exact fix: the URL and what to enter', () => {
    const notice = lockedNotice();
    expect(notice).toContain('http://localhost:3400');
    expect(notice).toMatch(/API key/i);
  });

  it('honours a non-default control-plane port', () => {
    const prev = process.env.SUVEREN_CP_PORT;
    process.env.SUVEREN_CP_PORT = '7400';
    try {
      // Sending someone to the wrong port is its own dead end.
      expect(lockedNotice()).toContain('http://localhost:7400');
    } finally {
      if (prev === undefined) delete process.env.SUVEREN_CP_PORT;
      else process.env.SUVEREN_CP_PORT = prev;
    }
  });

  it('names the blocked action when given one', () => {
    expect(lockedNotice('use gmail__send_message')).toContain('Cannot use gmail__send_message');
  });

  it('reads sensibly with no action', () => {
    expect(lockedNotice()).toMatch(/^The Suveren gateway is running but LOCKED/);
  });

  it('explains that locking on restart is deliberate, not a fault', () => {
    // Otherwise it reads as a bug and gets reported as one.
    expect(lockedNotice()).toContain('boots locked by design');
  });
});
