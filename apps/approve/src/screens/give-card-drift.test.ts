/**
 * Drift guard (maintainer 2026-11-26, "one UI for all devices"): the phone draws a mandate to give through the SAME component as the
 * gateway's approval card (approval-card MandateProposalCard), and writes no markup of its own for the mandate. This fails when the
 * phone grows its own copy again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(src, rel), 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
});

describe('the phone\'s mandate card is the shared one', () => {
  it('the give screen imports the shared card and renders the body through it', () => {
    const mandates = read('screens/Mandates.tsx');
    expect(mandates).toMatch(/from '@suveren\/approval-card\/components\/MandateProposalCard'/);
    expect(mandates).toMatch(/<MandateProposalBody\b/);
    expect(mandates).toMatch(/<CommitmentBand\b/);
  });

  it('no phone file draws the mandate\'s own blocks: the sealed tile, its intent, its limit and scope rows', () => {
    const own = walk(src).filter((f) => !f.endsWith('scripts/mockup.tsx'));
    for (const f of own) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} draws the sealed tile itself`).not.toMatch(/className="av3-sealed\b/);
      expect(text, `${f} draws the intent block itself`).not.toMatch(/className="av3-intent\b/);
      expect(text, `${f} draws limit rows itself`).not.toMatch(/data-testid="give-(limits|scope)"/);
    }
  });

  it('the old own markup (info blocks for limits, scope, how long) is gone from the give body', () => {
    const body = read('screens/Mandates.tsx').split('function GiveBody')[1]?.split('export function GiveCard')[0] ?? '';
    expect(body).not.toMatch(/info-kv|P\.giveLimits|P\.giveScope|P\.giveHowLong|P\.giveLasts/);
  });
});
