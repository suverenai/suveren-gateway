import { describe, it, expect, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { useSimulationMode, noteSimulation, resetSimulationSeenForTests } from './useSimulationMode';
import { SimulationBanner } from '../components/SimulationBanner';

function Probe() {
  const s = useSimulationMode();
  return <span>{`sim=${String(s)}`}</span>;
}

describe('useSimulationMode: a new mount starts from what this page was last told (DEC-100: the frame does not move)', () => {
  beforeEach(() => resetSimulationSeenForTests());
  it('nothing seen yet: unknown, and no banner', () => {
    expect(renderToString(<Probe />)).toContain('sim=null');
    expect(renderToString(<SimulationBanner />)).not.toContain('simulation-banner');
  });
  it('after an answer "on": the next mount has the banner from its first render', () => {
    noteSimulation(true);
    expect(renderToString(<Probe />)).toContain('sim=true');
    expect(renderToString(<SimulationBanner />)).toContain('simulation-banner');
  });
  it('after an answer "off": no banner from the first render', () => {
    noteSimulation(false);
    expect(renderToString(<SimulationBanner />)).not.toContain('simulation-banner');
  });
});
