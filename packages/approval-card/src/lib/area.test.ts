import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveAreaName, areaIcon, showMandateLine, parseAreaFilter, matchesAreaFilter, registerConnectorAreaIcons,
  AREA_ICON_BY_MANIFEST_ICON, type AreaCatalogEntry, type ManifestIconEntry,
} from './area';

describe('resolveAreaName — UI spec §13.1', () => {
  it('uses the newest version\'s own name, numeric compare (0.10 > 0.9)', () => {
    const catalog: AreaCatalogEntry[] = [
      { id: 'x/customers@0.4', name: 'Customer Management' },
      { id: 'x/customers@0.9', name: 'Customer Management' },
      { id: 'x/customers@0.10', name: 'Customers' },
    ];
    // A mandate signed under an OLD version still reads under the current name.
    expect(resolveAreaName('x/customers@0.4', catalog)).toBe('Customers');
    expect(resolveAreaName('x/customers@0.10', catalog)).toBe('Customers');
  });

  it('plain lexicographic compare would get 0.10 vs 0.9 wrong — numeric compare does not', () => {
    const catalog: AreaCatalogEntry[] = [
      { id: 'x/deploy@0.9', name: 'Deploy' },
      { id: 'x/deploy@0.10', name: 'Deploy' },
      { id: 'x/deploy@0.12', name: 'Deployments' },
    ];
    expect(resolveAreaName('x/deploy@0.9', catalog)).toBe('Deployments');
  });

  it('unknown profile family (none in the catalog) falls back to the capitalised short id', () => {
    expect(resolveAreaName('x/widgets@0.1', [])).toBe('Widgets');
    const catalog: AreaCatalogEntry[] = [{ id: 'x/customers@0.10', name: 'Customers' }];
    expect(resolveAreaName('x/widgets@0.1', catalog)).toBe('Widgets');
  });

  it('a known family with no `name` on its newest version falls back the same way', () => {
    const catalog: AreaCatalogEntry[] = [{ id: 'x/charge@0.6' }];
    expect(resolveAreaName('x/charge@0.3', catalog)).toBe('Charge');
  });
});

describe('areaIcon — UI spec §13.1 (from the profile id only, never a profile field)', () => {
  it('maps every known short id to its area icon', () => {
    expect(areaIcon('x/customers@0.5')).toBe('customers');
    expect(areaIcon('x/email@0.1')).toBe('email');
    expect(areaIcon('x/charge@0.6')).toBe('payments');
    expect(areaIcon('x/sales@0.2')).toBe('sales');
    expect(areaIcon('x/calendar@0.4')).toBe('calendar');
    expect(areaIcon('github.com/humanagencyprotocol/hap-profiles/master-data@0.1')).toBe('masterData');
    expect(areaIcon('x/records@0.5')).toBe('records');
    expect(areaIcon('x/publish@0.7')).toBe('publishing');
    expect(areaIcon('x/deploy@0.12')).toBe('deployments');
    expect(areaIcon('x/purchase@0.8')).toBe('purchasing');
    expect(areaIcon('x/reporting@0.4')).toBe('reports');
    expect(areaIcon('x/delegation@0.5')).toBe('setup');
    expect(areaIcon('x/invoicing@0.1')).toBe('invoicing');
  });

  it('an unknown short id gets the neutral icon', () => {
    expect(areaIcon('x/widgets@0.1')).toBe('unknown');
  });
});

describe('showMandateLine — UI spec §13.2', () => {
  it('hides when there is no title', () => {
    expect(showMandateLine(undefined, 'Customers')).toBe(false);
    expect(showMandateLine(null, 'Customers')).toBe(false);
    expect(showMandateLine('   ', 'Customers')).toBe(false);
  });

  it('hides when the title only repeats the area (case-insensitive)', () => {
    expect(showMandateLine('Customers', 'Customers')).toBe(false);
    expect(showMandateLine('customers', 'Customers')).toBe(false);
    expect(showMandateLine('  Customers  ', 'Customers')).toBe(false);
  });

  it('shows for any other title', () => {
    expect(showMandateLine('Customer care', 'Customers')).toBe(true);
  });
});

