/**
 * Values the gateway used to read by a built-in name, now read from what a
 * profile or manifest declares. Each case uses a made-up profile or connector
 * with other names, so a field or profile name written into code would fail it.
 */
import { describe, it, expect } from 'vitest';
import { registerProfile } from '@hap/core';
import { applyMapping, cumulativeSumValue } from '../src/lib/tool-proxy';
import { readSwitchGate } from '../src/lib/builtins/read-switch';
import { reportBuiltin } from '../src/lib/builtins/report';
import { setupBuiltin } from '../src/lib/builtins/setup';
import { IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState } from '../src/lib/shared-state';
import type { ReportSources } from '../src/lib/report';

const enumSwitch = (values: string[]) => ({ type: 'string', boundType: { kind: 'enum', values } });

describe('object items: read by the property the mapping declares (`item`)', () => {
  it('reads the declared property of each object item, for join and join_domains', () => {
    const exec: Record<string, string | number> = {};
    const guests = [{ address: 'a@one.example', name: 'A' }, { address: 'b@two.example' }];
    applyMapping({ field: 'guests', transform: 'join', item: 'address' }, guests, exec);
    applyMapping({ field: 'guest_domains', transform: 'join_domains', item: 'address' }, guests, exec);
    expect(exec).toEqual({ guests: 'a@one.example,b@two.example', guest_domains: 'one.example,two.example' });
  });

  it('no declared `item`: an object is never guessed into a value (fail-closed)', () => {
    const exec: Record<string, string | number> = {};
    applyMapping({ field: 'guests', transform: 'join' }, [{ email: 'a@one.example' }], exec);
    expect(exec.guests).toBe('[object Object]');
  });

  it('plain string items are unchanged', () => {
    const exec: Record<string, string | number> = {};
    applyMapping({ field: 'to', transform: 'join', item: 'address' }, ['a@x.example', 'b@y.example'], exec);
    expect(exec.to).toBe('a@x.example,b@y.example');
  });
});

describe("the ticket request's amount: the field the profile's cumulative_sum bound reads", () => {
  const purchase = {
    boundsSchema: {
      keyOrder: ['spend_max', 'spend_daily_max'],
      fields: {
        spend_max: { boundType: { kind: 'per_transaction', of: 'spend' } },
        spend_daily_max: { boundType: { kind: 'cumulative_sum', of: 'spend', window: 'daily' } },
      },
    },
  };

  it('a made-up profile summing `spend`: the amount is the spend', () => {
    expect(cumulativeSumValue(purchase, { spend: 42, amount: 7 })).toBe(42);
  });

  it('a profile that sums nothing sends no amount, even with a field called "amount"', () => {
    expect(cumulativeSumValue({ boundsSchema: { fields: { n: { boundType: { kind: 'cumulative_count' } } } } }, { amount: 5 })).toBeUndefined();
    expect(cumulativeSumValue(undefined, { amount: 5 })).toBeUndefined();
  });

  it('several sum bounds: the first in keyOrder wins (the spec\'s rule)', () => {
    const two = { boundsSchema: { keyOrder: ['b_sum', 'a_sum'], fields: {
      a_sum: { boundType: { kind: 'cumulative_sum', of: 'a' } },
      b_sum: { boundType: { kind: 'cumulative_sum', of: 'b' } },
    } } };
    expect(cumulativeSumValue(two, { a: 1, b: 2 })).toBe(2);
  });
});

describe("a built-in's read gate: the read switch its own profile declares", () => {
  const catalog = (profiles: Record<string, unknown>) => ({
    ids: () => Object.keys(profiles),
    get: (id: string) => profiles[id] as { boundsSchema?: unknown } | undefined,
  });

  it('a made-up switch name is the gate, for every version; other enum bounds are not read switches', () => {
    const v1 = { boundsSchema: { fields: {
      evidence_view: enumSwitch(['unlimited', 'none']),
      purge: enumSwitch(['own', 'none']),
      n: { boundType: { kind: 'cumulative_count' } },
    } } };
    const gate = readSwitchGate('ledger', catalog({ 'x/ledger@0.1': v1, 'x/ledger@0.2': v1, 'x/other@1': {} }));
    expect(gate).toEqual({ category: 'read', boundField: 'evidence_view', requiredValue: 'unlimited' });
  });

  it('fail-closed: unknown profile, no switch, or versions that disagree', () => {
    expect(() => readSwitchGate('ledger', catalog({}))).toThrow(/not in this gateway's profile catalog/);
    expect(() => readSwitchGate('ledger', catalog({ 'x/ledger@0.1': { boundsSchema: { fields: {} } } }))).toThrow(/0 read switches/);
    expect(() => readSwitchGate('ledger', catalog({
      'x/ledger@0.1': { boundsSchema: { fields: { a_view: enumSwitch(['unlimited', 'none']) } } },
      'x/ledger@0.2': { boundsSchema: { fields: { b_view: enumSwitch(['unlimited', 'none']) } } },
    }))).toThrow(/different read switches/);
  });

  it('the Report and Setup built-ins gate their reads on whatever switch their profiles name', () => {
    // Made-up versions of their profiles, with a switch that is not called read_access.
    registerProfile('example.test/reporting@9.0', {
      id: 'example.test/reporting@9.0', version: '9.0',
      boundsSchema: { fields: { evidence_view: enumSwitch(['unlimited', 'none']) } },
    } as never);
    registerProfile('example.test/delegation@9.0', {
      id: 'example.test/delegation@9.0', version: '9.0',
      boundsSchema: { fields: { guide_view: enumSwitch(['unlimited', 'none']) } },
    } as never);
    const deps = { state: {} as SharedState, integrationManager: new IntegrationManager(), reportSources: {} as ReportSources };
    const report = reportBuiltin(deps).toolGating as unknown as { overrides: Record<string, { boundField?: string; requiredValue?: string }> };
    for (const tool of ['list_tickets', 'get_ticket', 'list_cases', 'get_records']) {
      expect(report.overrides[tool]).toMatchObject({ boundField: 'evidence_view', requiredValue: 'unlimited' });
    }
    const setup = setupBuiltin(deps).toolGating as unknown as { overrides: Record<string, { boundField?: string; requiredValue?: string }> };
    expect(setup.overrides.get_guide).toMatchObject({ boundField: 'guide_view', requiredValue: 'unlimited' });
  });
});
