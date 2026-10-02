import { describe, it, expect } from 'vitest';
import { buildIntegrationAttentionItems, buildPausedSummary } from './integration-attention';
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';

/**
 * The core fix under test: a real system paused by simulation mode must NOT
 * become a "Needs your attention" row (the pre-fix bug — six blocked real
 * connectors all showed up as "Integration error … blocked"), while a GENUINE
 * error must still surface exactly as before.
 */
function entry(o: {
  id?: string;
  name?: string;
  simulation?: unknown;
  state: IntegrationEntry['state'];
  error?: string;
}): IntegrationEntry {
  return {
    id: o.id ?? o.name ?? 'conn',
    manifest: { id: o.id ?? 'conn', name: o.name ?? 'Connector', simulation: o.simulation ?? null } as unknown as IntegrationEntry['manifest'],
    integration: o.error ? ({ id: o.id ?? 'conn', name: o.name ?? 'Connector', running: false, toolCount: 0, error: o.error } as unknown as IntegrationEntry['integration']) : undefined,
    state: o.state,
  };
}

describe('buildIntegrationAttentionItems', () => {
  it('excludes paused entries entirely — paused-by-design is not an attention item', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'Gmail', state: 'paused' }),
      entry({ name: 'Mollie', state: 'paused' }),
    ]);
    expect(items).toEqual([]);
  });

  it('keeps a genuine error, with the real message', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'Mollie', state: 'error', error: 'ENOENT: spawn failed' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Integration error');
    expect(items[0].detail).toBe('Mollie: ENOENT: spawn failed');
    expect(items[0].color).toBe('var(--danger)');
  });

  it('a real connector that is simply not-running (unrelated to simulation) keeps the original generic wording', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'Records', state: 'not-running' }),
    ]);
    expect(items).toEqual([{
      label: 'Integration stopped',
      detail: 'Records is not running',
      to: '/integrations',
      color: 'var(--danger)',
    }]);
  });

  it('a test system that was never activated gets generic, helpful wording — not email-specific', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'Email (simulation)', simulation: { field: 'mode', default: 'simulation' }, state: 'not-running' }),
    ]);
    expect(items).toEqual([{
      label: 'Email (simulation) is not running',
      detail: 'Activate it to use it in the test.',
      to: '/integrations',
      color: 'var(--danger)',
    }]);
  });

  it('running and starting contribute nothing', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'ERP', state: 'running' }),
      entry({ name: 'CRM', state: 'starting' }),
    ]);
    expect(items).toEqual([]);
  });

  it('mixed set: paused is dropped, error and not-running both survive', () => {
    const items = buildIntegrationAttentionItems([
      entry({ name: 'Gmail', state: 'paused' }),
      entry({ name: 'Mollie', state: 'error', error: 'crashed' }),
      entry({ name: 'Records', state: 'not-running' }),
    ]);
    expect(items.map(i => i.label)).toEqual(['Integration error', 'Integration stopped']);
  });
});

describe('buildPausedSummary', () => {
  it('null when nothing is paused — caller renders nothing, not an empty box', () => {
    expect(buildPausedSummary([entry({ name: 'ERP', state: 'running' })])).toBeNull();
    expect(buildPausedSummary([])).toBeNull();
  });

  it('singular count for exactly one paused system', () => {
    const summary = buildPausedSummary([entry({ name: 'Gmail', state: 'paused' })]);
    expect(summary).toEqual({ count: 1, namesText: 'Gmail' });
  });

  it('plural count and a comma-joined name list, in entry order', () => {
    const summary = buildPausedSummary([
      entry({ name: 'Gmail', state: 'paused' }),
      entry({ name: 'Google Calendar', state: 'paused' }),
      entry({ name: 'Mollie', state: 'paused' }),
    ]);
    expect(summary).toEqual({ count: 3, namesText: 'Gmail, Google Calendar, Mollie' });
  });

  it('ignores non-paused entries when building the list', () => {
    const summary = buildPausedSummary([
      entry({ name: 'Gmail', state: 'paused' }),
      entry({ name: 'ERP', state: 'running' }),
      entry({ name: 'Mollie', state: 'error', error: 'x' }),
    ]);
    expect(summary).toEqual({ count: 1, namesText: 'Gmail' });
  });
});
