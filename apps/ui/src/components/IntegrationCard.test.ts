import { describe, it, expect } from 'vitest';
import { declaresReadAge, readAgeLabel, READ_AGE_PRESETS } from './IntegrationCard';

// Pure logic only (the panel's JSX is presentation, verified in the browser
// layer). These two helpers decide WHETHER the Read-policy control appears and
// WHAT each choice claims to do — both places where a mistake is silent.

describe('declaresReadAge — derived from the manifest, never from an id', () => {
  it('is true when any read adapter declares an age dimension', () => {
    const toolGating = {
      overrides: {
        send_message: { executionMapping: {}, staticExecution: { action_type: 'send' } },
        list_messages: { category: 'read', read: { ageField: 'read_age_days', queryArg: 'q' } },
      },
    };
    expect(declaresReadAge(toolGating)).toBe(true);
  });

  it('is false when reads exist but none is age-bounded', () => {
    // Calendar-shaped: reads are scoped by RESOURCE, not by age. Offering a
    // read-age control here would be a control that governs nothing.
    const toolGating = {
      overrides: {
        list_events: { category: 'read', read: { resourceBound: 'allowed_calendars', resourceArg: 'calendarId' } },
      },
    };
    expect(declaresReadAge(toolGating)).toBe(false);
  });

  it('is false for a write-only integration', () => {
    expect(declaresReadAge({ overrides: { create_post: { staticExecution: { action_type: 'publish' } } } })).toBe(false);
  });

  it('survives missing / malformed manifests instead of throwing', () => {
    // A card must still render if a manifest is absent or oddly shaped.
    expect(declaresReadAge(undefined)).toBe(false);
    expect(declaresReadAge(null)).toBe(false);
    expect(declaresReadAge({})).toBe(false);
    expect(declaresReadAge({ overrides: null })).toBe(false);
    expect(declaresReadAge('nonsense')).toBe(false);
    expect(declaresReadAge({ overrides: { t: null } })).toBe(false);
    expect(declaresReadAge({ overrides: { t: { read: {} } } })).toBe(false);
    // ageField present but not a string — not a usable declaration.
    expect(declaresReadAge({ overrides: { t: { read: { ageField: 42 } } } })).toBe(false);
  });
});

describe('readAgeLabel', () => {
  it('distinguishes "no local setting" from "read nothing"', () => {
    // The whole bug class this guards: null and 0 are different answers, and
    // collapsing them would let a 0 ("read nothing") read as a fallback to the
    // grant bound — reading MORE than the owner allowed.
    expect(readAgeLabel(null)).toBe('From your authorization');
    expect(readAgeLabel(0)).toBe('Read nothing');
    expect(readAgeLabel(null)).not.toBe(readAgeLabel(0));
  });

  it('reads naturally at the round values', () => {
    expect(readAgeLabel(1)).toBe('1 day back');
    expect(readAgeLabel(7)).toBe('7 days back');
    expect(readAgeLabel(365)).toBe('1 year back');
    // The practical "everything" option — stated in years so nobody has to
    // divide 3650 in their head.
    expect(readAgeLabel(3650)).toBe('10 years back');
  });

  it('labels every preset distinctly', () => {
    const labels = READ_AGE_PRESETS.map(readAgeLabel);
    expect(new Set(labels).size).toBe(READ_AGE_PRESETS.length);
  });
});

describe('READ_AGE_PRESETS', () => {
  it('offers no unbounded option', () => {
    // An "unlimited" preset would reopen the F11 hole (an unset window used to
    // mean "read all history"). Every preset must be a finite, non-negative
    // number of days.
    for (const p of READ_AGE_PRESETS) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('is ordered from most to least restrictive', () => {
    const sorted = [...READ_AGE_PRESETS].sort((a, b) => a - b);
    expect([...READ_AGE_PRESETS]).toEqual(sorted);
  });
});
