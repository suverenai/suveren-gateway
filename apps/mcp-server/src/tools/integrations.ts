/**
 * list-integrations tool — compact overview of all running integrations
 * and their authorization status.
 *
 * Always callable, no parameters. Returns minimal context so the agent
 * knows what's available without bloating the conversation.
 */

import type { SharedState } from '../lib/shared-state';
import { lockedNotice } from '../lib/locked-notice';
import type { IntegrationManager } from '../lib/integration-manager';
import { profileMatches } from '../lib/tool-proxy';

/** Extract short profile name from full ID */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  const parts = withoutVersion.split('/');
  return parts[parts.length - 1];
}

export function listIntegrationsHandler(
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
) {
  return async () => {
    if (!state.spClient.isUnlocked()) {
      return { content: [{ type: 'text' as const, text: lockedNotice('list integrations', state.spClient.getLockReason() ?? 'restart') }] };
    }
    if (!integrationManager) {
      return { content: [{ type: 'text' as const, text: 'No integration manager available.' }] };
    }

    const auths = state.getEnrichedAuthorizations();
    const statuses = integrationManager.getStatus();

    // A connector may span several areas (area per tool — an override may
    // name its own `profile`). List it once PER distinct profile its tools
    // resolve to, not just the first tool's — otherwise a connector serving
    // e.g. both "sales" and "invoicing" would only ever be shown under
    // whichever area happened to be its FIRST discovered tool.
    type Row = { id: string; profile: string | null; status: string };
    const integrations: Row[] = statuses
      .filter(s => s.running)
      .flatMap((s): Row[] => {
        const tools = integrationManager.getAllTools().filter(t => t.integrationId === s.id);
        const profiles = [...new Set(tools.map(t => t.gating?.profile).filter((p): p is string => !!p))];

        if (profiles.length === 0) {
          return [{ id: s.id, profile: null, status: 'no authorization' }];
        }

        return profiles.map(profile => {
          // Count active authorizations matching this profile
          const matchingAuths = auths.filter(a => a.complete && profileMatches(a.profileId, profile));

          // Determine status
          let status: string;
          if (matchingAuths.length > 0) {
            // Find soonest expiry
            const soonestExpiry = Math.min(
              ...matchingAuths.flatMap(a =>
                a.attestations.map(att => att.expiresAt)
              ),
            );
            const remainingMs = soonestExpiry * 1000 - Date.now();
            const remainingMin = Math.ceil(remainingMs / 60000);
            status = `authorized (${matchingAuths.length} path${matchingAuths.length > 1 ? 's' : ''}, ${remainingMin} min remaining)`;
          } else {
            // Check if there are expired auths
            const allProfileAuths = auths.filter(a => profileMatches(a.profileId, profile));
            status = allProfileAuths.length > 0 ? 'expired' : 'no authorization';
          }

          return { id: s.id, profile: shortProfileName(profile), status };
        });
      });

    const text = integrations.length === 0
      ? 'No integrations running.'
      : integrations.map(i =>
          `${i.id} [${i.profile ?? 'ungated'}] — ${i.status}`
        ).join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  };
}