describe('area filter param — UI spec §13.3', () => {
  it('parses an area short id; no/empty param means "All"', () => {
    expect(parseAreaFilter('customers')).toBe('customers');
    expect(parseAreaFilter(null)).toBe(null);
    expect(parseAreaFilter(undefined)).toBe(null);
    expect(parseAreaFilter('')).toBe(null);
    expect(parseAreaFilter('  ')).toBe(null);
  });

  it('matches a profile id against the filter; null (All) matches everything', () => {
    expect(matchesAreaFilter('x/customers@0.10', 'customers')).toBe(true);
    expect(matchesAreaFilter('x/email@0.3', 'customers')).toBe(false);
    expect(matchesAreaFilter('x/email@0.3', null)).toBe(true);
  });
});

describe('areaIcon — from the serving connector\'s manifest (Andreas, 2026-11-11)', () => {
  // The gateway's shipped manifests, as the UI receives them from /mcp/integrations/manifests.
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { integrations: Record<string, string> };
  const shipped = Object.values(index.integrations).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ManifestIconEntry);

  afterEach(() => registerConnectorAreaIcons([]));

  it('Files has no icon without its manifest (the old fixed map), and its own icon with it', () => {
    expect(areaIcon('x/files@0.1')).toBe('unknown');
    registerConnectorAreaIcons(shipped);
    expect(areaIcon('x/files@0.1')).toBe('files');
  });

  it('every shipped manifest declares an icon the UI draws', () => {
    for (const m of shipped) {
      expect(m.icon, `${m.id} declares no icon`).toBeTruthy();
      expect(AREA_ICON_BY_MANIFEST_ICON[m.icon!], `${m.id}: manifest icon "${m.icon}" has no UI drawing`).toBeDefined();
    }
  });

  it('no area that already had an icon changes look: the connector\'s icon is the one it had', () => {
    const before = new Map(shipped.map(m => [m.profile!, areaIcon(`x/${m.profile}@1`)]));
    registerConnectorAreaIcons(shipped);
    for (const m of shipped) {
      const was = before.get(m.profile!);
      if (was !== 'unknown') expect(areaIcon(`x/${m.profile}@1`), m.id).toBe(was);
    }
  });

  it('a new connector\'s area takes its declared icon, generic', () => {
    registerConnectorAreaIcons([{ id: 'acme-mail', profile: 'github.com/acme/hap-profiles/claims@0.1', icon: 'mail' }]);
    expect(areaIcon('github.com/acme/hap-profiles/claims@0.3')).toBe('email');
  });

  it('an area no connector declares keeps the fallback: built-ins, per-tool-override areas, unknown icons', () => {
    registerConnectorAreaIcons([...shipped, { id: 'odd', profile: 'odd', icon: 'rocket' }]);
    expect(areaIcon('x/reporting@0.1')).toBe('reports');
    expect(areaIcon('x/delegation@0.2')).toBe('setup');
    // ERP declares briefcase for sales; its invoicing tools (a per-tool override) keep the invoicing icon.
    expect(areaIcon('x/invoicing@0.1')).toBe('invoicing');
    expect(areaIcon('x/master-data@0.1')).toBe('masterData');
    expect(areaIcon('x/odd@0.1')).toBe('unknown');
  });

  it('two connectors for one area: the alphabetically first id wins, whatever the order', () => {
    const a = { id: 'a-mail', profile: 'email', icon: 'mail' };
    const b = { id: 'b-mail', profile: 'email', icon: 'users' };
    registerConnectorAreaIcons([b, a]);
    expect(areaIcon('x/email@0.1')).toBe('email');
    registerConnectorAreaIcons([a, b]);
    expect(areaIcon('x/email@0.1')).toBe('email');
  });
});
