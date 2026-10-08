/**
 * Dashboard "Needs your attention" logic for integrations — pulled out of
 * DashboardPage.tsx so it can be unit-tested directly (JSX itself is verified
 * in the browser; see doc/engineering.md).
 *
 * The core fix this encodes: a real system paused by simulation mode is NOT
 * an attention item. Before this, integration-manager reported the block as
 * `error`, so every blocked real connector (Gmail, Calendar, Mollie,
 * LinkedIn, Records, Deploy — six on a typical setup) showed up here as
 * "Integration error … blocked", drowning any genuine problem.
 */
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { declaresSimulation } from './simulation';

export interface AttentionItem {
  label: string;
  detail: string;
  to: string;
  color: string;
}

/**
 * Attention rows contributed by integration state — error and not-running
 * only. `paused` entries never reach here (see `buildPausedSummary` for their
 * one calm line instead); `starting` entries are handled separately by the
 * caller, same as before.
 */
/**
 * A real connector (no manifest `simulation` marker) can never run while
 * simulation mode is on — it is paused by design, so it is never something
 * to fix: not in "Needs your attention", not in the Integrations badge.
 */
export function blockedBySimulation(e: IntegrationEntry, simulationOn: boolean): boolean {
  return simulationOn && !declaresSimulation(e.manifest);
}

export function buildIntegrationAttentionItems(entries: IntegrationEntry[], simulationOn = false): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const e of entries) {
    if (blockedBySimulation(e, simulationOn)) continue;
    if (e.state === 'error') {
      items.push({
        label: 'Integration error',
        detail: e.integration?.error
          ? `${e.manifest.name}: ${e.integration.error}`
          : `${e.manifest.name} is not running`,
        to: '/integrations',
        color: 'var(--danger)',
      });
    } else if (e.state === 'not-running') {
      // A test system (declares `simulation`) that was simply never
      // activated gets a generic, helpful nudge — not a scary "stopped"
      // label, and not email-specific wording for a connector that isn't
      // email. Any other real connector keeps the original generic phrasing.
      if (declaresSimulation(e.manifest)) {
        items.push({
          label: `${e.manifest.name} is not running`,
          detail: 'Activate it to use it in the test.',
          to: '/integrations',
          color: 'var(--danger)',
        });
      } else {
        items.push({
          label: 'Integration stopped',
          detail: `${e.manifest.name} is not running`,
          to: '/integrations',
          color: 'var(--danger)',
        });
      }
    }
  }

  return items;
}

/** The calm summary line's data — count + names. The sentence itself (incl.
 *  singular/plural wording and bolding) is assembled in the component so the
 *  pure, tested part stays the facts rather than the markup. */
export interface PausedSummary {
  count: number;
  namesText: string;
}

/**
 * Summarizes real systems paused by simulation mode, or null when none are
 * paused — the caller renders nothing in that case rather than an empty box.
 */
export function buildPausedSummary(entries: IntegrationEntry[]): PausedSummary | null {
  const paused = entries.filter(e => e.state === 'paused');
  if (paused.length === 0) return null;
  return {
    count: paused.length,
    namesText: paused.map(e => e.manifest.name).join(', '),
  };
}
