/**
 * The built-ins' names and action labels reach the UI (via /internal/manifests
 * `builtins`) so a report ticket reads "Report written" under "Report", not
 * the fallback "Reporting · report" under "REPORT".
 */
import { describe, it, expect } from 'vitest';
import { IntegrationManager } from '../src/lib/integration-manager';
import { reportBuiltin } from '../src/lib/builtins/report';
import { setupBuiltin } from '../src/lib/builtins/setup';
import type { SharedState } from '../src/lib/shared-state';
import type { ReportSources } from '../src/lib/report';

describe('getBuiltinLabels', () => {
  it('names and action labels only — never tools, profiles or gating', () => {
    const im = new IntegrationManager();
    const deps = { state: {} as SharedState, integrationManager: im, reportSources: {} as ReportSources };
    im.registerBuiltin(reportBuiltin(deps));
    im.registerBuiltin(setupBuiltin(deps));
    const labels = im.getBuiltinLabels();
    const report = labels.find((l) => l.id === 'report');
    expect(report).toMatchObject({ name: 'Report', toolGating: { overrides: { write_report: { actionLabel: 'Report written' } } } });
    const setup = labels.find((l) => l.id === 'setup');
    expect(setup?.toolGating.overrides.create_mandate).toEqual({ actionLabel: 'Mandate proposed' });
    // Only labels travel: no executionMapping, no read gates.
    expect(JSON.stringify(labels)).not.toMatch(/executionMapping|staticExecution|category/);
  });
});
