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
 * only. `paused` entries never reach here (see `buildPausedSummaries` for their
 * one calm line instead); `starting` entries are handled separately by the
 * caller, same as before.
 */
/**
 * A real connector can never run while simulation mode is on — it is paused
 * by design, so it is never something to fix: not in "Needs your attention",
 * not in the Integrations badge. "Real" here means either no manifest
 * `simulation` marker at all, OR a connector that declares one but is
 * CURRENTLY SET to a real mode (ERP's mode=live) — the backend's `paused`
 * field already encodes this (see simulation-mode.ts's
 * `connectorCurrentlySimulated`, the SAME current-mode check the gateway's
 * own start/call-time gates use), so reading it here keeps this rule from
 * drifting out of step with enforcement the way `declaresSimulation` alone
 * once did.
 */
export function blockedBySimulation(e: IntegrationEntry, simulationOn: boolean): boolean {
  // A connector that touches only this computer (manifest `localOnly`, e.g.
  // Files) is no real system: the gateway runs it in simulation mode too.
  if (e.manifest.localOnly === true) return false;
  return simulationOn && (!declaresSimulation(e.manifest) || e.integration?.paused === 'simulation');
}

export function buildIntegrationAttentionItems(entries: IntegrationEntry[], simulationOn = false): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const e of entries) {
    if (blockedBySimulation(e, simulationOn)) continue;
    if (e.state === 'running' && (e.integration?.problem || e.integration?.error)) {
      // Running is not the same as working: the connector's own status check
      // said why it cannot (its words), or the gateway got no answer from it.
      items.push({
        label: `${e.manifest.name} needs attention`,
        detail: e.integration.problem ?? e.integration.error!,
        to: '/integrations',
        color: 'var(--text-primary)',
      });
    } else if (e.state === 'error') {
      items.push({
        label: 'Integration error',
        detail: e.integration?.error
          ? `${e.manifest.name}: ${e.integration.error}${e.integration.problem ? ` It said: ${e.integration.problem}` : ''}`
          : `${e.manifest.name} is not running`,
        to: '/integrations',
        color: 'var(--text-primary)',
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
          color: 'var(--text-primary)',
        });
      } else {
        items.push({
          label: 'Integration stopped',
          detail: `${e.manifest.name} is not running`,
          to: '/integrations',
          color: 'var(--text-primary)',
        });
      }
    }
  }

  return items;
}

/** Which way the gateway is holding a connector back: the two cases need different sentences. */
export type PausedReason = 'simulation' | 'production';

/** The calm summary line's data — count + names, for one reason. The sentence itself (incl.
 *  singular/plural wording and bolding) is assembled in the component so the
 *  pure, tested part stays the facts rather than the markup. */
export interface PausedSummary {
  reason: PausedReason;
  count: number;
  namesText: string;
}

/**
 * The connectors the gateway holds back, one summary per reason; empty when
 * none are. `simulation` = real systems paused because simulation mode is on;
 * `production` = connectors set to simulation on a gateway running for real.
 */
export function buildPausedSummaries(entries: IntegrationEntry[]): PausedSummary[] {
  const byReason = (reason: PausedReason) => entries.filter(e => e.state === 'paused' && (e.integration?.paused ?? 'simulation') === reason);
  return (['simulation', 'production'] as const).flatMap((reason) => {
    const paused = byReason(reason);
    return paused.length === 0 ? [] : [{ reason, count: paused.length, namesText: paused.map(e => e.manifest.name).join(', ') }];
  });
}
