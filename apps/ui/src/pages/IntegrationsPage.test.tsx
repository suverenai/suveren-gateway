import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ConnectorCards } from './IntegrationsPage';
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';

// A multi-area connector shaped like content/integrations/erp.json: manifest area `sales`, tool-level
// areas `invoicing` and `master-data`. The bug: it was drawn once per area.
function entry(id: string, name: string, profile: string, overrideProfiles: string[] = []): IntegrationEntry {
  return {
    id,
    state: 'running',
    manifest: {
      id, name, profile, credentials: { fields: [] }, simulation: null,
      toolGating: { overrides: Object.fromEntries(overrideProfiles.map((p, i) => [`t${i}`, { profile: p }])) },
    } as unknown as IntegrationEntry['manifest'],
    integration: { id, name, running: true, toolCount: 3 } as unknown as IntegrationEntry['integration'],
  };
}

describe('ConnectorCards — one card per connector', () => {
  const entries = [
    entry('a', 'Alpha', 'sales', ['invoicing', 'master-data']),
    entry('b', 'Beta', 'records'),
  ];
  const html = renderToStaticMarkup(
    <MemoryRouter><ConnectorCards entries={entries} catalog={[]} refresh={() => {}} onSuccess={() => {}} /></MemoryRouter>,
  );

  it('draws a multi-area connector once, not once per area', () => {
    expect(html.match(/class="card-title ob-title"/g)).toHaveLength(2);
    expect(html.match(/>Alpha</g)).toHaveLength(1);
  });

  it('shows every area of the connector as a chip, and only its own', () => {
    const alpha = html.slice(0, html.indexOf('Beta'));
    expect(alpha.match(/class="int-area"/g)).toHaveLength(3);
    for (const a of ['sales', 'invoicing', 'master-data']) expect(alpha).toContain(`data-area="${a}"`);
    expect(html.match(/class="int-area"/g)).toHaveLength(4);
  });

  it('shows the Live pill for a connector that is not simulated', () => {
    expect(html.match(/>Live</g)).toHaveLength(2);
  });
});
