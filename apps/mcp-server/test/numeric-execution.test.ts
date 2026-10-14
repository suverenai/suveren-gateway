/**
 * Numeric execution-context fields that arrive as a string — the Mollie
 * `amount` bug (github.com/humanagencyprotocol/hap-profiles/charge@0.6, review
 * mode): no amount could pass both the Gatekeeper (wants a number to compare
 * against amount_max) and Mollie (wants back exactly the string type its own
 * schema declares, e.g. "0.10"). These pin the parsing rule and the
 * schema-driven field selection in isolation from tool-proxy.ts's wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseNumericString,
  declaredNumericFields,
  coerceDeclaredNumericFields,
} from '../src/lib/numeric-execution';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ??
  join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

const CHARGE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.6';
const TEST_PROFILE_ID = 'test/coerce@1';

const TEST_PROFILE: AgentProfile = {
  id: TEST_PROFILE_ID,
  version: '1',
  description: 'test',
  executionContextSchema: {
    fields: {
      amount: { source: 'declared', description: '', required: true, constraint: { type: 'number', enforceable: ['max'] } },
      currency: { source: 'declared', description: '', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
    },
  },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

beforeEach(() => {
  clearProfiles();
  registerProfile(TEST_PROFILE_ID, TEST_PROFILE);
});

afterEach(() => clearProfiles());

describe('parseNumericString — accepts only a plain decimal', () => {
  it.each([
    ['"0.10" (the failing repro value)', '0.10', 0.10],
    ['"1.00" (the other failing repro value)', '1.00', 1.00],
    ['a bare integer', '12', 12],
    ['a multi-digit decimal', '1234.50', 1234.50],
    ['zero', '0', 0],
    ['a negative amount', '-5.5', -5.5],
  ])('%s → %s', (_label, input, expected) => {
    expect(parseNumericString(input)).toBe(expected);
  });

  it.each([
    ['exponential notation', '1e3'],
    ['hex', '0x10'],
    ['empty string', ''],
    ['leading whitespace', ' 1'],
    ['trailing whitespace', '1 '],
    ['thousands separator', '1,00'],
    ['the literal "NaN"', 'NaN'],
    ['the literal "Infinity"', 'Infinity'],
    ['two decimal points', '1.2.3'],
    ['a trailing decimal point with no digits', '12.'],
    ['a leading decimal point with no digit before it', '.5'],
    ['a plus sign', '+5'],
    ['not a number at all', 'abc'],
  ])('rejects %s ("%s")', (_label, input) => {
    expect(parseNumericString(input)).toBeUndefined();
  });
});

describe('declaredNumericFields — schema-driven, not Mollie-specific', () => {
  it("reads \"amount\" off the real charge profile's executionContextSchema", () => {
    const profile = JSON.parse(readFileSync(join(profilesDir, 'charge', '0.6.profile.json'), 'utf-8')) as AgentProfile;
    expect(profile.id).toBe(CHARGE_ID);
    expect(declaredNumericFields(profile)).toEqual(new Set(['amount']));
  });

  it('excludes a cumulative field (not source: declared)', () => {
    const profile: AgentProfile = {
      ...TEST_PROFILE,
      id: 'test/numeric-fields@1',
      executionContextSchema: {
        fields: {
          ...TEST_PROFILE.executionContextSchema.fields,
          amount_daily: {
            source: 'cumulative',
            cumulativeField: 'amount',
            window: 'daily',
            description: '',
            required: true,
            constraint: { type: 'number', enforceable: ['max'] },
          },
        },
      },
    };
    expect(declaredNumericFields(profile)).toEqual(new Set(['amount']));
  });

  it('is empty for an undefined profile (unknown profile id)', () => {
    expect(declaredNumericFields(undefined)).toEqual(new Set());
  });
});

describe('coerceDeclaredNumericFields — mutates execution, nothing else', () => {
  it('parses a valid numeric string in a declared-numeric field', () => {
    const execution: Record<string, string | number> = { amount: '0.10', currency: 'EUR' };
    coerceDeclaredNumericFields(TEST_PROFILE_ID, execution);
    expect(execution.amount).toBe(0.10);
    expect(typeof execution.amount).toBe('number');
  });

  it('leaves an already-numeric field untouched', () => {
    const execution: Record<string, string | number> = { amount: 5, currency: 'EUR' };
    coerceDeclaredNumericFields(TEST_PROFILE_ID, execution);
    expect(execution.amount).toBe(5);
  });

  it("leaves a malformed numeric string AS-IS — the Gatekeeper's own type-mismatch refusal still applies", () => {
    const execution: Record<string, string | number> = { amount: '1e3', currency: 'EUR' };
    coerceDeclaredNumericFields(TEST_PROFILE_ID, execution);
    expect(execution.amount).toBe('1e3');
  });

  it('never touches a field the schema does NOT declare numeric (currency stays a string)', () => {
    const execution: Record<string, string | number> = { amount: '0.10', currency: 'EUR' };
    coerceDeclaredNumericFields(TEST_PROFILE_ID, execution);
    expect(execution.currency).toBe('EUR');
    expect(typeof execution.currency).toBe('string');
  });

  it('is a no-op for an unregistered profile id', () => {
    const execution: Record<string, string | number> = { amount: '0.10' };
    coerceDeclaredNumericFields('no/such/profile@1', execution);
    expect(execution.amount).toBe('0.10');
  });
});
